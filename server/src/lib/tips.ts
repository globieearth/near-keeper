/**
 * "Give a tip": a member voluntarily adds money for the fronter on top of their
 * own share (DEV_PLAN §2.18). Tips live in their own table rather than in
 * `shares` (unique per bill/member) or `payments` (share_id is NOT NULL), so
 * the reimbursement rollup and the webhook amount guard keep their meaning.
 * The tip transfer names the fronter as receiver, so it settles straight to
 * them; a verified NEP-141 receipt is the only proof we accept.
 *
 * Deliberately absent here: `payments` rows and `rollUpBill`. A tip is not part
 * of what settles the bill, so it must never make an unpaid bill look paid.
 */

import { query, withTransaction, type Db } from '../db/pool.js';
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
import { awardGlobie } from './settlement.js';

/** Tipping is a nice gesture, not a race — a flat reward, one per member. */
const TIP_GLOBIE = 2;
const TIP_REASON = 'tip';

/** The pool-shaped `Db` so `loadTip` can also take a transaction client. */
const poolDb: Db = { query };

export type TipRow = {
  id: string;
  bill_id: string;
  agreement_id: string;
  group_id: string;
  bill_currency: string;
  bill_status: string;
  from_member_id: string;
  from_member_name: string;
  to_member_id: string;
  to_member_name: string;
  amount: number;
  currency: string;
  message: string | null;
  status: string;
  settlement_tx_hash: string | null;
  /** The fronter's NEAR account — where the tip transfer must land. */
  pay_to: string | null;
  quoted_chain_amount: string | null;
  quote_rate: string | null;
  quote_as_of: Date | null;
  paid_at: Date | null;
  created_at: Date;
};

async function loadTip(db: Db, tipId: string, lock = false): Promise<TipRow> {
  const { rows } = await db.query<TipRow>(
    `select t.id, t.bill_id, t.agreement_id, a.group_id,
            b.currency as bill_currency, b.status as bill_status,
            t.from_member_id, fu.display_name as from_member_name,
            t.to_member_id, tu.display_name as to_member_name,
            t.amount, t.currency, t.message, t.status,
            t.settlement_tx_hash,
            t.quoted_chain_amount, t.quote_rate, t.quote_as_of,
            coalesce(
              case when tu.near_verified then tm.near_account end,
              case when tu.near_verified then tu.near_account end,
              a.treasury_account
            ) as pay_to,
            t.paid_at, t.created_at
       from tips t
       join bills b on b.id = t.bill_id
       join agreements a on a.id = t.agreement_id
       join members fm on fm.id = t.from_member_id
       join users fu on fu.id = fm.user_id
       join members tm on tm.id = t.to_member_id
       join users tu on tu.id = tm.user_id
      where t.id = $1
      ${lock ? 'for update of t' : ''}`,
    [tipId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Tip not found');
  return row;
}

export async function listTips(billId: string): Promise<TipRow[]> {
  const { rows } = await query<TipRow>(
    `select t.id, t.bill_id, t.agreement_id, a.group_id,
            b.currency as bill_currency, b.status as bill_status,
            t.from_member_id, fu.display_name as from_member_name,
            t.to_member_id, tu.display_name as to_member_name,
            t.amount, t.currency, t.message, t.status,
            t.settlement_tx_hash,
            t.quoted_chain_amount, t.quote_rate, t.quote_as_of,
            coalesce(
              case when tu.near_verified then tm.near_account end,
              case when tu.near_verified then tu.near_account end,
              a.treasury_account
            ) as pay_to,
            t.paid_at, t.created_at
       from tips t
       join bills b on b.id = t.bill_id
       join agreements a on a.id = t.agreement_id
       join members fm on fm.id = t.from_member_id
       join users fu on fu.id = fm.user_id
       join members tm on tm.id = t.to_member_id
       join users tu on tu.id = tm.user_id
      where t.bill_id = $1
      order by t.created_at asc`,
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

export type RequestTipInput = {
  billId: string;
  agreementId: string;
  groupId: string;
  currency: string;
  fromMember: { id: string; displayName: string };
  toMemberId: string;
  toMemberName: string;
  amountMinor: number;
  message: string | null;
};

export type RequestTipResult = {
  tipId: string;
  status: string;
  amount: number;
  currency: string;
  payTo: string;
  tokenContract: string;
  /** Amount in the token's decimals; this is what the wallet signs. */
  chainAmount: string;
  /** USD per one unit of `currency`, locked when this tip was quoted. */
  quoteRate: number;
  /** When that rate was published. */
  quoteAsOf: string;
  /** Written on chain, so the receipt is self-identifying on an explorer. */
  memo: string;
  alreadyRequested: boolean;
};

/**
 * Create (or reuse) this member's tip for the bill and return the transfer
 * instructions. Re-requesting is idempotent: the memo is the tip id, so the
 * same transfer can be retried or resumed from the wallet without producing a
 * second, ambiguous payment.
 */
export async function requestTip(
  input: RequestTipInput,
): Promise<RequestTipResult> {
  if (!isNearConfigured()) {
    throw ApiError.conflict(
      'near_not_configured',
      'NEAR settlement is not configured on this server',
    );
  }

  // The tip settles into the fronter's own account, so it needs their address
  // before any tip row exists — a fronter without one blocks the tip.
  const { rows: payeeRows } = await query<{ near_account: string | null }>(
    `select coalesce(
              case when u.near_verified then m.near_account end,
              case when u.near_verified then u.near_account end,
              a.treasury_account
            ) as near_account
       from members m
       join users u on u.id = m.user_id
       join agreements a on a.id = $2
      where m.id = $1`,
    [input.toMemberId, input.agreementId],
  );
  const payeeAccount = payeeRows[0]?.near_account ?? null;

  if (!payeeAccount || !isNearAccountId(payeeAccount)) {
    throw ApiError.conflict(
      'fronter_near_missing',
      `${input.toMemberName} must link a NEAR account before you can tip them`,
    );
  }

  const payerAccount = await loadPayerAccount(input.fromMember.id);

  if (!payerAccount || !isNearAccountId(payerAccount)) {
    throw ApiError.conflict(
      'member_near_missing',
      'Link a NEAR account before you tip',
    );
  }

  // A transfer from an account to itself is not a tip.
  if (payerAccount.toLowerCase() === payeeAccount.toLowerCase()) {
    throw ApiError.conflict(
      'self_payment',
      'You cannot tip yourself — that money is already yours',
    );
  }

  const { rows: existingRows } = await query<{
    id: string;
    status: string;
    amount: number;
  }>(
    `select id, status, amount
       from tips where bill_id = $1 and from_member_id = $2`,
    [input.billId, input.fromMember.id],
  );

  const existing = existingRows[0];
  let tipId: string;
  let alreadyRequested = false;

  if (existing) {
    if (existing.status === 'paid') {
      throw ApiError.conflict(
        'tip_already_paid',
        'You already tipped the fronter on this bill',
      );
    }

    tipId = existing.id;
    alreadyRequested =
      existing.status === 'requested' && existing.amount === input.amountMinor;

    // Changing the amount invalidates the quote — the member would be signing a
    // number for an amount they no longer owe. Clearing it forces a fresh one
    // below, while an unchanged amount keeps the number already shown.
    await query(
      `update tips
          set quoted_chain_amount =
                case when amount = $2 and currency = $3 then quoted_chain_amount end,
              quote_rate =
                case when amount = $2 and currency = $3 then quote_rate end,
              quote_as_of =
                case when amount = $2 and currency = $3 then quote_as_of end,
              amount = $2, currency = $3, message = $4
        where id = $1`,
      [tipId, input.amountMinor, input.currency, input.message],
    );
  } else {
    const { rows: insertedRows } = await query<{ id: string }>(
      `insert into tips
         (bill_id, agreement_id, from_member_id, to_member_id, amount, currency,
          message, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'proposed')
       on conflict (bill_id, from_member_id) do nothing
       returning id`,
      [
        input.billId,
        input.agreementId,
        input.fromMember.id,
        input.toMemberId,
        input.amountMinor,
        input.currency,
        input.message,
      ],
    );

    const created = insertedRows[0];
    if (!created) {
      // A concurrent request won the insert; let it answer this one.
      throw ApiError.conflict(
        'tip_in_progress',
        'A tip for this bill is already being set up — try again',
      );
    }
    tipId = created.id;
  }

  if (!alreadyRequested) {
    await withTransaction(async (tx) => {
      await tx.query(
        `update tips
            set status = 'requested'
          where id = $1 and status in ('proposed', 'requested', 'failed', 'refunded')`,
        [tipId],
      );

      await recordEvent(tx, {
        groupId: input.groupId,
        agreementId: input.agreementId,
        memberId: input.fromMember.id,
        eventType: 'tip.requested',
        amountMinor: input.amountMinor,
        currency: input.currency,
        actor: input.fromMember.displayName,
        summary: `${input.fromMember.displayName} is tipping ${input.toMemberName}`,
        metadata: {
          rail: 'near_transfer',
          tip_id: tipId,
          to_member_id: input.toMemberId,
          pay_to: payeeAccount,
        },
      });
    });
  }

  // The tip row now exists and is requested, so the amount it will cost in USDC
  // can be frozen onto it. `settleTip()` verifies against that same integer.
  const quote = await ensureQuote({
    table: 'tips',
    id: tipId,
    amountMinor: input.amountMinor,
    currency: input.currency,
  });

  return {
    tipId,
    status: 'requested',
    amount: input.amountMinor,
    currency: input.currency,
    payTo: payeeAccount,
    tokenContract: config.near.usdcContract,
    chainAmount: quote.amount,
    quoteRate: quote.rate,
    quoteAsOf: quote.asOf,
    memo: `globie:tip:${tipId}`,
    alreadyRequested,
  };
}

export type SettleTipInput = {
  tipId: string;
  txHash: string;
  actor: string;
};

export type SettleTipResult = {
  tipId: string;
  alreadyPaid: boolean;
  pointsAwarded: number;
  explorerUrl: string;
};

/**
 * Prove the transfer and mark the tip paid. The verification in lib/near.ts is
 * the only way a tip becomes paid on this rail; the advisory lock is the same
 * one `settleShare` takes, so a retried submission cannot award Globie twice.
 */
export async function settleTip(input: SettleTipInput): Promise<SettleTipResult> {
  if (!isNearConfigured()) {
    throw ApiError.conflict(
      'near_not_configured',
      'NEAR settlement is not configured on this server',
    );
  }

  const preview = await loadTip(poolDb, input.tipId);

  if (preview.status === 'paid') {
    return {
      tipId: preview.id,
      alreadyPaid: true,
      pointsAwarded: 0,
      explorerUrl: explorerTx(preview.settlement_tx_hash ?? input.txHash),
    };
  }

  const payerAccount = await loadPayerAccount(preview.from_member_id);
  if (!payerAccount) {
    throw ApiError.conflict(
      'member_near_missing',
      'Link a NEAR account before confirming this tip',
    );
  }
  if (!preview.pay_to || !isNearAccountId(preview.pay_to)) {
    throw ApiError.conflict(
      'fronter_near_missing',
      'The fronter has no NEAR account to receive this tip',
    );
  }

  // The tip was quoted when it was requested; settle against that frozen
  // integer so a rate that moved while the wallet was open cannot reject a
  // transfer the member made correctly.
  const quote = await ensureQuote({
    table: 'tips',
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

    const tip = await loadTip(tx, input.tipId, true);

    if (tip.status === 'paid') {
      return {
        tipId: tip.id,
        alreadyPaid: true,
        pointsAwarded: 0,
        explorerUrl: transfer.explorerUrl,
      };
    }

    await tx.query(
      `update tips
          set status = 'paid',
              paid_at = now(),
              settlement_tx_hash = coalesce(settlement_tx_hash, $2)
        where id = $1`,
      [tip.id, transfer.txHash],
    );

    const globie = await awardGlobie(tx, {
      agreementId: tip.agreement_id,
      groupId: tip.group_id,
      memberId: tip.from_member_id,
      shareId: null,
      reason: TIP_REASON,
      amount: TIP_GLOBIE,
    });

    await recordEvent(tx, {
      groupId: tip.group_id,
      agreementId: tip.agreement_id,
      memberId: tip.from_member_id,
      eventType: 'tip.paid',
      amountMinor: tip.amount,
      currency: tip.currency.trim(),
      actor: tip.from_member_name,
      summary:
        globie.delta > 0
          ? `${tip.from_member_name} tipped ${tip.to_member_name} — +${globie.delta} Globie`
          : `${tip.from_member_name} tipped ${tip.to_member_name}`,
      metadata: {
        rail: 'near_transfer',
        tip_id: tip.id,
        to_member_id: tip.to_member_id,
        message: tip.message,
        globie: globie.delta,
        tx_hash: transfer.txHash,
      },
    });

    return {
      tipId: tip.id,
      alreadyPaid: false,
      pointsAwarded: globie.delta,
      explorerUrl: transfer.explorerUrl,
    };
  });
}
