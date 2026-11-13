/**
 * Late fees: the fronter raises the agreed penalty on an overdue share, and the
 * member who owes it pays it over NEAR like a share. The rule itself is set
 * when the agreement is created, so the card here only displays it.
 */

import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/pool.js';
import {
    isFronter,
    requireBillMember,
    requireFronter,
    requireInterestMember
} from '../lib/access.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import {
    listInterestCharges,
    raiseInterest,
    settleInterest
} from '../lib/interest.js';
import { isNearConfigured } from '../lib/near.js';
import { mapInterestCharge } from '../lib/serialize.js';
import { ensureQuote } from '../lib/settlement-quote.js';
import { asRecord, pathUuid, requiredUuid } from '../lib/validate.js';

/** Shares exist once the bill is finalized, and stay claimable while collecting. */
const CHARGEABLE = new Set(['FINALIZED', 'COLLECTING']);

/**
 * Base58 of a 32-byte hash is 43 or 44 characters. This only screens out junk
 * before the RPC sees it; the node still rejects hashes that decode to the
 * wrong byte length, which `getTransferStatus` reports as "not found".
 */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

type BillParams = { Params: { id: string } };
type ChargeParams = { Params: { id: string } };

/**
 * The agreed rule plus who fronted the bill. `fronted_by` is set at creation;
 * falling back to `created_by` keeps older rows consistent with the tips card.
 */
async function loadRule(agreementId: string): Promise<{
  mode: 'none' | 'monthly';
  rateBps: number | null;
  capBps: number | null;
  frontedBy: string | null;
  frontedByName: string;
}> {
  const { rows } = await query<{
    interest_mode: string;
    interest_rate_bps: number | null;
    interest_cap_bps: number | null;
    fronted_by: string | null;
    fronted_name: string;
  }>(
    `select a.interest_mode, a.interest_rate_bps, a.interest_cap_bps,
            a.fronted_by,
            coalesce(fu.display_name, cu.display_name) as fronted_name
       from agreements a
       left join members fm on fm.id = a.fronted_by
       left join users fu on fu.id = fm.user_id
       join members cm on cm.id = a.created_by
       join users cu on cu.id = cm.user_id
      where a.id = $1`,
    [agreementId],
  );

  const row = rows[0];
  return {
    mode: row?.interest_mode === 'monthly' ? 'monthly' : 'none',
    rateBps: row?.interest_rate_bps ?? null,
    capBps: row?.interest_cap_bps ?? null,
    frontedBy: row?.fronted_by ?? null,
    frontedByName: row?.fronted_name ?? 'the fronter',
  };
}

export const interestRoutes: FastifyPluginAsync = async (app) => {
  app.get<BillParams>('/bills/:id/interest', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    const rule = await loadRule(ctx.agreementId);

    const rows = await listInterestCharges(billId);

    // A requested charge is one wallet transfer away, so it must carry a USDC
    // number. Anything raised before quotes were frozen gets one here rather
    // than rendering an instruction with no amount.
    const quotes = new Map<string, { amount: string; rate: number; asOf: string }>();
    for (const row of rows) {
      if (row.status === 'requested' && row.quoted_chain_amount === null) {
        quotes.set(
          row.id,
          await ensureQuote({
            table: 'interest_charges',
            id: row.id,
            amountMinor: row.amount,
            currency: row.currency,
            stored: row,
          }),
        );
      }
    }

    const charges = rows.map((row) => {
      const charge = mapInterestCharge(row);
      const quote = quotes.get(row.id);
      return {
        ...charge,
        chainAmount: quote?.amount ?? charge.chainAmount,
        quoteRate: quote?.rate ?? charge.quoteRate,
        quoteAsOf: quote?.asOf ?? charge.quoteAsOf,
        /** Only the debtor pays, and only while the fee is open. */
        canPay:
          charge.memberId === ctx.member.id &&
          charge.status === 'requested' &&
          isNearConfigured(),
        tokenContract: config.near.usdcContract || null,
      };
    });

    return {
      billId,
      currency: ctx.currency,
      frontedBy: rule.frontedBy,
      frontedByName: rule.frontedByName,
      mode: rule.mode,
      rateBps: rule.rateBps,
      capBps: rule.capBps,
      /** The fronter may raise a fee only where the rule exists and shares live. */
      canRaise:
        rule.mode === 'monthly' &&
        isFronter({ frontedBy: ctx.frontedBy, member: ctx.member }) &&
        CHARGEABLE.has(ctx.status),
      totalMinor: charges
        .filter((charge) => charge.status === 'paid')
        .reduce((sum, charge) => sum + charge.amountMinor, 0),
      charges,
    };
  });

  /** Only the fronter may raise the agreed fee, and only after `due_at`. */
  app.post<BillParams>('/bills/:id/interest', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter({ frontedBy: ctx.frontedBy, member: ctx.member });

    if (!CHARGEABLE.has(ctx.status)) {
      throw ApiError.conflict(
        'bill_not_finalized',
        'Late fees open once the bill is finalized and a share has a due date',
      );
    }

    const body = asRecord(request.body);
    const shareId = requiredUuid(body, 'shareId');

    const charge = await raiseInterest({
      billId,
      agreementId: ctx.agreementId,
      groupId: ctx.groupId,
      currency: ctx.currency,
      shareId,
      fronterMemberId: ctx.member.id,
      actor: ctx.member.displayName,
    });

    return { interest: mapInterestCharge(charge) };
  });

  /** The member who owes the fee pastes the hash; the chain decides. */
  app.post<ChargeParams>('/interest/:id/settle', async (request) => {
    const chargeId = pathUuid(request.params.id);
    const ctx = await requireInterestMember(request, chargeId);
    const body = asRecord(request.body);
    const txHash = body.txHash;

    if (typeof txHash !== 'string' || !TX_HASH.test(txHash.trim())) {
      throw ApiError.badRequest(
        'invalid_txHash',
        'txHash must be the base58 hash of the NEP-141 transfer',
      );
    }

    const result = await settleInterest({
      chargeId,
      txHash: txHash.trim(),
      actor: ctx.member.displayName,
    });

    return {
      chargeId,
      status: 'paid' as const,
      alreadyPaid: result.alreadyPaid,
      explorerUrl: result.explorerUrl,
    };
  });
};
