/**
 * Late fees — the agreed penalty for missing `shares.due_at`.
 *
 * This mirrors `tips` rather than extending `shares`: `shares` is unique per
 * (bill_id, member_id) and every bill guard asserts `sum(shares) = bills.total`,
 * so an interest row there would make the bill un-finalisable and
 * un-requestable. A late fee is therefore its own money row that settles
 * straight into the fronter's NEAR account.
 *
 * Three rules make it honest:
 *   - the rate was agreed at creation and is inside the signed `terms_snapshot`;
 *   - only the fronter may raise it, only after `due_at`, and it is quoted once
 *     when raised (never re-priced by a moving FX rate);
 *   - it never marks the bill paid — like a tip, it is not what settles the bill.
 */

import { query, withTransaction, type Db } from '../db/pool.js';
import { ApiError } from './http-error.js';
import { recordEvent } from './ledger.js';
import {
    explorerTx,
    isNearAccountId,
    isNearConfigured,
    verifyTransfer
} from './near.js';
import { type InterestChargeRow } from './serialize.js';
import { ensureQuote } from './settlement-quote.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A "month" is a calendar-ish 30 days: a fee is charged for each started
 * period, so one day late already costs one month's rate. That is the reading
 * members expect from "2% per month", and it never accrues a fraction of a
 * minor unit.
 */
const DAYS_PER_MONTH = 30;

/** The pool-shaped `Db` so `loadInterest` can also take a transaction client. */
const poolDb: Db = { query };

/**
 * The fee owed for a share today. Pure and integer-only: the ledger never
 * holds a fraction of a minor unit, and a fee that would round to zero is not
 * worth raising.
 */
export function interestFor(input: {
  shareAmountMinor: number;
  rateBps: number;
  capBps: number | null;
  daysLate: number;
}): number {
  if (input.shareAmountMinor <= 0) return 0;
  if (input.rateBps <= 0) return 0;
  if (input.daysLate <= 0) return 0;

  const months = Math.ceil(input.daysLate / DAYS_PER_MONTH);
  const accrued = Math.round(
    (input.shareAmountMinor * input.rateBps * months) / 10000,
  );

  // The cap is a ceiling on the charge, not on the rate: "capped at 20% of the
  // share" must stay true however long the member takes.
  const cap =
    input.capBps === null
      ? accrued
      : Math.round((input.shareAmountMinor * input.capBps) / 10000);

  return Math.max(0, Math.min(accrued, cap));
}

export type InterestRow = InterestChargeRow & {
  group_id: string;
  /** The share being fined; the base the rate applies to. */
  share_amount: number;
  share_member_id: string;
  share_status: string;
  share_due_at: Date | null;
};

const CHARGE_COLUMNS = `ic.id, ic.share_id, ic.bill_id, ic.agreement_id,
       ic.member_id, mu.display_name as member_name,
       ic.to_member_id, tu.display_name as to_member_name,
       ic.amount, ic.currency, ic.rate_bps, ic.cap_bps, ic.days_late,
       ic.status, ic.settlement_tx_hash,
       ic.quoted_chain_amount, ic.quote_rate, ic.quote_as_of,
       ic.raised_at, ic.paid_at, ic.created_at,
       a.group_id,
       s.amount as share_amount, s.member_id as share_member_id,
       s.status as share_status, s.due_at as share_due_at,
       coalesce(
         case when tu.near_verified then tm.near_account end,
         case when tu.near_verified then tu.near_account end,
         a.treasury_account
       ) as pay_to`;

async function loadInterest(
  db: Db,
  chargeId: string,
  lock = false,
): Promise<InterestRow> {
  const { rows } = await db.query<InterestRow>(
    `select ${CHARGE_COLUMNS}
       from interest_charges ic
       join shares s on s.id = ic.share_id
       join agreements a on a.id = ic.agreement_id
       join members mm on mm.id = ic.member_id
       join users mu on mu.id = mm.user_id
       join members tm on tm.id = ic.to_member_id
       join users tu on tu.id = tm.user_id
      where ic.id = $1
      ${lock ? 'for update of ic' : ''}`,
    [chargeId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Late fee not found');
  return row;
}

export async function listInterestCharges(billId: string): Promise<InterestRow[]> {
  const { rows } = await query<InterestRow>(
    `select ${CHARGE_COLUMNS}
       from interest_charges ic
       join shares s on s.id = ic.share_id
       join agreements a on a.id = ic.agreement_id
       join members mm on mm.id = ic.member_id
       join users mu on mu.id = mm.user_id
       join members tm on tm.id = ic.to_member_id
       join users tu on tu.id = tm.user_id
      where ic.bill_id = $1
      order by ic.created_at asc`,
    [billId],
  );
  return rows;
}

/** The account a member pays from: their group subaccount, else their own. */
async function loadPayerAccount(memberId: string): Promise<string | null> {
  const { rows } = await query<{ near_account: string | null }>(
    `select coalesce(
              case when u.near_verified then m.near_account end,
              case when u.near_verified then u.near_account end
            ) as near_account
       from members m
       join users u on u.id = m.user_id
      where m.id = $1`,
    [memberId],
  );
  return rows[0]?.near_account ?? null;
}

export type RaiseInterestInput = {
  billId: string;
  agreementId: string;
  groupId: string;
  currency: string;
  shareId: string;
  /** The fronter raising the charge — the member who receives it. */
  fronterMemberId: string;
  actor: string;
  /** Injectable so the accrual is testable; defaults to now. */
  now?: Date;
};

/**
 * Raise (or re-raise) the late fee on one share. Idempotent per share: the row
 * is unique on `share_id`, and re-raising recomputes the accrual against the
 * rule that made it. Only the caller's guard makes this fronter-only.
 */
export async function raiseInterest(
  input: RaiseInterestInput,
): Promise<InterestRow> {
  const now = input.now ?? new Date();

  const { rows: shareRows } = await query<{
    id: string;
    member_id: string;
    amount: number;
    currency: string;
    status: string;
    due_at: Date | null;
  }>(
    `select id, member_id, amount, currency, status, due_at
       from shares where id = $1 and bill_id = $2`,
    [input.shareId, input.billId],
  );
  const share = shareRows[0];
  if (!share) throw ApiError.notFound('Share not found');

  if (share.status === 'settled' || share.status === 'paid') {
    throw ApiError.conflict(
      'share_already_settled',
      'That share is already paid, so no late fee applies',
    );
  }

  const { rows: ruleRows } = await query<{
    interest_mode: string;
    interest_rate_bps: number | null;
    interest_cap_bps: number | null;
  }>(
    `select interest_mode, interest_rate_bps, interest_cap_bps
       from agreements where id = $1`,
    [input.agreementId],
  );
  const rule = ruleRows[0];
  if (!rule || rule.interest_mode === 'none' || !rule.interest_rate_bps) {
    throw ApiError.conflict(
      'interest_not_agreed',
      'This agreement has no late fee — the members never agreed to one',
    );
  }

  if (!share.due_at) {
    throw ApiError.conflict(
      'no_due_date',
      'That share has no due date, so it cannot be late',
    );
  }
  if (share.due_at.getTime() >= now.getTime()) {
    throw ApiError.conflict(
      'not_late_yet',
      'That share is not past its due date yet',
    );
  }

  const daysLate = Math.floor((now.getTime() - share.due_at.getTime()) / DAY_MS);
  const amount = interestFor({
    shareAmountMinor: share.amount,
    rateBps: rule.interest_rate_bps,
    capBps: rule.interest_cap_bps,
    daysLate,
  });

  if (amount <= 0) {
    throw ApiError.conflict(
      'interest_below_minimum',
      'The agreed rate rounds to zero on this share — there is nothing to charge',
    );
  }

  const { rows: existingRows } = await query<{
    id: string;
    amount: number;
  }>(`select id, amount from interest_charges where share_id = $1`, [
    input.shareId,
  ]);
  const existing = existingRows[0];
  const changed = !existing || existing.amount !== amount;

  // `where status <> 'paid'` is the race guard: if the member settled the fee
  // between the read above and this write, the update matches nothing rather
  // than resurrecting a paid charge.
  const { rows: upsertRows } = await query<{ id: string }>(
    `insert into interest_charges
       (share_id, bill_id, agreement_id, member_id, to_member_id, rate_bps,
        cap_bps, days_late, amount, currency, status, raised_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'requested', $11::timestamptz)
     on conflict (share_id) do update
        set amount = excluded.amount,
            rate_bps = excluded.rate_bps,
            cap_bps = excluded.cap_bps,
            days_late = excluded.days_late,
            currency = excluded.currency,
            raised_at = excluded.raised_at,
            status = 'requested',
            -- A changed amount invalidates the quote: the member would
            -- otherwise sign a number for a fee that no longer exists.
            quoted_chain_amount =
              case when interest_charges.amount = excluded.amount
                    and interest_charges.currency = excluded.currency
                   then interest_charges.quoted_chain_amount end,
            quote_rate =
              case when interest_charges.amount = excluded.amount
                    and interest_charges.currency = excluded.currency
                   then interest_charges.quote_rate end,
            quote_as_of =
              case when interest_charges.amount = excluded.amount
                    and interest_charges.currency = excluded.currency
                   then interest_charges.quote_as_of end
      where interest_charges.status <> 'paid'
     returning id`,
    [
      input.shareId,
      input.billId,
      input.agreementId,
      // The share's owner owes it; the fronter receives it.
      share.member_id,
      input.fronterMemberId,
      rule.interest_rate_bps,
      rule.interest_cap_bps,
      daysLate,
      amount,
      share.currency.trim(),
      now.toISOString(),
    ],
  );

  const chargeId = upsertRows[0]?.id;
  if (!chargeId) {
    throw ApiError.conflict(
      'interest_already_paid',
      'That late fee has already been paid',
    );
  }

  // Quote once, when raised: the amount the member is shown is the amount
  // `settleInterest()` will require.
  await ensureQuote({
    table: 'interest_charges',
    id: chargeId,
    amountMinor: amount,
    currency: share.currency.trim(),
  });

  if (changed) {
    await recordEvent(poolDb, {
      groupId: input.groupId,
      agreementId: input.agreementId,
      memberId: input.fronterMemberId,
      eventType: 'interest.raised',
      amountMinor: amount,
      currency: share.currency.trim(),
      actor: input.actor,
      summary: `${input.actor} raised a late fee on a share ${daysLate} day(s) late`,
      metadata: {
        rail: 'near_transfer',
        charge_id: chargeId,
        share_id: input.shareId,
        rate_bps: rule.interest_rate_bps,
        cap_bps: rule.interest_cap_bps,
        days_late: daysLate,
      },
    });
  }

  return loadInterest(poolDb, chargeId);
}

export type SettleInterestInput = {
  chargeId: string;
  txHash: string;
  actor: string;
};

export type SettleInterestResult = {
  chargeId: string;
  alreadyPaid: boolean;
  explorerUrl: string;
};

/**
 * Prove the transfer and mark the late fee paid. The chain is the only proof
 * we accept; the advisory lock is the one `settleShare` takes, so a retried
 * submission cannot record the fee twice.
 */
export async function settleInterest(
  input: SettleInterestInput,
): Promise<SettleInterestResult> {
  if (!isNearConfigured()) {
    throw ApiError.conflict(
      'near_not_configured',
      'NEAR settlement is not configured on this server',
    );
  }

  const preview = await loadInterest(poolDb, input.chargeId);

  if (preview.status === 'paid') {
    return {
      chargeId: preview.id,
      alreadyPaid: true,
      explorerUrl: explorerTx(preview.settlement_tx_hash ?? input.txHash),
    };
  }

  if (preview.status === 'waived') {
    throw ApiError.conflict(
      'interest_waived',
      'The fronter waived this late fee',
    );
  }

  const payerAccount = await loadPayerAccount(preview.member_id);
  if (!payerAccount || !isNearAccountId(payerAccount)) {
    throw ApiError.conflict(
      'member_near_missing',
      'Link a NEAR account before paying this late fee',
    );
  }
  if (!preview.pay_to || !isNearAccountId(preview.pay_to)) {
    throw ApiError.conflict(
      'fronter_near_missing',
      'The fronter has no NEAR account to receive this late fee',
    );
  }

  // Quoted when raised; settle against that frozen integer so a rate that
  // moved while the wallet was open cannot reject a correct transfer.
  const quote = await ensureQuote({
    table: 'interest_charges',
    id: preview.id,
    amountMinor: preview.amount,
    currency: preview.currency.trim(),
    stored: preview,
  });

  const transfer = await verifyTransfer({
    txHash: input.txHash,
    senderId: payerAccount,
    expectedReceiver: preview.pay_to,
    expectedChainAmount: quote.baseUnits,
  });

  return withTransaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [
      preview.agreement_id,
    ]);

    const charge = await loadInterest(tx, input.chargeId, true);

    if (charge.status === 'paid') {
      return {
        chargeId: charge.id,
        alreadyPaid: true,
        explorerUrl: transfer.explorerUrl,
      };
    }

    await tx.query(
      `update interest_charges
          set status = 'paid',
              paid_at = now(),
              settlement_tx_hash = coalesce(settlement_tx_hash, $2)
        where id = $1`,
      [charge.id, transfer.txHash],
    );

    await recordEvent(tx, {
      groupId: charge.group_id,
      agreementId: charge.agreement_id,
      memberId: charge.member_id,
      eventType: 'interest.paid',
      amountMinor: charge.amount,
      currency: charge.currency.trim(),
      actor: input.actor,
      summary: `${charge.member_name} paid a late fee to ${charge.to_member_name}`,
      metadata: {
        rail: 'near_transfer',
        charge_id: charge.id,
        share_id: charge.share_id,
        days_late: charge.days_late,
        tx_hash: transfer.txHash,
      },
    });

    return {
      chargeId: charge.id,
      alreadyPaid: false,
      explorerUrl: transfer.explorerUrl,
    };
  });
}
