/**
 * The NEAR rail as members see it: link an account, ask for a transfer, and
 * prove one landed.
 *
 * Requesting is the fronter's action, exactly like
 * `/bills/:id/request-payments` — the person collecting decides when to ask.
 * Settling is the payer's action, and the server only accepts a transfer it can
 * verify on chain.
 */

import type { FastifyPluginAsync } from 'fastify';

import { isUniqueViolation, query } from '../db/pool.js';
import {
    isFronter,
    requireAgreementMember,
    requireBillMember,
    requireFronter,
    requireShareMember
} from '../lib/access.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import { assertSharePayer, requestTransferForShare, settleShareFromNear } from '../lib/near-settlement.js';
import {
    ANCHOR_METHOD,
    formatTokenUnits,
    ftBalanceOf,
    isNearAccountId,
    parseTokenUnits,
    prepareAnchorCall,
    prepareFtTransfer,
    prepareNativeTransfer,
    prepareRecordAcceptance,
    RECORD_ACCEPTANCE_METHOD
} from '../lib/near.js';
import { ensureSharePayLink } from '../lib/pay-links.js';
import { asRecord, pathUuid, requiredUuid } from '../lib/validate.js';
import { requireUser } from '../plugins/auth.js';

type ShareParams = { Params: { id: string } };

/**
 * Base58 of a 32-byte hash is 43 or 44 characters. This only screens out junk
 * before the RPC sees it; the node still rejects hashes that decode to the
 * wrong byte length, which `getTransferStatus` reports as "not found".
 */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export const nearRoutes: FastifyPluginAsync = async (app) => {
  /** What the client needs to decide whether to offer the NEAR button at all. */
  app.get('/near/status', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<{
      near_account: string | null;
      near_verified: boolean;
    }>(`select near_account, near_verified from users where id = $1`, [auth.userId]);

    const row = rows[0];

    return {
      configured: Boolean(config.near.usdcContract),
      network: config.near.network,
      tokenContract: config.near.usdcContract || null,
      agreementsContract: config.near.agreementsContract || null,
      explorerUrl: config.near.explorerUrl,
      account: row?.near_account ?? null,
      verified: row?.near_verified ?? false,
    };
  });

  /**
   * Link the account that pays and receives. Storing it is a claim, not a proof:
   * it becomes `verified` the first time a transfer signed by this account
   * settles a share, which is the only evidence the chain can give us.
   */
  app.patch('/near/account', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);
    const raw = body.nearAccount;

    const account =
      raw === undefined || raw === null || raw === ''
        ? null
        : typeof raw === 'string'
          ? raw.trim()
          : null;

    if (typeof raw === 'string' && account !== null && !isNearAccountId(account)) {
      throw ApiError.badRequest(
        'invalid_nearAccount',
        'That is not a NEAR account id (2–64 chars, or a 64-char implicit account)',
      );
    }

    try {
      await query(
        `update users
            set near_account = $2,
                near_verified = false,
                near_linked_at = case when $2::text is null then null else now() end
          where id = $1`,
        [auth.userId, account],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiError.conflict(
          'near_account_taken',
          'That NEAR account is already linked to another member',
        );
      }
      throw error;
    }

    return { account, verified: false };
  });

  /**
   * The unsigned transfer behind a one-tap payment. The wallet at
   * `wallet.meteorwallet.app` substitutes its own key and nonce, so all this
   * hands back is the instruction the popup will show: pay this account this
   * much USDC with this memo. The server still verifies the resulting hash, so
   * nothing here can move money on its own.
   */
  app.post('/near/ft-transfer', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);

    const receiverId = typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
    if (!isNearAccountId(receiverId)) {
      throw ApiError.badRequest('invalid_receiverId', 'receiverId must be a NEAR account id');
    }

    const amountText = typeof body.amount === 'string' ? body.amount.trim() : '';
    if (!/^\d+(\.\d+)?$/.test(amountText)) {
      throw ApiError.badRequest(
        'invalid_amount',
        'amount must be the token amount as a decimal string, e.g. "1.49"',
      );
    }

    const memo = typeof body.memo === 'string' ? body.memo.trim() : '';
    if (memo.length > 200) {
      throw ApiError.badRequest('invalid_memo', 'memo must be 200 characters or fewer');
    }

    // The signer is the member's own linked account: a transfer the wallet signs
    // as anybody else fails `verifyTransfer` with `near_tx_wrong_sender`.
    const { rows } = await query<{ near_account: string | null }>(
      `select near_account from users where id = $1`,
      [auth.userId],
    );
    const signerId = rows[0]?.near_account ?? null;
    if (!signerId) {
      throw ApiError.conflict(
        'member_near_missing',
        'Link your NEAR account before paying — the transfer has to be signed by you',
      );
    }

    // A payment started from a forwardable pay link names the share it means to
    // settle. Refuse a wallet that does not owe it now, while refusing is still
    // free, rather than verifying the transfer afterwards.
    if (body.shareId !== undefined) {
      await assertSharePayer(requiredUuid(body, 'shareId'), signerId);
    }

    const amount = parseTokenUnits(amountText);
    if (amount <= 0n) {
      throw ApiError.badRequest('invalid_amount', 'amount must be greater than zero');
    }

    // A wallet popup is a terrible place to learn you are short: it shows the
    // line items and a failing Call, not "your balance is zero". Read the
    // token balance first. A failed or unparseable read is not a reason to
    // block — the chain is still the judge — so it falls through to the wallet.
    const balance = await ftBalanceOf(signerId)
      .then((value) => BigInt(value))
      .catch(() => null);
    if (balance !== null && balance < amount) {
      throw ApiError.conflict(
        'near_insufficient_token_balance',
        `${signerId} holds ${formatTokenUnits(balance)} USDC on ${config.near.network}; `
          + `this transfer needs ${formatTokenUnits(amount)}. Top up ${signerId} with `
          + `${config.near.network} USDC, then try again.`,
      );
    }

    const prepared = await prepareFtTransfer({
      signerId,
      receiverId,
      amount,
      memo: memo || null,
    });

    return {
      transaction: prepared.transaction,
      signerId,
      receiverId,
      amount: formatTokenUnits(amount),
      memo: memo || null,
      blockHash: prepared.blockHash,
    };
  });

  /**
   * The unsigned native-NEAR sibling of `/near/ft-transfer`.
   *
   * `deposit` is yoctoNEAR, not a decimal string: the gift quote already froze
   * that exact integer, and re-parsing a rounded decimal here would make the
   * wallet sign a different number than `verifyNativeTransfer` checks.
   */
  app.post('/near/native-transfer', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);

    const receiverId = typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
    if (!isNearAccountId(receiverId)) {
      throw ApiError.badRequest('invalid_receiverId', 'receiverId must be a NEAR account id');
    }

    const depositText = typeof body.deposit === 'string' ? body.deposit.trim() : '';
    if (!/^\d+$/.test(depositText)) {
      throw ApiError.badRequest(
        'invalid_deposit',
        'deposit must be the yoctoNEAR amount as an integer string',
      );
    }
    const deposit = BigInt(depositText);
    if (deposit <= 0n) {
      throw ApiError.badRequest('invalid_deposit', 'deposit must be greater than zero');
    }

    const { rows } = await query<{ near_account: string | null }>(
      `select near_account from users where id = $1`,
      [auth.userId],
    );
    const signerId = rows[0]?.near_account ?? null;
    if (!signerId) {
      throw ApiError.conflict(
        'member_near_missing',
        'Link your NEAR account before giving — the transfer has to be signed by you',
      );
    }

    const prepared = await prepareNativeTransfer({ signerId, receiverId, deposit });

    return {
      transaction: prepared.transaction,
      signerId,
      receiverId,
      deposit: depositText,
      amount: formatTokenUnits(deposit, 24),
      blockHash: prepared.blockHash,
    };
  });

  /**
   * The unsigned call behind an on-chain anchor.
   *
   * Accepting terms is a NEP-413 signature: free, off-chain, invisible to an
   * explorer. The anchor makes the same act public — the fronter signs a
   * read-only `ft_balance_of({ "account_id": "<termsHash>" })` on the USDC
   * contract, which puts the digest in a permanent transaction without moving
   * anything or writing storage. A self-transfer cannot do this job: the token
   * contract refuses `ft_transfer` where sender and receiver are the same.
   */
  app.post('/near/anchor-call', async (request) => {
    const body = asRecord(request.body);
    const agreementId = requiredUuid(body, 'agreementId');
    const ctx = await requireAgreementMember(request, agreementId);
    requireFronter(ctx);

    if (!config.near.usdcContract) {
      throw ApiError.conflict(
        'near_not_configured',
        'NEAR is not configured on this server, so nothing can be anchored',
      );
    }

    const { rows: agreementRows } = await query<{ terms_hash: string | null }>(
      `select terms_hash from agreements where id = $1`,
      [agreementId],
    );
    const termsHash = agreementRows[0]?.terms_hash ?? null;
    if (!termsHash) {
      throw ApiError.conflict(
        'terms_missing',
        'These terms have no digest yet, so there is nothing to anchor',
      );
    }

    // Same signer the anchor route verifies against: a verified member account
    // wins over the user's own, because that is the identity the group sees.
    const { rows: accountRows } = await query<{ near_account: string | null }>(
      `select coalesce(
                case when u.near_verified then m.near_account end,
                case when u.near_verified then u.near_account end
              ) as near_account
         from members m
         join users u on u.id = m.user_id
        where m.id = $1`,
      [ctx.member.id],
    );
    const signerId = accountRows[0]?.near_account ?? null;
    if (!signerId) {
      throw ApiError.conflict(
        'near_account_missing',
        'Link and verify your NEAR account before anchoring these terms',
      );
    }

    const prepared = await prepareAnchorCall({ signerId, digest: termsHash });

    return {
      transaction: prepared.transaction,
      signerId,
      digest: termsHash,
      method: ANCHOR_METHOD,
      blockHash: prepared.blockHash,
    };
  });

  /**
   * The unsigned `record_acceptance` call on the shared registry contract.
   *
   * This is the stronger of the two proofs: the USDC anchor only publishes the
   * terms digest, while the registry writes a row per member. The contract
   * asserts `predecessor_account_id() == account_id`, so only the member whose
   * wallet produced the NEP-413 signature can record it — which is why this
   * route mints for the caller's own acceptance and never for a group-mate's.
   */
  app.post('/near/record-acceptance', async (request) => {
    const body = asRecord(request.body);
    const agreementId = requiredUuid(body, 'agreementId');
    const ctx = await requireAgreementMember(request, agreementId);

    if (!config.near.agreementsContract) {
      throw ApiError.conflict(
        'registry_not_configured',
        'The agreement registry contract is not configured on this server',
      );
    }

    const { rows: agreementRows } = await query<{ terms_hash: string | null }>(
      `select terms_hash from agreements where id = $1`,
      [agreementId],
    );
    const termsHash = agreementRows[0]?.terms_hash ?? null;
    if (!termsHash) {
      throw ApiError.conflict(
        'terms_missing',
        'These terms have no digest yet, so there is nothing to record',
      );
    }

    const { rows: acceptanceRows } = await query<{
      near_account: string | null;
      public_key: string | null;
      signature: string | null;
      nonce: string | null;
    }>(
      `select near_account, public_key, signature, nonce
         from agreement_acceptances
        where agreement_id = $1
          and member_id = $2
          and terms_hash = $3
          and signature is not null
          and anchor_tx_hash is null`,
      [agreementId, ctx.member.id, termsHash],
    );
    const acceptance = acceptanceRows[0];
    if (!acceptance?.near_account || !acceptance.public_key || !acceptance.signature || !acceptance.nonce) {
      throw ApiError.conflict(
        'nothing_to_record',
        'There is no unrecorded signature of yours on these terms',
      );
    }

    const { rows: accountRows } = await query<{ near_account: string | null }>(
      `select coalesce(
                case when u.near_verified then m.near_account end,
                case when u.near_verified then u.near_account end
              ) as near_account
         from members m
         join users u on u.id = m.user_id
        where m.id = $1`,
      [ctx.member.id],
    );
    const signerId = accountRows[0]?.near_account ?? null;
    if (!signerId) {
      throw ApiError.conflict(
        'near_account_missing',
        'Verify the NEAR account you signed with before recording on chain',
      );
    }
    if (signerId !== acceptance.near_account) {
      throw ApiError.conflict(
        'near_account_mismatch',
        `This signature came from ${acceptance.near_account}, so only that account can record it`,
      );
    }

    const prepared = await prepareRecordAcceptance({
      signerId,
      agreementId,
      termsHash,
      accountId: acceptance.near_account,
      publicKey: acceptance.public_key,
      signature: acceptance.signature,
      nonce: acceptance.nonce,
    });

    return {
      transaction: prepared.transaction,
      signerId,
      digest: termsHash,
      agreementId,
      method: RECORD_ACCEPTANCE_METHOD,
      registry: config.near.agreementsContract,
      blockHash: prepared.blockHash,
    };
  });

  /**
   * Mint the transfer instruction for one share. The fronter chases a member,
   * and the payer can also do it for themselves — a share that is owed but has
   * no recipient yet would otherwise have nothing to pay.
   */
  app.post<ShareParams>('/shares/:id/request-transfer', async (request) => {
    const shareId = pathUuid(request.params.id);

    const { rows } = await query<{
      bill_id: string;
      bill_status: string;
      member_id: string;
    }>(
      `select s.bill_id, s.member_id, b.status as bill_status
         from shares s
         join bills b on b.id = s.bill_id
        where s.id = $1`,
      [shareId],
    );

    const row = rows[0];
    if (!row) throw ApiError.notFound('Share not found');

    const ctx = await requireBillMember(request, row.bill_id);
    if (!isFronter(ctx) && row.member_id !== ctx.member.id) requireFronter(ctx);

    if (row.bill_status !== 'FINALIZED' && row.bill_status !== 'COLLECTING') {
      throw ApiError.conflict(
        'bill_not_finalized',
        'Finalize the bill before requesting payments',
      );
    }

    return requestTransferForShare({ shareId, actor: ctx.member.displayName });
  });

  /**
   * A forwardable link to this share's payment instructions. Sharing is the
   * same action as requesting, and requesting comes first on purpose: the quote
   * is frozen before the link exists, so whoever opens it sees exactly the
   * integer their wallet will be asked to sign.
   */
  app.post<ShareParams>('/shares/:id/pay-link', async (request) => {
    const shareId = pathUuid(request.params.id);

    const { rows } = await query<{
      bill_id: string;
      bill_status: string;
      member_id: string;
    }>(
      `select s.bill_id, s.member_id, b.status as bill_status
         from shares s
         join bills b on b.id = s.bill_id
        where s.id = $1`,
      [shareId],
    );

    const row = rows[0];
    if (!row) throw ApiError.notFound('Share not found');

    const ctx = await requireBillMember(request, row.bill_id);
    if (!isFronter(ctx) && row.member_id !== ctx.member.id) requireFronter(ctx);

    if (row.bill_status !== 'FINALIZED' && row.bill_status !== 'COLLECTING') {
      throw ApiError.conflict(
        'bill_not_finalized',
        'Finalize the bill before sharing a pay link',
      );
    }

    const transfer = await requestTransferForShare({
      shareId,
      actor: ctx.member.displayName,
    });
    const token = await ensureSharePayLink({ shareId, memberId: ctx.member.id });

    return { token, path: `/pay/${token}`, transfer };
  });

  /** Payer pastes the hash their wallet produced; the chain decides. */
  app.post<ShareParams>('/shares/:id/settle', async (request) => {
    const shareId = pathUuid(request.params.id);
    const ctx = await requireShareMember(request, shareId);
    const body = asRecord(request.body);
    const txHash = body.txHash;

    if (typeof txHash !== 'string' || !TX_HASH.test(txHash.trim())) {
      throw ApiError.badRequest(
        'invalid_txHash',
        'txHash must be the base58 hash of the NEP-141 transfer',
      );
    }

    return settleShareFromNear({
      shareId,
      txHash: txHash.trim(),
      actor: ctx.member.displayName,
    });
  });
};
