/**
 * The one collection path: the fronter's account is the payee, so money never
 * passes through the platform, and a fronter without a linked account blocks
 * collection instead of quietly collecting into ours. The member signs a
 * NEP-141 `ft_transfer`; the result is proven by a verified tx receipt, not a
 * webhook.
 */

import { query, withTransaction } from '../db/pool.js';
import { config } from './config.js';
import { ApiError } from './http-error.js';
import { recordEvent } from './ledger.js';
import {
    explorerTx,
    isNearAccountId,
    isNearConfigured,
    verifyTransfer
} from './near.js';
import { ensureQuote } from './settlement-quote.js';
import { settleShare, type SettleResult } from './settlement.js';

export type NearShareRow = {
  id: string;
  bill_id: string;
  agreement_id: string;
  group_id: string;
  member_id: string;
  amount: number;
  currency: string;
  status: string;
  bill_status: string;
  payer_user_id: string;
  payer_account: string | null;
  payee_account: string | null;
  quoted_chain_amount: string | null;
  quote_rate: string | null;
  quote_as_of: Date | null;
};

async function loadNearShare(shareId: string): Promise<NearShareRow> {
  const { rows } = await query<NearShareRow>(
    `select s.id, s.bill_id, b.agreement_id, a.group_id, s.member_id,
            s.amount, s.currency, s.status, b.status as bill_status,
            s.quoted_chain_amount, s.quote_rate, s.quote_as_of,
            pu.id as payer_user_id,
            -- Only a claimed wallet that NEP-413 proved (or a transfer signed
            -- from it) may receive or send money; an unverified claim is just
            -- a string anyone could have typed.
            coalesce(
              case when pu.near_verified then m.near_account end,
              case when pu.near_verified then pu.near_account end
            ) as payer_account,
            coalesce(
              case when fu.near_verified then fm.near_account end,
              case when fu.near_verified then fu.near_account end,
              a.treasury_account
            ) as payee_account
       from shares s
       join bills b on b.id = s.bill_id
       join agreements a on a.id = b.agreement_id
       join members m on m.id = s.member_id
       join users pu on pu.id = m.user_id
       left join members fm on fm.id = a.fronted_by
       left join users fu on fu.id = fm.user_id
      where s.id = $1`,
    [shareId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Share not found');
  return row;
}

/**
 * A forwardable pay link is opened by whoever holds it, but only the account
 * that owes the share can be credited for paying it. Check that before the
 * wallet is handed a transfer: once it is broadcast the money has moved, and a
 * mismatch can no longer be undone.
 */
export async function assertSharePayer(shareId: string, signerId: string): Promise<void> {
  const share = await loadNearShare(shareId);

  if (['paid', 'settled', 'refunded'].includes(share.status)) {
    throw ApiError.conflict('share_already_settled', 'This share is already settled');
  }

  // The payer account is not echoed back: a pay link is a bearer token, and its
  // holder has no business learning the debtor's wallet address.
  if (
    !share.payer_account ||
    share.payer_account.toLowerCase() !== signerId.toLowerCase()
  ) {
    throw new ApiError(
      403,
      'not_share_payer',
      'This pay link belongs to a different Globie account — sign in with the account that owes this share',
    );
  }
}

export type TransferRequest = {
  shareId: string;
  status: string;
  amount: number;
  currency: string;
  payTo: string;
  tokenContract: string;
  /** Amount in the token's decimals; this is what the wallet signs. */
  chainAmount: string;
  /** USD per one unit of `currency`, locked when this row was quoted. */
  quoteRate: number;
  /** When that rate was published. */
  quoteAsOf: string;
  /** Written on chain, so the receipt is self-identifying on an explorer. */
  memo: string;
  alreadyRequested: boolean;
};

/**
 * Ask a member to pay their share. Re-requesting is idempotent: the memo is the
 * share id, so the same transfer can be retried or resumed from the wallet
 * without producing a second, ambiguous payment.
 */
export async function requestTransferForShare(input: {
  shareId: string;
  actor: string;
}): Promise<TransferRequest> {
  if (!isNearConfigured()) {
    throw ApiError.conflict(
      'near_not_configured',
      'NEAR settlement is not configured on this server',
    );
  }

  const share = await loadNearShare(input.shareId);

  if (['paid', 'settled', 'refunded'].includes(share.status)) {
    throw ApiError.conflict(
      'share_already_settled',
      'This share is already settled',
    );
  }

  if (!share.payee_account || !isNearAccountId(share.payee_account)) {
    throw ApiError.conflict(
      'fronter_near_missing',
      'The fronter has not linked a NEAR account, so there is nowhere to send this share',
    );
  }

  if (!share.payer_account || !isNearAccountId(share.payer_account)) {
    throw ApiError.conflict(
      'member_near_missing',
      'Link a NEAR account before paying this share',
    );
  }

  if (share.payer_account.toLowerCase() === share.payee_account.toLowerCase()) {
    throw ApiError.conflict(
      'self_payment',
      'The paying member and the fronter are the same NEAR account',
    );
  }

  const alreadyRequested = share.status === 'requested';

  // The wallet signs USDC, so the number it shows has to come from the FX rate,
  // not from the ledger amount. Freezing it on the row means the same quote is
  // what `verifyTransfer()` will demand when the receipt comes back.
  const quote = await ensureQuote({
    table: 'shares',
    id: share.id,
    amountMinor: share.amount,
    currency: share.currency,
    stored: share,
  });

  if (!alreadyRequested) {
    await withTransaction(async (tx) => {
      await tx.query(
        `update shares
            set status = 'requested'
          where id = $1 and status in ('proposed', 'confirmed', 'failed')`,
        [share.id],
      );
      await recordEvent(tx, {
        groupId: share.group_id,
        agreementId: share.agreement_id,
        shareId: share.id,
        memberId: share.member_id,
        eventType: 'payment.requested',
        amountMinor: share.amount,
        currency: share.currency,
        actor: input.actor,
        summary: `Payment requested on NEAR — ${share.payee_account}`,
        metadata: { rail: 'near_transfer', pay_to: share.payee_account },
      });
    });
  }

  return {
    shareId: share.id,
    status: 'requested',
    amount: share.amount,
    currency: share.currency,
    payTo: share.payee_account,
    tokenContract: config.near.usdcContract,
    chainAmount: quote.amount,
    quoteRate: quote.rate,
    quoteAsOf: quote.asOf,
    memo: `globie:${share.id}`,
    alreadyRequested,
  };
}

export type NearSettleResult = SettleResult & {
  explorerUrl: string;
  amount: number;
  currency: string;
  payTo: string | null;
};

/**
 * Prove the transfer and settle. The verification in lib/near.ts is the only
 * way a share becomes paid on this rail; a wrong receiver, token or amount is
 * rejected with a 409 rather than silently moving the ledger.
 */
export async function settleShareFromNear(input: {
  shareId: string;
  txHash: string;
  actor: string;
}): Promise<NearSettleResult> {
  if (!isNearConfigured()) {
    throw ApiError.conflict(
      'near_not_configured',
      'NEAR settlement is not configured on this server',
    );
  }

  const share = await loadNearShare(input.shareId);

  if (['paid', 'settled'].includes(share.status)) {
    return {
      shareId: share.id,
      alreadyPaid: true,
      pointsAwarded: 0,
      rank: null,
      billSettled: share.bill_status === 'SETTLED',
      explorerUrl: explorerTx(input.txHash),
      amount: share.amount,
      currency: share.currency,
      payTo: share.payee_account,
    };
  }

  if (!share.payer_account) {
    throw ApiError.conflict(
      'member_near_missing',
      'Link a NEAR account before confirming this payment',
    );
  }
  if (!share.payee_account) {
    throw ApiError.conflict(
      'fronter_near_missing',
      'The fronter has no NEAR account to receive this share',
    );
  }

  // Verify against the frozen quote, never a freshly computed one: the rate may
  // have moved since the wallet opened, and the member signed what we showed.
  const quote = await ensureQuote({
    table: 'shares',
    id: share.id,
    amountMinor: share.amount,
    currency: share.currency,
    stored: share,
  });

  const transfer = await verifyTransfer({
    txHash: input.txHash,
    senderId: share.payer_account,
    expectedReceiver: share.payee_account,
    expectedChainAmount: quote.baseUnits,
  });

  const result = await settleShare({
    shareId: share.id,
    txHash: transfer.txHash,
    provider: 'near_transfer',
    payload: transfer,
    actor: input.actor,
  });

  // A transfer signed by this account is the only ownership proof the chain can
  // give us, so it is what flips the link from "claimed" to "verified".
  if (!result.alreadyPaid) {
    await query(
      `update users
          set near_verified = true,
              near_linked_at = coalesce(near_linked_at, now())
        where id = $1
          and near_account is not null
          and lower(near_account) = lower($2)`,
      [share.payer_user_id, share.payer_account],
    );
  }

  return {
    ...result,
    explorerUrl: transfer.explorerUrl,
    amount: share.amount,
    currency: share.currency,
    payTo: share.payee_account,
  };
}
