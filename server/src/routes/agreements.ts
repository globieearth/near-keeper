import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';

import { query, withTransaction } from '../db/pool.js';
import { requireAgreementMember, requireFronter, requireMember } from '../lib/access.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import { hashToken } from '../lib/ids.js';
import {
    allowsMultipleAgreements,
    CONSENT_LEVELS,
    GROUP_KINDS,
    INTEREST_MODES,
    RECURRENCES,
    SPLIT_MODES,
    SPLIT_VOTES
} from '../lib/kinds.js';
import { recordEvent } from '../lib/ledger.js';
import { verifySignedMessage, type Nep413SignedMessage } from '../lib/near-auth.js';
import { ANCHOR_METHOD, getTransferStatus, RECORD_ACCEPTANCE_METHOD } from '../lib/near.js';
import { mapAgreement, type AgreementRow } from '../lib/serialize.js';
import { castAgreementSplitVote, loadAgreementSplitSummary } from '../lib/split-vote.js';
import { consentMessage, termsHashOf } from '../lib/terms.js';
import {
    asRecord,
    currencyCode,
    enumValue,
    optionalBps,
    optionalDate,
    pathUuid,
    requiredMinor,
    requiredString,
    requiredUuid
} from '../lib/validate.js';

type AgreementParams = { Params: { id: string } };

type AgreementCounts = { accepted: number; total: number };

/** Base58 transaction hash, the same shape `/shares/:id/settle` accepts. */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * An anchor is a read-only `ft_balance_of({ "account_id": "<termsHash>" })` call
 * on the USDC contract: a public, permanent transaction the fronter signed,
 * carrying the terms digest as its argument. It moves nothing and writes no
 * storage — the token contract refuses `ft_transfer` to oneself, and paying a
 * counterparty would make the proof depend on someone else.
 */

async function loadAgreement(agreementId: string): Promise<AgreementRow> {
  const { rows } = await query<AgreementRow>(
    `select a.id, a.group_id, a.currency, a.estimated_total, a.deadline,
            a.status, a.created_by, a.fronted_by,
            a.kind, a.split_mode, a.recurrence, a.terms_hash, a.consent_level,
            a.interest_mode, a.interest_rate_bps, a.interest_cap_bps,
            (select count(*) from agreement_acceptances aa
              where aa.agreement_id = a.id) as accepted_count,
            (select count(*) from members m
              where m.group_id = a.group_id and m.status <> 'removed') as member_count
       from agreements a
      where a.id = $1`,
    [agreementId],
  );
  const agreement = rows[0];
  if (!agreement) throw ApiError.notFound('Agreement not found');
  return agreement;
}

/** The recipient string a wallet displays; the host the request arrived on. */
function recipientFor(host: string | undefined): string {
  return (host ?? 'localhost').split(':')[0]!.toLowerCase();
}

/** One period after `from`, so a cloned rent is due on the next rent day. */
function nextPeriod(from: Date, recurrence: string): Date {
  const next = new Date(from);
  if (recurrence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

type InterestRule = {
  mode: 'none' | 'monthly';
  rateBps: number | null;
  capBps: number | null;
};

/**
 * The late-fee rule as agreed. `none` is a stored, hashed choice, so the
 * snapshot can prove nobody was charged a fee the group never signed for.
 * `capBps` is a ceiling on the whole charge, not on a single month.
 */
function readInterestRule(body: Record<string, unknown>): InterestRule {
  const mode = enumValue(body, 'interestMode', INTEREST_MODES, 'none');
  const rateBps = optionalBps(body, 'interestRateBps');
  const capBps = optionalBps(body, 'interestCapBps');

  if (mode === 'none') {
    if (rateBps !== null) {
      throw ApiError.badRequest(
        'interest_mode_conflict',
        'Choose the monthly late fee before giving it a rate',
      );
    }
    return { mode, rateBps: null, capBps: null };
  }

  if (rateBps === null) {
    throw ApiError.badRequest(
      'interest_rate_required',
      'A monthly late fee needs a rate',
    );
  }

  return { mode, rateBps, capBps };
}

type ConsentSignature = {
  /** The challenge nonce, base64. Identifies the single-use row. */
  nonce: string;
  payload: Nep413SignedMessage;
};

/**
 * A bodyless POST is the pre-signature client and still works; anything with a
 * `payload` must carry the full signed answer.
 */
function readSignedConsent(raw: unknown): ConsentSignature | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const body = raw as Record<string, unknown>;
  if (body.payload === undefined || body.payload === null) return null;

  const nonce = requiredString(body, 'signedMessage', { min: 40, max: 48 });
  const payload = asRecord(body.payload);

  return {
    nonce,
    payload: {
      accountId: requiredString(payload, 'accountId', { min: 2, max: 64 }),
      publicKey: requiredString(payload, 'publicKey', { min: 8, max: 80 }),
      signature: requiredString(payload, 'signature', { min: 80, max: 120 }),
    },
  };
}

type ConsentProof = {
  nearAccount: string;
  publicKey: string;
  signature: string;
  nonce: string;
  termsHash: string;
};

/**
 * Consume the challenge, re-hash the stored terms, then verify. Runs outside
 * the accept transaction because `assertFullAccessKey()` is an RPC round trip
 * and must not hold a pooled connection open.
 */
async function verifyConsentProof(
  agreementId: string,
  memberId: string,
  signed: ConsentSignature,
): Promise<ConsentProof> {
  // The update *is* the replay check: a second POST with the same signature
  // finds no unconsumed row.
  const consumed = await query<{
    agreement_id: string;
    member_id: string;
    nonce: string;
    message: string;
    recipient: string;
    terms_hash: string;
  }>(
    `update agreement_consent_nonces
        set consumed_at = now()
      where nonce_hash = $1
        and consumed_at is null
        and created_at > now() - interval '10 minutes'
    returning agreement_id, member_id, nonce, message, recipient, terms_hash`,
    [hashToken(signed.nonce)],
  );

  const row = consumed.rows[0];
  if (!row || row.agreement_id !== agreementId || row.member_id !== memberId) {
    throw new ApiError(
      401,
      'consent_nonce_invalid',
      'That consent request expired or was already used. Tap accept again.',
    );
  }

  // A signature only counts for the exact bytes it covered, so the snapshot is
  // re-hashed rather than trusted.
  const { rows: termsRows } = await query<{
    terms_snapshot: unknown;
    terms_hash: string | null;
  }>(`select terms_snapshot, terms_hash from agreements where id = $1`, [
    agreementId,
  ]);
  const terms = termsRows[0];
  if (!terms) throw ApiError.notFound('Agreement not found');

  const currentHash = termsHashOf(terms.terms_snapshot);
  if (
    (terms.terms_hash !== null && terms.terms_hash !== currentHash) ||
    row.terms_hash !== currentHash
  ) {
    throw ApiError.conflict(
      'terms_changed',
      'These terms changed after they were signed, so the signature no longer applies',
    );
  }

  if (row.message !== consentMessage({ agreementId, termsHash: currentHash })) {
    throw new ApiError(
      400,
      'consent_message_invalid',
      'That signature does not cover these terms',
    );
  }

  // When the member already linked an account, the signature must come from it
  // — otherwise anybody could accept on somebody else's behalf.
  const { rows: accountRows } = await query<{ linked: string | null }>(
    `select coalesce(m.near_account, u.near_account) as linked
       from members m
       join users u on u.id = m.user_id
      where m.id = $1`,
    [memberId],
  );
  const linked = accountRows[0]?.linked ?? null;
  if (linked && linked.toLowerCase() !== signed.payload.accountId.toLowerCase()) {
    throw ApiError.conflict(
      'consent_wrong_account',
      `These terms are linked to ${linked}, but the signature came from ${signed.payload.accountId}`,
    );
  }

  // No callbackUrl: the popup returns the signature inline, so the challenge
  // never pointed at a return URL and Borsh encodes the field as `[0]`.
  await verifySignedMessage(signed.payload, {
    message: row.message,
    nonce: Buffer.from(row.nonce, 'base64'),
    recipient: row.recipient,
    callbackUrl: null,
  });

  return {
    nearAccount: signed.payload.accountId,
    publicKey: signed.payload.publicKey,
    signature: signed.payload.signature,
    nonce: row.nonce,
    termsHash: currentHash,
  };
}

export const agreementRoutes: FastifyPluginAsync = async (app) => {
  /** Open the one-tap agreement that everyone will accept. */
  app.post('/agreements', async (request) => {
    const body = asRecord(request.body);
    const groupId = requiredUuid(body, 'groupId');
    const estimatedTotalMinor = requiredMinor(body, 'estimatedTotalMinor');
    const deadline = optionalDate(body, 'deadline');
    const splitMode = enumValue(body, 'splitMode', SPLIT_MODES, 'itemised');
    const recurrence = enumValue(body, 'recurrence', RECURRENCES, 'none');
    const consentLevel = enumValue(body, 'consentLevel', CONSENT_LEVELS, 'signed');
    const interest = readInterestRule(body);

    const member = await requireMember(request, groupId);

    const { rows: groupRows } = await query<{
      default_currency: string;
      name: string;
      kind: string;
    }>(`select default_currency, name, kind from groups where id = $1`, [groupId]);
    const group = groupRows[0];
    if (!group) throw ApiError.notFound('Group not found');

    const kind =
      body.kind === undefined || body.kind === null || body.kind === ''
        ? group.kind
        : enumValue(body, 'kind', GROUP_KINDS);

    // A dinner, event or gift is one occasion: a second live agreement would
    // contradict the first split. A running tab (trip, rent, groceries) books
    // as many expenses as it needs.
    if (!allowsMultipleAgreements(kind)) {
      const { rows: activeRows } = await query<{ id: string }>(
        `select id from agreements
          where group_id = $1 and status in ('pending', 'accepted')
          limit 1`,
        [groupId],
      );
      if (activeRows[0]) {
        throw ApiError.conflict(
          'agreement_active',
          'This group already has an active agreement',
        );
      }
    }

    const currency =
      body.currency === undefined
        ? group.default_currency.trim()
        : currencyCode(body.currency);

    const termsSnapshot = {
      groupName: group.name,
      kind,
      splitMode,
      recurrence,
      estimatedTotalMinor,
      currency,
      deadline: deadline ? deadline.toISOString() : null,
      interest,
      note: 'Each member accepts these terms before an expense is booked.',
    };
    const termsHash = termsHashOf(termsSnapshot);

    return withTransaction(async (tx) => {
      const { rows } = await tx.query<AgreementRow>(
        `insert into agreements
           (group_id, currency, estimated_total, deadline, terms_snapshot, status,
            created_by, fronted_by, kind, split_mode, recurrence, terms_hash,
            consent_level, interest_mode, interest_rate_bps, interest_cap_bps)
         values ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14)
         returning id, group_id, currency, estimated_total, deadline, status,
                   created_by, fronted_by, kind, split_mode, recurrence,
                   terms_hash, consent_level, interest_mode, interest_rate_bps,
                   interest_cap_bps`,
        [
          groupId,
          currency,
          estimatedTotalMinor,
          deadline,
          JSON.stringify(termsSnapshot),
          member.id,
          kind,
          splitMode,
          recurrence,
          termsHash,
          consentLevel,
          interest.mode,
          interest.rateBps,
          interest.capBps,
        ],
      );
      const agreement = rows[0];
      if (!agreement) {
        throw new ApiError(500, 'agreement_insert_failed', 'Could not open the agreement');
      }

      await recordEvent(tx, {
        groupId,
        agreementId: agreement.id,
        memberId: member.id,
        eventType: 'system.agreement.created',
        amountMinor: estimatedTotalMinor,
        currency,
        actor: member.displayName,
        summary: `${member.displayName} opened the agreement — everyone taps once to accept`,
      });

      const { rows: countRows } = await tx.query<{ total: number }>(
        `select count(*)::int as total from members
          where group_id = $1 and status <> 'removed'`,
        [groupId],
      );

      return {
        agreement: mapAgreement({
          ...agreement,
          accepted_count: 0,
          member_count: countRows[0]?.total ?? 0,
        }),
      };
    });
  });

  /**
   * Roll a recurring expense (rent, a subscription) into its next period. The
   * members and the split mode carry over because they belong to the group;
   * the amount and the deadline do not, so the fronter restates them and every
   * member signs the new terms again.
   */
  app.post<AgreementParams>('/agreements/:id/clone', async (request) => {
    const agreementId = pathUuid(request.params.id);
    const ctx = await requireAgreementMember(request, agreementId);
    requireFronter(ctx);

    const body = asRecord(request.body);

    const { rows: sourceRows } = await query<{
      currency: string;
      estimated_total: number;
      deadline: Date | null;
      status: string;
      kind: string;
      split_mode: string;
      recurrence: string;
      consent_level: string;
      fronted_by: string | null;
      terms_snapshot: unknown;
      interest_mode: string;
      interest_rate_bps: number | null;
      interest_cap_bps: number | null;
    }>(
      `select currency, estimated_total, deadline, status, kind, split_mode,
              recurrence, consent_level, fronted_by, terms_snapshot,
              interest_mode, interest_rate_bps, interest_cap_bps
         from agreements where id = $1`,
      [agreementId],
    );
    const source = sourceRows[0];
    if (!source) throw ApiError.notFound('Agreement not found');

    if (source.recurrence === 'none') {
      throw ApiError.conflict(
        'not_recurring',
        'This agreement is a one-off, so there is no next period',
      );
    }
    if (source.status !== 'settled') {
      throw ApiError.conflict(
        'agreement_not_settled',
        'Settle this period before starting the next one',
      );
    }

    // Two open periods of the same expense would let someone pay rent twice.
    const { rows: openRows } = await query<{ id: string }>(
      `select id from agreements
        where group_id = $1 and status in ('pending', 'accepted')
          and kind = $2 and recurrence = $3
        limit 1`,
      [ctx.groupId, source.kind, source.recurrence],
    );
    if (openRows[0]) {
      throw ApiError.conflict(
        'period_active',
        'The next period is already open — settle or cancel it first',
      );
    }

    const estimatedTotalMinor =
      body.estimatedTotalMinor === undefined
        ? source.estimated_total
        : requiredMinor(body, 'estimatedTotalMinor');
    const deadline =
      optionalDate(body, 'deadline') ??
      nextPeriod(source.deadline ?? new Date(), source.recurrence);
    const currency = source.currency.trim();

    const snapshot =
      source.terms_snapshot &&
      typeof source.terms_snapshot === 'object' &&
      !Array.isArray(source.terms_snapshot)
        ? (source.terms_snapshot as Record<string, unknown>)
        : {};
    const termsSnapshot = {
      ...snapshot,
      estimatedTotalMinor,
      currency,
      deadline: deadline.toISOString(),
      // The next period keeps the same late-fee rule; the columns are the
      // written record and the snapshot must hash to the same thing.
      interest: {
        mode: source.interest_mode,
        rateBps: source.interest_rate_bps,
        capBps: source.interest_cap_bps,
      },
    };
    const termsHash = termsHashOf(termsSnapshot);

    return withTransaction(async (tx) => {
      const { rows } = await tx.query<AgreementRow>(
        `insert into agreements
           (group_id, currency, estimated_total, deadline, terms_snapshot, status,
            created_by, fronted_by, kind, split_mode, recurrence, terms_hash,
            consent_level, interest_mode, interest_rate_bps, interest_cap_bps)
         values ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15)
         returning id, group_id, currency, estimated_total, deadline, status,
                   created_by, fronted_by, kind, split_mode, recurrence,
                   terms_hash, consent_level, interest_mode, interest_rate_bps,
                   interest_cap_bps`,
        [
          ctx.groupId,
          currency,
          estimatedTotalMinor,
          deadline,
          JSON.stringify(termsSnapshot),
          ctx.member.id,
          source.fronted_by ?? ctx.member.id,
          source.kind,
          source.split_mode,
          source.recurrence,
          termsHash,
          source.consent_level,
          source.interest_mode,
          source.interest_rate_bps,
          source.interest_cap_bps,
        ],
      );
      const agreement = rows[0];
      if (!agreement) {
        throw new ApiError(500, 'agreement_insert_failed', 'Could not open the agreement');
      }

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId: agreement.id,
        memberId: ctx.member.id,
        eventType: 'system.agreement.cloned',
        amountMinor: estimatedTotalMinor,
        currency,
        actor: ctx.member.displayName,
        summary: `${ctx.member.displayName} opened the next ${source.recurrence} period`,
      });

      const { rows: countRows } = await tx.query<{ total: number }>(
        `select count(*)::int as total from members
          where group_id = $1 and status <> 'removed'`,
        [ctx.groupId],
      );

      return {
        agreement: mapAgreement({
          ...agreement,
          accepted_count: 0,
          member_count: countRows[0]?.total ?? 0,
        }),
      };
    });
  });

  /**
   * A single-use NEP-413 challenge for accepting these exact terms. The client
   * signs `message` with the wallet and posts the answer back to `/accept`.
   */
  app.get<AgreementParams>('/agreements/:id/consent', async (request) => {
    const agreementId = pathUuid(request.params.id);
    const ctx = await requireAgreementMember(request, agreementId);

    if (ctx.status === 'cancelled' || ctx.status === 'settled') {
      throw ApiError.conflict('agreement_closed', 'This agreement is closed');
    }

    const { rows } = await query<{
      terms_snapshot: unknown;
      terms_hash: string | null;
      consent_level: string;
    }>(
      `select terms_snapshot, terms_hash, consent_level
         from agreements where id = $1`,
      [agreementId],
    );
    const agreement = rows[0];
    if (!agreement) throw ApiError.notFound('Agreement not found');

    // Rows created before 016 have no stored hash; the snapshot is the source
    // of truth either way, so the digest is derived from it when absent.
    const termsHash =
      agreement.terms_hash ?? termsHashOf(agreement.terms_snapshot);

    const nonce = randomBytes(32).toString('base64');
    const recipient = recipientFor(request.headers.host);
    const message = consentMessage({ agreementId, termsHash });

    // Bounded cleanup with no scheduled job: dead challenges go on the next mint.
    await query(
      `delete from agreement_consent_nonces
        where created_at < now() - interval '10 minutes'`,
    );
    await query(
      `insert into agreement_consent_nonces
         (nonce_hash, agreement_id, member_id, nonce, message, recipient, terms_hash)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        hashToken(nonce),
        agreementId,
        ctx.member.id,
        nonce,
        message,
        recipient,
        termsHash,
      ],
    );

    return {
      terms: agreement.terms_snapshot,
      termsHash,
      consentLevel: agreement.consent_level,
      message,
      nonce,
      recipient,
    };
  });

  /**
   * Idempotent consent. The group flips to `accepted` once everyone has
   * accepted. A bodyless POST keeps working; a `{signedMessage, payload}` body
   * adds the NEP-413 proof that these exact terms were shown and signed.
   */
  app.post<AgreementParams>('/agreements/:id/accept', async (request) => {
    const agreementId = pathUuid(request.params.id);
    const ctx = await requireAgreementMember(request, agreementId);

    if (ctx.status === 'cancelled' || ctx.status === 'settled') {
      throw ApiError.conflict('agreement_closed', 'This agreement is closed');
    }

    const signed = readSignedConsent(request.body);
    const proof = signed
      ? await verifyConsentProof(agreementId, ctx.member.id, signed)
      : null;

    await withTransaction(async (tx) => {
      const { rows: existingRows } = await tx.query<{ member_id: string }>(
        `select member_id from agreement_acceptances where agreement_id = $1`,
        [agreementId],
      );
      const alreadyAccepted = existingRows.some(
        (row) => row.member_id === ctx.member.id,
      );

      if (proof) {
        // One wallet cannot accept twice under two different member rows.
        const { rows: clashRows } = await tx.query(
          `select 1 from agreement_acceptances
            where agreement_id = $1 and near_account = $2 and member_id <> $3`,
          [agreementId, proof.nearAccount, ctx.member.id],
        );
        if (clashRows[0]) {
          throw ApiError.conflict(
            'consent_account_in_use',
            'That NEAR account already accepted these terms for another member',
          );
        }

        await tx.query(
          `insert into agreement_acceptances
             (agreement_id, member_id, near_account, public_key, signature,
              nonce, terms_hash, signed_at)
           values ($1, $2, $3, $4, $5, $6, $7, now())
           on conflict (agreement_id, member_id) do update
             set near_account = excluded.near_account,
                 public_key = excluded.public_key,
                 signature = excluded.signature,
                 nonce = excluded.nonce,
                 terms_hash = excluded.terms_hash,
                 signed_at = excluded.signed_at`,
          [
            agreementId,
            ctx.member.id,
            proof.nearAccount,
            proof.publicKey,
            proof.signature,
            proof.nonce,
            proof.termsHash,
          ],
        );
      } else {
        await tx.query(
          `insert into agreement_acceptances (agreement_id, member_id)
           values ($1, $2)
           on conflict (agreement_id, member_id) do nothing`,
          [agreementId, ctx.member.id],
        );
      }

      const { rows } = await tx.query<{ accepted: number; total: number }>(
        `select
           (select count(*)::int from agreement_acceptances
             where agreement_id = $1) as accepted,
           (select count(*)::int from members
             where group_id = $2 and status <> 'removed') as total`,
        [agreementId, ctx.groupId],
      );
      const counts: AgreementCounts = {
        accepted: rows[0]?.accepted ?? 0,
        total: rows[0]?.total ?? 0,
      };

      if (counts.total > 0 && counts.accepted >= counts.total) {
        await tx.query(
          `update agreements set status = 'accepted'
            where id = $1 and status = 'pending'`,
          [agreementId],
        );
      }

      if (!alreadyAccepted) {
        await recordEvent(tx, {
          groupId: ctx.groupId,
          agreementId,
          memberId: ctx.member.id,
          eventType: 'agreement.accepted',
          currency: ctx.currency,
          actor: ctx.member.displayName,
          summary: proof
            ? `${ctx.member.displayName} signed the terms with ${proof.nearAccount}`
            : `${ctx.member.displayName} agreed to the reimbursement terms`,
        });
      }
    });

    return { agreement: mapAgreement(await loadAgreement(agreementId)) };
  });

  /**
   * Every acceptance with the proof behind it. The signature is off-chain, so
   * this is the only place the group can see who signed with which account —
   * and `anchorTxHash` says whether that signature was also made public.
   */
  app.get<AgreementParams>('/agreements/:id/acceptances', async (request) => {
    const agreementId = pathUuid(request.params.id);
    await requireAgreementMember(request, agreementId);

    const agreement = await loadAgreement(agreementId);
    const { rows } = await query<{
      member_id: string;
      display_name: string;
      near_account: string | null;
      public_key: string | null;
      signature: string | null;
      nonce: string | null;
      terms_hash: string | null;
      signed_at: Date | null;
      accepted_at: Date;
      anchor_tx_hash: string | null;
    }>(
      `select aa.member_id, u.display_name, aa.near_account, aa.public_key,
              aa.signature, aa.nonce, aa.terms_hash, aa.signed_at,
              aa.accepted_at, aa.anchor_tx_hash
         from agreement_acceptances aa
         join members m on m.id = aa.member_id
         join users u on u.id = m.user_id
        where aa.agreement_id = $1
        order by aa.signed_at nulls last, aa.accepted_at`,
      [agreementId],
    );

    return {
      termsHash: agreement.terms_hash ?? null,
      consentLevel: (agreement.consent_level ?? 'signed') as 'signed' | 'anchored',
      acceptances: rows.map((row) => ({
        memberId: row.member_id,
        displayName: row.display_name,
        nearAccount: row.near_account ?? null,
        publicKey: row.public_key ?? null,
        signature: row.signature ?? null,
        termsHash: row.terms_hash ?? null,
        signedAt: row.signed_at ? row.signed_at.toISOString() : null,
        acceptedAt: row.accepted_at.toISOString(),
        anchorTxHash: row.anchor_tx_hash ?? null,
      })),
    };
  });

  /**
   * Put the signed terms in the public ledger.
   *
   * An acceptance is a NEP-413 signature: free, off-chain, invisible to an
   * explorer. Two kinds of transaction can carry it on chain:
   *
   * - A read-only `ft_balance_of({ "account_id": "<termsHash>" })` on the USDC
   *   contract, signed by the fronter. One transaction covers every signature;
   *   nothing moves and no storage is written.
   * - A `record_acceptance` row in the shared registry contract, signed by the
   *   member themselves. It writes storage (paid by the registry owner) and the
   *   contract asserts `predecessor == account_id`, so it proves one member —
   *   never the whole group.
   *
   * Both are verified the same way: the hash must resolve to a successful
   * transaction signed by this account, carrying these exact terms.
   */
  app.post<AgreementParams>('/agreements/:id/anchor', async (request) => {
    const agreementId = pathUuid(request.params.id);
    const ctx = await requireAgreementMember(request, agreementId);

    if (!config.near.usdcContract && !config.near.agreementsContract) {
      throw ApiError.conflict(
        'near_not_configured',
        'NEAR is not configured on this server, so nothing can be anchored',
      );
    }

    const body = asRecord(request.body);
    const rawHash = typeof body.txHash === 'string' ? body.txHash.trim() : '';
    if (!TX_HASH.test(rawHash)) {
      throw ApiError.badRequest(
        'invalid_txHash',
        'Paste the hash of the anchor transaction',
      );
    }

    const agreement = await loadAgreement(agreementId);
    const termsHash = agreement.terms_hash;
    if (!termsHash) {
      throw ApiError.conflict(
        'terms_missing',
        'These terms have no digest yet, so there is nothing to anchor',
      );
    }

    // Anchoring is an on-chain act by the fronter, so their account must be
    // verified: an unverified claim could point at somebody else's signature.
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
    const signer = accountRows[0]?.near_account ?? null;
    if (!signer) {
      throw ApiError.conflict(
        'near_account_missing',
        'Link and verify your NEAR account before anchoring these terms',
      );
    }

    // A fresh transaction can take a moment to reach the RPC node the request
    // landed on; two short retries beat asking the fronter to pay twice.
    let transfer = await getTransferStatus({ txHash: rawHash, senderId: signer });
    for (let attempt = 0; attempt < 2 && !transfer.found; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      transfer = await getTransferStatus({ txHash: rawHash, senderId: signer });
    }

    if (!transfer.found) {
      throw ApiError.conflict(
        'near_tx_not_found',
        'That transaction is not on chain yet — wait for the wallet receipt and try again',
      );
    }
    if (!transfer.success) {
      throw ApiError.conflict(
        'near_tx_failed',
        'That transaction failed on chain, so it cannot anchor anything',
      );
    }
    if (transfer.sender !== signer) {
      throw ApiError.conflict(
        'near_tx_wrong_sender',
        `That transaction was signed by ${transfer.sender ?? 'an unknown account'}, not ${signer}`,
      );
    }

    // The registry branch. It writes one row for the member who signed the
    // transaction, so it needs no fronter and must never touch anyone else's
    // acceptance — hence the `near_account = $3` and signature match below.
    if (transfer.tokenContract === config.near.agreementsContract) {
      if (transfer.method !== RECORD_ACCEPTANCE_METHOD) {
        throw ApiError.conflict(
          'near_tx_wrong_method',
          `That transaction called ${transfer.method ?? 'no method'}, not ${RECORD_ACCEPTANCE_METHOD}`,
        );
      }
      if (transfer.agreementArg !== agreementId) {
        throw ApiError.conflict(
          'near_tx_wrong_agreement',
          'That record belongs to a different agreement',
        );
      }
      if (transfer.termsArg !== termsHash) {
        throw ApiError.conflict(
          'near_tx_wrong_digest',
          `That record carries ${
            transfer.termsArg ? `"${transfer.termsArg}"` : 'no digest'
          }, not the digest of these terms`,
        );
      }
      if (transfer.accountArg !== signer) {
        throw ApiError.conflict(
          'near_tx_wrong_account',
          `That record was written for ${transfer.accountArg ?? 'no account'}, not ${signer}`,
        );
      }
      if (!transfer.signatureArg) {
        throw ApiError.conflict(
          'near_tx_wrong_signature',
          'That record carries no signature, so it proves nothing',
        );
      }

      const recorded = await withTransaction(async (tx) => {
        const { rowCount } = await tx.query(
          `update agreement_acceptances
              set anchor_tx_hash = $5
            where agreement_id = $1
              and terms_hash = $2
              and near_account = $3
              and signature = $4
              and anchor_tx_hash is null`,
          [agreementId, termsHash, signer, transfer.signatureArg, rawHash],
        );
        if (!rowCount) {
          throw ApiError.conflict(
            'nothing_to_anchor',
            'That signature is already recorded on chain',
          );
        }

        await recordEvent(tx, {
          groupId: ctx.groupId,
          agreementId,
          memberId: ctx.member.id,
          eventType: 'agreement.anchored',
          currency: ctx.currency,
          actor: ctx.member.displayName,
          summary: `${ctx.member.displayName} recorded their acceptance in the registry on ${config.near.network}`,
        });

        return rowCount;
      });

      return {
        agreement: mapAgreement(await loadAgreement(agreementId)),
        anchor: {
          txHash: rawHash,
          explorerUrl: transfer.explorerUrl,
          digest: termsHash,
          anchoredCount: recorded,
        },
      };
    }

    // Everything below is the read-only USDC anchor, which is the fronter's
    // own transaction: it covers the whole group at once.
    requireFronter(ctx);
    if (!config.near.usdcContract) {
      throw ApiError.conflict(
        'near_not_configured',
        'NEAR is not configured on this server, so nothing can be anchored',
      );
    }
    if (transfer.tokenContract !== config.near.usdcContract) {
      throw ApiError.conflict(
        'near_tx_wrong_token',
        'That transaction called a different token contract',
      );
    }
    if (transfer.method !== ANCHOR_METHOD) {
      throw ApiError.conflict(
        'near_tx_wrong_method',
        `That transaction called ${transfer.method ?? 'no method'}, not ${ANCHOR_METHOD}`,
      );
    }
    if (transfer.accountArg !== termsHash) {
      throw ApiError.conflict(
        'near_tx_wrong_digest',
        `That transaction carries ${
          transfer.accountArg ? `"${transfer.accountArg}"` : 'no digest'
        }, not the digest of these terms`,
      );
    }

    const anchored = await withTransaction(async (tx) => {
      const { rowCount } = await tx.query(
        `update agreement_acceptances
            set anchor_tx_hash = $3
          where agreement_id = $1
            and terms_hash = $2
            and signature is not null
            and anchor_tx_hash is null`,
        [agreementId, termsHash, rawHash],
      );
      if (!rowCount) {
        throw ApiError.conflict(
          'nothing_to_anchor',
          'Every wallet signature on these terms is already anchored',
        );
      }

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId,
        memberId: ctx.member.id,
        eventType: 'agreement.anchored',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `${ctx.member.displayName} anchored ${rowCount} signed ${
          rowCount === 1 ? 'acceptance' : 'acceptances'
        } on ${config.near.network}`,
      });

      return rowCount;
    });

    return {
      agreement: mapAgreement(await loadAgreement(agreementId)),
      anchor: {
        txHash: rawHash,
        explorerUrl: transfer.explorerUrl,
        digest: termsHash,
        anchoredCount: anchored,
      },
    };
  });

  /**
   * The agreement-level half of the split choice. Any member votes, not just
   * the fronter: the creator proposed a mode in the signed terms, but the group
   * is free to agree on the other one. A single bill can still override this
   * later; see `POST /bills/:id/split-vote`.
   */
  app.post<AgreementParams>('/agreements/:id/split-vote', async (request) => {
    const agreementId = pathUuid(request.params.id);
    const ctx = await requireAgreementMember(request, agreementId);
    if (ctx.status === 'settled' || ctx.status === 'cancelled') {
      throw ApiError.conflict('agreement_closed', 'This agreement is closed');
    }

    const body = asRecord(request.body);
    const mode = enumValue(body, 'mode', SPLIT_VOTES);
    await castAgreementSplitVote({ agreementId, memberId: ctx.member.id, mode });

    const splitVote = await loadAgreementSplitSummary({
      agreementId,
      groupId: ctx.groupId,
      storedMode: ctx.splitMode,
      frontedBy: ctx.frontedBy,
      memberId: ctx.member.id,
    });

    await recordEvent({ query }, {
      groupId: ctx.groupId,
      agreementId,
      memberId: ctx.member.id,
      eventType: 'agreement.split_voted',
      currency: ctx.currency,
      actor: ctx.member.displayName,
      summary: `${ctx.member.displayName} voted to split ${
        mode === 'equal' ? 'evenly' : 'by line item'
      }`,
      metadata: { mode, resolvedMode: splitVote.resolvedMode },
    });

    return { splitVote };
  });
};
