/**
 * Bill reads plus detached receipt extraction, shared by the REST routes and
 * the agent tools so the two cannot drift. Collection lives in
 * `lib/near-settlement.ts`.
 */

import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import { query, withTransaction } from '../db/pool.js';
import { config } from './config.js';
import { ApiError } from './http-error.js';
import { recordEvent } from './ledger.js';
import { cleanupWorkDir, extractReceipt, type MediaInput } from './receipt.js';
import type {
  AllocationRow,
  BillItemRow,
  BillRow,
  ShareRow,
} from './serialize.js';

/** Nothing may change a bill once it has been finalized. */
export const LOCKED = new Set([
  'FINALIZED',
  'COLLECTING',
  'SETTLED',
  'CANCELLED',
]);

type MediaRow = {
  id: string;
  kind: string;
  storage_key: string;
  mime_type: string | null;
};

export function mediaPath(storageKey: string): string {
  return path.resolve(config.mediaDir, storageKey);
}

export async function loadBill(
  billId: string,
): Promise<{ bill: BillRow; items: BillItemRow[] }> {
  const { rows } = await query<BillRow>(`select b.* from bills b where b.id = $1`, [
    billId,
  ]);
  const bill = rows[0];
  if (!bill) throw ApiError.notFound('Bill not found');

  const items = await query<BillItemRow>(
    `select id, name, qty, unit_price, line_total, confidence, kind, unit
       from bill_items
      where bill_id = $1
      order by created_at asc`,
    [billId],
  );
  return { bill, items: items.rows };
}

export async function loadAllocations(billId: string): Promise<AllocationRow[]> {
  const { rows } = await query<AllocationRow>(
    `select al.id, al.bill_item_id, al.member_id,
            u.display_name as member_name, bi.name as item_name,
            al.qty, al.amount, al.status
       from allocations al
       join bill_items bi on bi.id = al.bill_item_id
       join members m on m.id = al.member_id
       join users u on u.id = m.user_id
      where bi.bill_id = $1
      order by bi.created_at asc, al.created_at asc`,
    [billId],
  );
  return rows;
}

export async function loadShares(billId: string): Promise<ShareRow[]> {
  const { rows } = await query<ShareRow>(
    `select s.id, s.bill_id, a.id as agreement_id, a.group_id, g.name as group_name,
            s.member_id, u.display_name as member_name,
            s.amount, s.currency, s.status, s.due_at, s.paid_at,
            s.settlement_tx_hash, s.created_at,
            s.quoted_chain_amount, s.quote_rate, s.quote_as_of,
            coalesce(
              case when fu.near_verified then fm.near_account end,
              case when fu.near_verified then fu.near_account end,
              a.treasury_account
            ) as pay_to
       from shares s
       join bills b on b.id = s.bill_id
       join agreements a on a.id = b.agreement_id
       join groups g on g.id = a.group_id
       join members m on m.id = s.member_id
       join users u on u.id = m.user_id
       left join members fm on fm.id = a.fronted_by
       left join users fu on fu.id = fm.user_id
      where s.bill_id = $1
      order by s.created_at asc`,
    [billId],
  );
  return rows;
}

export async function loadShareById(shareId: string): Promise<ShareRow> {
  const { rows } = await query<ShareRow>(
    `select s.id, s.bill_id, a.id as agreement_id, a.group_id, g.name as group_name,
            s.member_id, u.display_name as member_name,
            s.amount, s.currency, s.status, s.due_at, s.paid_at,
            s.settlement_tx_hash, s.created_at
       from shares s
       join bills b on b.id = s.bill_id
       join agreements a on a.id = b.agreement_id
       join groups g on g.id = a.group_id
       join members m on m.id = s.member_id
       join users u on u.id = m.user_id
      where s.id = $1`,
    [shareId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('Share not found');
  return row;
}

/**
 * Detached receipt extraction. The route answers `PARSING` immediately and the
 * client polls `GET /bills/:id` every 1.5 s until the status leaves PARSING.
 */
export async function runExtraction(input: {
  billId: string;
  mediaId: string;
  agreementId: string;
  groupId: string;
  memberId: string;
  actor: string;
  currency: string;
  /** Group kind, so the vision prompt knows what document it is reading. */
  kind?: string;
  media: MediaInput;
  log: FastifyBaseLogger;
}): Promise<void> {
  const workDir = path.resolve(config.mediaDir, '.work', input.billId);

  try {
    const result = await extractReceipt([input.media], workDir, input.currency, input.kind);
    const warnings = [
      ...new Set([...(result.draft?.warnings ?? []), ...result.warnings]),
    ];
    const draft = result.draft;

    if (!draft) {
      await query(
        `update bills
            set status = 'UPLOADED', warnings = $2::jsonb, frames_extracted = $3,
                raw_extraction = null, parsed_at = now()
          where id = $1`,
        [input.billId, JSON.stringify(warnings), result.framesExtracted],
      );
      await query(`update bill_media set status = 'failed' where id = $1`, [
        input.mediaId,
      ]);
      return;
    }

    /**
     * The receipt's currency wins. Its printed amounts are the only money this
     * bill can prove, so stamping them with the group's default would misstate
     * the debt — a THB receipt opened against a USD agreement would read
     * ฿280 as $280. Nothing is converted here: shares are quoted to USDC from
     * the bill's own currency by lib/settlement-quote.ts. A finalized bill
     * cannot be re-parsed, so no share exists yet when this runs.
     */
    const currency = draft.currency;
    if (currency !== input.currency) {
      warnings.push(
        `Receipt is printed in ${currency}; this bill was opened in ${input.currency} and now follows the receipt.`,
      );
    }

    await withTransaction(async (tx) => {
      // Re-parsing replaces the item list; allocations cascade with it.
      await tx.query(`delete from bill_items where bill_id = $1`, [input.billId]);

      for (const item of draft.items) {
        await tx.query(
          `insert into bill_items (bill_id, name, qty, unit_price, line_total, confidence, kind, unit)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.billId,
            item.name.slice(0, 160),
            item.qty,
            item.unitPriceMinor,
            item.lineTotalMinor,
            item.confidence,
            item.kind ?? null,
            item.unit ?? null,
          ],
        );
      }

      await tx.query(
        `update bills
            set merchant = $2, currency = $12, subtotal = $3, tax = $4, service_charge = $5,
                tip = $6, discount = $7, total = $8, status = 'PARSED', warnings = $9::jsonb,
                frames_extracted = $10, raw_extraction = $11::jsonb, parsed_at = now()
          where id = $1`,
        [
          input.billId,
          draft.merchant,
          draft.subtotalMinor,
          draft.taxMinor,
          draft.serviceChargeMinor,
          draft.tipMinor,
          draft.discountMinor,
          draft.totalMinor,
          JSON.stringify(warnings),
          result.framesExtracted,
          JSON.stringify(draft),
          currency,
        ],
      );

      await tx.query(
        `update bill_media set status = 'extracted', frames_extracted = $2 where id = $1`,
        [input.mediaId, result.framesExtracted],
      );

      await recordEvent(tx, {
        groupId: input.groupId,
        agreementId: input.agreementId,
        memberId: input.memberId,
        eventType: 'bill.parsed',
        amountMinor: draft.totalMinor,
        currency,
        actor: input.actor,
        summary: `${input.actor} captured the receipt — ${draft.items.length} lines read`,
        metadata: { frames: result.framesExtracted },
      });
    });
  } catch (error) {
    input.log.error({ err: error, billId: input.billId }, 'receipt extraction failed');
    await query(
      `update bills
          set status = 'UPLOADED', warnings = $2::jsonb, parsed_at = now()
        where id = $1`,
      [
        input.billId,
        JSON.stringify(['Receipt AI could not read this upload — try again.']),
      ],
    ).catch(() => undefined);
    await query(`update bill_media set status = 'failed' where id = $1`, [
      input.mediaId,
    ]).catch(() => undefined);
  } finally {
    await cleanupWorkDir(workDir);
  }
}

/**
 * Flag the bill as PARSING and start extraction. The REST route returns
 * immediately; the agent tool passes `wait: true` because its contract is
 * `parse_receipt_media -> { items[], totals, ... }`.
 */
export async function startBillParse(input: {
  billId: string;
  agreementId: string;
  groupId: string;
  memberId: string;
  actor: string;
  currency: string;
  log: FastifyBaseLogger;
  wait?: boolean;
}): Promise<{ status: string; mediaId: string | null }> {
  const { rows: billRows } = await query<{ source: string; kind: string; status: string }>(
    `select source, kind, status from bills where id = $1`,
    [input.billId],
  );
  const bill = billRows[0];
  if (!bill) throw ApiError.notFound('Bill not found');

  const { rows } = await query<MediaRow>(
    `select id, kind, storage_key, mime_type
       from bill_media
      where bill_id = $1
      order by created_at desc
      limit 1`,
    [input.billId],
  );
  const media = rows[0];
  if (!media) {
    // A bill typed in by hand (or a quantity claim) has nothing to extract.
    // Re-parsing it is a no-op, not an error.
    if (bill.source !== 'receipt_vision') {
      return { status: bill.status, mediaId: null };
    }
    throw ApiError.conflict('media_missing', 'Upload a receipt photo or video first');
  }

  await query(
    `update bills
        set status = 'PARSING', warnings = '[]'::jsonb, frames_extracted = 0
      where id = $1`,
    [input.billId],
  );

  const extraction = runExtraction({
    billId: input.billId,
    mediaId: media.id,
    agreementId: input.agreementId,
    groupId: input.groupId,
    memberId: input.memberId,
    actor: input.actor,
    currency: input.currency,
    kind: bill.kind,
    media: {
      kind: media.kind === 'video' ? 'video' : 'photo',
      path: mediaPath(media.storage_key),
      mimeType: media.mime_type,
    },
    log: input.log,
  });

  if (input.wait) await extraction;
  else void extraction;

  return { status: 'PARSING', mediaId: media.id };
}

