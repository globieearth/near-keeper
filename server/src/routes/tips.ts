/**
 * "Give a tip" (DEV_PLAN §2.18). Anyone in the group may tip the person who
 * fronted the bill; the tip is proven from a NEAR receipt like a share, but it
 * never touches the bill's settlement state.
 */

import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/pool.js';
import { requireBillMember, requireTipMember } from '../lib/access.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import { isNearConfigured } from '../lib/near.js';
import { mapTip } from '../lib/serialize.js';
import { ensureQuote } from '../lib/settlement-quote.js';
import { listTips, requestTip, settleTip } from '../lib/tips.js';
import {
    asRecord,
    optionalString,
    pathUuid,
    requiredMinor,
} from '../lib/validate.js';

/** The fronter has already paid, so a tip is only meaningful from here on. */
const TIPPABLE = new Set(['FINALIZED', 'COLLECTING', 'SETTLED']);

/**
 * Base58 of a 32-byte hash is 43 or 44 characters. This only screens out junk
 * before the RPC sees it; the node still rejects hashes that decode to the
 * wrong byte length, which `getTransferStatus` reports as "not found".
 */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

type BillParams = { Params: { id: string } };
type TipParams = { Params: { id: string } };

/**
 * Who fronted the agreement and what to call them. `fronted_by` is set when the
 * agreement is created; falling back to `created_by` keeps older rows tippable.
 */
async function loadFronter(
  agreementId: string,
): Promise<{ id: string | null; name: string }> {
  const { rows } = await query<{ fronted_by: string | null; fronted_name: string }>(
    `select a.fronted_by,
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
    id: row?.fronted_by ?? null,
    name: row?.fronted_name ?? 'the fronter',
  };
}

export const tipRoutes: FastifyPluginAsync = async (app) => {
  app.get<BillParams>('/bills/:id/tips', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    const fronter = await loadFronter(ctx.agreementId);

    const tipRows = await listTips(billId);
    const tips = tipRows.map(mapTip);
    const myRow = tipRows.find((tip) => tip.from_member_id === ctx.member.id) ?? null;
    const myTip = myRow ? tips.find((tip) => tip.id === myRow.id) ?? null : null;

    // A requested tip is one wallet transfer away, so it must have a USDC
    // number. Tips created before quotes were frozen get one here instead of
    // the card rendering an instruction with no amount.
    const myQuote =
      myRow && myTip?.status === 'requested'
        ? await ensureQuote({
            table: 'tips',
            id: myRow.id,
            amountMinor: myRow.amount,
            currency: myRow.currency,
            stored: myRow,
          })
        : null;

    return {
      billId,
      currency: ctx.currency,
      frontedBy: fronter.id,
      frontedByName: fronter.name,
      canTip: TIPPABLE.has(ctx.status) && fronter.id !== ctx.member.id,
      totalMinor: tips
        .filter((tip) => tip.status === 'paid')
        .reduce((sum, tip) => sum + tip.amountMinor, 0),
      myTip: myTip
        ? {
            ...myTip,
            /** A pending tip is one wallet transfer away from being settled. */
            canFinish: myTip.status === 'requested' && isNearConfigured(),
            tokenContract: config.near.usdcContract || null,
            chainAmount: myQuote?.amount ?? myTip.chainAmount,
            quoteRate: myQuote?.rate ?? myTip.quoteRate,
            quoteAsOf: myQuote?.asOf ?? myTip.quoteAsOf,
            memo: `globie:tip:${myTip.id}`,
          }
        : null,
      tips,
    };
  });

  app.post<BillParams>('/bills/:id/tips', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    const body = asRecord(request.body);

    if (!TIPPABLE.has(ctx.status)) {
      throw ApiError.conflict(
        'bill_not_finalized',
        'Tips open once the bill is finalized and the fronter has paid',
      );
    }

    const fronter = await loadFronter(ctx.agreementId);

    if (!fronter.id) {
      throw ApiError.conflict(
        'fronter_missing',
        'This bill has no fronter to tip',
      );
    }

    if (fronter.id === ctx.member.id) {
      throw ApiError.conflict(
        'cannot_tip_self',
        'You fronted this bill — you cannot tip yourself',
      );
    }

    const amountMinor = requiredMinor(body, 'amountMinor');
    if (amountMinor <= 0) {
      throw ApiError.badRequest('invalid_amountMinor', 'A tip must be above zero');
    }

    return requestTip({
      billId,
      agreementId: ctx.agreementId,
      groupId: ctx.groupId,
      currency: ctx.currency,
      fromMember: { id: ctx.member.id, displayName: ctx.member.displayName },
      toMemberId: fronter.id,
      toMemberName: fronter.name,
      amountMinor,
      message: optionalString(body, 'message', 200),
    });
  });

  /** The tipper pastes the hash their wallet produced; the chain decides. */
  app.post<TipParams>('/tips/:id/settle', async (request) => {
    const tipId = pathUuid(request.params.id);
    const ctx = await requireTipMember(request, tipId);
    const body = asRecord(request.body);
    const txHash = body.txHash;

    if (typeof txHash !== 'string' || !TX_HASH.test(txHash.trim())) {
      throw ApiError.badRequest(
        'invalid_txHash',
        'txHash must be the base58 hash of the NEP-141 transfer',
      );
    }

    const result = await settleTip({
      tipId,
      txHash: txHash.trim(),
      actor: ctx.member.displayName,
    });

    return {
      tipId,
      status: 'paid' as const,
      alreadyPaid: result.alreadyPaid,
      pointsAwarded: result.pointsAwarded,
      explorerUrl: result.explorerUrl,
    };
  });
};
