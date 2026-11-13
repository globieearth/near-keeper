import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';

import { query, withTransaction } from '../db/pool.js';
import {
    requireAgreementMember,
    requireBillMember,
    requireFronter,
} from '../lib/access.js';
import {
    LOCKED,
    loadAllocations,
    loadBill,
    loadShares,
    mediaPath,
    startBillParse,
} from '../lib/bills.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import { listInterestCharges } from '../lib/interest.js';
import { BILL_SOURCES, SPLIT_VOTES, type BillSource } from '../lib/kinds.js';
import { recordEvent } from '../lib/ledger.js';
import { allocate, formatAmount } from '../lib/money.js';
import {
    requestTransferForShare,
    type TransferRequest,
} from '../lib/near-settlement.js';
import {
    mapAllocation,
    mapBill,
    mapInterestCharge,
    mapShare,
    type AllocationRow,
    type BillRow,
} from '../lib/serialize.js';
import { quoteFromRow } from '../lib/settlement-quote.js';
import { awardFrontedGlobie } from '../lib/settlement.js';
import { castBillSplitVote, loadBillSplitSummary } from '../lib/split-vote.js';
import {
    asRecord,
    currencyCode,
    enumValue,
    optionalString,
    pathUuid,
    requiredString,
    requiredUuid,
} from '../lib/validate.js';

type BillParams = { Params: { id: string } };
type AllocationParams = { Params: { id: string } };

/** Bills in these states can still be re-split. */
const EDITABLE = "('UPLOADED', 'PARSING', 'PARSED', 'ALLOCATED', 'CONFIRMED')";

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

const FILE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
]);

type BillItemTotalRow = { id: string; line_total: number };

/** An existing line, before the fronter's correction is applied. */
type PriorItemRow = {
  id: string;
  name: string;
  qty: string | number;
  unit_price: number;
  line_total: number;
  kind: string | null;
  unit: string | null;
};

/** `qty` is numeric and `amount` is bigint, so pg hands both back as strings. */
type PriorAllocationRow = {
  id: string;
  bill_item_id: string;
  member_id: string;
  qty: string | number;
  amount: string | number;
  status: string;
};

type AllocationConfirmRow = {
  id: string;
  bill_item_id: string;
  member_id: string;
  amount: number;
  status: string;
  bill_id: string;
  group_id: string;
  currency: string;
  bill_status: string;
};

function extensionFor(mimeType: string, filename: string, kind: 'photo' | 'video'): string {
  const fromMime = MEDIA_EXTENSIONS[mimeType];
  if (fromMime) return fromMime;

  const fromName = path.extname(filename).toLowerCase();
  if (FILE_EXTENSIONS.has(fromName)) return fromName;

  return kind === 'video' ? '.mp4' : '.jpg';
}

async function loadAllocation(allocationId: string): Promise<AllocationRow> {
  const { rows } = await query<AllocationRow>(
    `select al.id, al.bill_item_id, al.member_id,
            u.display_name as member_name, bi.name as item_name,
            al.qty, al.amount, al.status
       from allocations al
       join bill_items bi on bi.id = al.bill_item_id
       join members m on m.id = al.member_id
       join users u on u.id = m.user_id
      where al.id = $1`,
    [allocationId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('Allocation not found');
  return row;
}

type InlineItem = {
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  kind: string | null;
  unit: string | null;
};

/**
 * Read the lines a member typed instead of photographed — a rent split, a
 * group-buy order, a shared subscription. A hand-typed line is not less
 * certain than a scanned one, so it enters at confidence 1.
 */
function parseInlineItems(raw: unknown): InlineItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw ApiError.badRequest('missing_items', 'Send at least one line item');
  }
  if (raw.length > 200) {
    throw ApiError.badRequest('invalid_items', 'Too many line items in one bill');
  }

  return raw.map((entry) => {
    const record = asRecord(entry);
    const name = requiredString(record, 'name', { max: 160 });

    const qtyValue = record.qty;
    const qty =
      typeof qtyValue === 'number' && Number.isFinite(qtyValue) && qtyValue >= 0
        ? Math.min(Math.round(qtyValue * 100) / 100, 9999)
        : 1;

    const totalValue = record.lineTotalMinor;
    const unitValue = record.unitPriceMinor;
    const hasTotal =
      typeof totalValue === 'number' && Number.isSafeInteger(totalValue) && totalValue >= 0;
    const hasUnit =
      typeof unitValue === 'number' && Number.isSafeInteger(unitValue) && unitValue >= 0;

    const lineTotalMinor = hasTotal
      ? (totalValue as number)
      : hasUnit
        ? Math.round((unitValue as number) * qty)
        : 0;

    const unitPriceMinor = hasUnit
      ? (unitValue as number)
      : qty > 0
        ? Math.round(lineTotalMinor / qty)
        : lineTotalMinor;

    return {
      name,
      qty,
      unitPriceMinor,
      lineTotalMinor,
      kind: optionalString(record, 'kind', 32),
      unit: optionalString(record, 'unit', 24),
    };
  });
}

export const billRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Open a bill for an agreement. `receipt_vision` (the default) waits for a
   * photo or video and has it read; `manual` and `quantity_claim` arrive with
   * their lines already typed, so they book straight to PARSED and skip
   * extraction entirely.
   */
  app.post('/bills', async (request) => {
    const body = asRecord(request.body);
    const agreementId = requiredUuid(body, 'agreementId');
    const ctx = await requireAgreementMember(request, agreementId);

    requireFronter(ctx);

    if (ctx.status === 'cancelled' || ctx.status === 'settled') {
      throw ApiError.conflict('agreement_closed', 'This agreement is closed');
    }

    const currency =
      body.currency === undefined ? ctx.currency : currencyCode(body.currency);
    const source = enumValue<BillSource>(
      body,
      'source',
      BILL_SOURCES,
      'receipt_vision',
    );
    const title = optionalString(body, 'title', 160);
    const items = source === 'receipt_vision' ? [] : parseInlineItems(body.items);
    const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
    const status = source === 'receipt_vision' ? 'UPLOADED' : 'PARSED';

    const bill = await withTransaction(async (tx) => {
      const { rows } = await tx.query<BillRow>(
        `insert into bills
           (agreement_id, currency, status, kind, source, title, merchant,
            subtotal, total, parsed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
         returning id, agreement_id, merchant, currency, subtotal, tax, service_charge,
                   tip, discount, total, status, warnings, frames_extracted,
                   kind, source, title`,
        [
          agreementId,
          currency,
          status,
          ctx.kind,
          source,
          title,
          title,
          subtotalMinor,
          source === 'receipt_vision' ? null : new Date(),
        ],
      );
      const inserted = rows[0];
      if (!inserted) throw new ApiError(500, 'bill_insert_failed', 'Could not open the bill');

      for (const item of items) {
        await tx.query(
          `insert into bill_items
             (bill_id, name, qty, unit_price, line_total, confidence, kind, unit)
           values ($1, $2, $3, $4, $5, 1, $6, $7)`,
          [
            inserted.id,
            item.name,
            item.qty,
            item.unitPriceMinor,
            item.lineTotalMinor,
            item.kind,
            item.unit,
          ],
        );
      }

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId,
        memberId: ctx.member.id,
        eventType: 'bill.created',
        amountMinor: subtotalMinor,
        currency,
        actor: ctx.member.displayName,
        summary:
          source === 'receipt_vision'
            ? `${ctx.member.displayName} is capturing the receipt`
            : `${ctx.member.displayName} entered ${title ?? 'the bill'} by hand — ${
                items.length
              } line${items.length === 1 ? '' : 's'}`,
      });

      return inserted;
    });

    const loaded = await loadBill(bill.id);
    return { bill: mapBill(loaded.bill, loaded.items) };
  });

  /** Store a receipt photo or video on disk. `kind` may arrive before or after the file. */
  app.post<BillParams>('/bills/:id/media', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);
    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    let kind: 'photo' | 'video' | null = null;
    let bytes: Buffer | null = null;
    let mimeType: string | null = null;
    let filename = '';

    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'kind') {
          const value = String(part.value).trim().toLowerCase();
          if (value === 'photo' || value === 'video') kind = value;
        }
        continue;
      }

      if (part.fieldname !== 'file') {
        await part.toBuffer();
        continue;
      }

      bytes = await part.toBuffer();
      mimeType = part.mimetype ? part.mimetype.toLowerCase() : null;
      filename = part.filename ?? '';
    }

    if (!bytes || bytes.length === 0) {
      throw ApiError.badRequest('missing_file', 'Attach the receipt as `file`');
    }

    if (!kind) {
      if (mimeType?.startsWith('video/')) kind = 'video';
      else if (mimeType?.startsWith('image/')) kind = 'photo';
      else throw ApiError.badRequest('invalid_kind', 'kind must be `photo` or `video`');
    }

    if (mimeType && mimeType !== 'application/octet-stream') {
      if (kind === 'photo' && !mimeType.startsWith('image/')) {
        throw ApiError.badRequest('invalid_file_type', 'A photo receipt must be an image');
      }
      if (kind === 'video' && !mimeType.startsWith('video/')) {
        throw ApiError.badRequest('invalid_file_type', 'A video receipt must be a video');
      }
    }

    const mediaId = randomUUID();
    const storageKey = `${billId}/${mediaId}${extensionFor(mimeType ?? '', filename, kind)}`;
    const target = mediaPath(storageKey);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);

    await query(
      `insert into bill_media (id, bill_id, kind, storage_key, mime_type, status)
       values ($1, $2, $3, $4, $5, 'stored')`,
      [mediaId, billId, kind, storageKey, mimeType],
    );

    return { mediaId, status: 'stored' };
  });

  /** Kick off extraction; the response returns before the vision call finishes. */
  app.post<BillParams>('/bills/:id/parse', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }
    if (ctx.status === 'PARSING') return { status: 'PARSING' };

    return startBillParse({
      billId,
      agreementId: ctx.agreementId,
      groupId: ctx.groupId,
      memberId: ctx.member.id,
      actor: ctx.member.displayName,
      currency: ctx.currency,
      log: request.log,
    });
  });

  app.get<BillParams>('/bills/:id', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);

    const [bill, allocations, shares, interest, splitVote] = await Promise.all([
      loadBill(billId),
      loadAllocations(billId),
      loadShares(billId),
      listInterestCharges(billId),
      loadBillSplitSummary({
        billId,
        agreementId: ctx.agreementId,
        groupId: ctx.groupId,
        storedMode: ctx.splitMode,
        frontedBy: ctx.frontedBy,
        memberId: ctx.member.id,
      }),
    ]);

    return {
      bill: mapBill(bill.bill, bill.items),
      allocations: allocations.map(mapAllocation),
      // The quote and the payee travel with each share so a fronter who
      // reloads the bill still sees the transfers they already requested.
      shares: shares.map((share) => ({
        ...mapShare(share),
        tokenContract: config.near.usdcContract || null,
      })),
      // A late fee is money owed on top of the share; the bill screen must
      // show it before anybody settles, not after.
      interestCharges: interest.map((charge) => ({
        ...mapInterestCharge(charge),
        tokenContract: config.near.usdcContract || null,
      })),
      /** How this bill is divided: the winning vote, the tally, and my vote. */
      splitVote,
    };
  });

  /**
   * Any member may vote on how this one bill is divided. It is deliberately not
   * `requireFronter`: the point of the vote is that the person who paid does
   * not choose alone. The winner is computed on read (lib/split-vote.ts), so a
   * second vote replaces the first without leaving stale tallies behind.
   */
  app.post<BillParams>('/bills/:id/split-vote', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    const body = asRecord(request.body);
    const mode = enumValue(body, 'mode', SPLIT_VOTES);
    await castBillSplitVote({ billId, memberId: ctx.member.id, mode });

    const splitVote = await loadBillSplitSummary({
      billId,
      agreementId: ctx.agreementId,
      groupId: ctx.groupId,
      storedMode: ctx.splitMode,
      frontedBy: ctx.frontedBy,
      memberId: ctx.member.id,
    });

    await recordEvent({ query }, {
      groupId: ctx.groupId,
      agreementId: ctx.agreementId,
      memberId: ctx.member.id,
      eventType: 'bill.split_voted',
      currency: ctx.currency,
      actor: ctx.member.displayName,
      summary: `${ctx.member.displayName} voted to split ${
        mode === 'equal' ? 'evenly' : 'by line item'
      }`,
      metadata: { mode, resolvedMode: splitVote.resolvedMode },
    });

    return { splitVote };
  });

  /** RFC 4180 cell: quote only when the text would otherwise break the row. */
  function csvCell(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  /**
   * The bill as a spreadsheet. A fronter moves real money, so the ledger has to
   * leave the app in a shape an accountant can open: one row per share, integer
   * minor units *and* the decimal amount, plus the transfer that settled it.
   * Same member gate as `GET /bills/:id` — it already returns every share.
   */
  app.get<BillParams>('/bills/:id/export.csv', async (request, reply) => {
    const billId = pathUuid(request.params.id);
    await requireBillMember(request, billId);

    const [bill, shares] = await Promise.all([loadBill(billId), loadShares(billId)]);
    const title = (bill.bill.title ?? bill.bill.merchant ?? '').trim();

    const header = [
      'bill_id',
      'bill_title',
      'currency',
      'member',
      'near_account',
      'amount_minor',
      'amount',
      'status',
      'usdc_amount',
      'quote_rate',
      'quote_as_of',
      'tx_hash',
      'paid_at',
    ];

    const rows = shares.map((share) => {
      const quote = quoteFromRow(share);
      return [
        billId,
        title,
        share.currency.trim(),
        share.member_name,
        share.pay_to ?? '',
        String(share.amount),
        formatAmount(Number(share.amount), share.currency),
        share.status,
        quote?.amount ?? '',
        quote?.rate ?? '',
        quote?.asOf ?? '',
        share.settlement_tx_hash ?? '',
        share.paid_at ? new Date(share.paid_at).toISOString() : '',
      ];
    });

    const body = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');

    // The BOM keeps Excel from reading a UTF-8 file as the local codepage, which
    // would mangle the Thai member names this app is built around.
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="bill-${billId.slice(0, 8)}.csv"`)
      .header('Cache-Control', 'private, no-store')
      .send(`\uFEFF${body}\r\n`);
  });

  /** Replace the whole split. Amounts are largest-remainder per line item. */
  app.patch<BillParams>('/bills/:id/allocations', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    const body = asRecord(request.body);
    const raw = body.allocations;
    if (!Array.isArray(raw)) {
      throw ApiError.badRequest('invalid_allocations', 'allocations must be an array');
    }
    if (raw.length > 500) {
      throw ApiError.badRequest('invalid_allocations', 'Too many allocations in one request');
    }

    const entries = raw.map((entry) => {
      const record = asRecord(entry);
      const billItemId = requiredUuid(record, 'billItemId');
      const memberId = requiredUuid(record, 'memberId');
      const qtyValue = record.qty;
      const qty =
        typeof qtyValue === 'number' && Number.isFinite(qtyValue) && qtyValue > 0
          ? Math.min(Math.round(qtyValue * 100) / 100, 99)
          : 1;
      return { billItemId, memberId, qty };
    });

    const { rows: itemRows } = await query<BillItemTotalRow>(
      `select id, line_total from bill_items where bill_id = $1`,
      [billId],
    );
    if (itemRows.length === 0) {
      throw ApiError.conflict('bill_empty', 'This bill has no items yet');
    }
    const lineTotals = new Map(itemRows.map((row) => [row.id, row.line_total]));

    const { rows: memberRows } = await query<{ id: string }>(
      `select id from members where group_id = $1 and status <> 'removed'`,
      [ctx.groupId],
    );
    const memberIds = new Set(memberRows.map((row) => row.id));

    const grouped = new Map<
      string,
      { billItemId: string; memberId: string; qty: number }[]
    >();
    for (const entry of entries) {
      if (!lineTotals.has(entry.billItemId)) {
        throw ApiError.badRequest(
          'invalid_billItemId',
          'An item does not belong to this bill',
        );
      }
      if (!memberIds.has(entry.memberId)) {
        throw ApiError.badRequest(
          'invalid_memberId',
          'A member does not belong to this group',
        );
      }

      const list = grouped.get(entry.billItemId) ?? [];
      if (list.some((item) => item.memberId === entry.memberId)) continue;
      list.push(entry);
      grouped.set(entry.billItemId, list);
    }

    await withTransaction(async (tx) => {
      const { rows: priorRows } = await tx.query<PriorAllocationRow>(
        `select id, bill_item_id, member_id, qty, amount, status
           from allocations
          where bill_item_id in (select id from bill_items where bill_id = $1)`,
        [billId],
      );
      const prior = new Map(
        priorRows.map((row) => [`${row.bill_item_id}:${row.member_id}`, row]),
      );
      const keep = new Set<string>();

      for (const [billItemId, list] of grouped) {
        const lineTotal = lineTotals.get(billItemId) ?? 0;
        const parts = allocate(
          lineTotal,
          list.map((item) => item.qty),
        );

        for (let index = 0; index < list.length; index += 1) {
          const entry = list[index];
          if (!entry) continue;
          const amount = parts[index] ?? 0;
          const key = `${billItemId}:${entry.memberId}`;
          keep.add(key);

          const existing = prior.get(key);
          if (!existing) {
            await tx.query(
              `insert into allocations (bill_item_id, member_id, qty, amount, status)
               values ($1, $2, $3, $4, 'proposed')`,
              [billItemId, entry.memberId, entry.qty, amount],
            );
            continue;
          }

          // A line the fronter did not actually change keeps its confirmation —
          // re-splitting somebody else's item must not undo this member's tap.
          // Only a real change to the quantity or the money sends it back.
          if (
            Number(existing.qty) === entry.qty &&
            Number(existing.amount) === amount
          ) {
            continue;
          }

          await tx.query(
            `update allocations set qty = $2, amount = $3, status = 'proposed'
              where id = $1`,
            [existing.id, entry.qty, amount],
          );
        }
      }

      const dropped = priorRows
        .filter((row) => !keep.has(`${row.bill_item_id}:${row.member_id}`))
        .map((row) => row.id);
      if (dropped.length > 0) {
        await tx.query(`delete from allocations where id = any($1::uuid[])`, [
          dropped,
        ]);
      }

      const { rows: countRows } = await tx.query<{
        total: number;
        proposed: number;
      }>(
        `select count(*)::int as total,
                count(*) filter (where al.status = 'proposed')::int as proposed
           from allocations al
           join bill_items bi on bi.id = al.bill_item_id
          where bi.bill_id = $1`,
        [billId],
      );
      const counts = countRows[0];
      const settled = (counts?.total ?? 0) > 0 && (counts?.proposed ?? 0) === 0;

      await tx.query(
        `update bills
            set status = $2, version = version + 1
          where id = $1 and status in ${EDITABLE}`,
        [billId, settled ? 'CONFIRMED' : 'ALLOCATED'],
      );

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId: ctx.agreementId,
        memberId: ctx.member.id,
        eventType: 'bill.allocated',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `${ctx.member.displayName} split the bill — each member confirms their own lines`,
      });
    });

    const allocations = await loadAllocations(billId);
    return { allocations: allocations.map(mapAllocation) };
  });

  /**
   * Correct the lines by hand — a misread item, a wrong quantity, a line the
   * scanner missed. Anything before finalize takes the change; a locked bill
   * does not. The request is the full line list: entries carrying an `id` are
   * updated in place, entries without one are added, and anything omitted is
   * deleted (its allocations cascade away with it).
   *
   * Tax, service charge, tip and discount stay exactly as printed, so the
   * subtotal is recomputed from the lines and the total from that. When the
   * money moved the bill says so in `warnings`, because the recomputed total
   * no longer matches the paper receipt the table is looking at.
   */
  app.patch<BillParams>('/bills/:id/items', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    const body = asRecord(request.body);
    const raw = body.items;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw ApiError.badRequest('missing_items', 'Send at least one line item');
    }
    if (raw.length > 200) {
      throw ApiError.badRequest('invalid_items', 'Too many line items in one bill');
    }

    const items = raw.map((entry) => {
      const record = asRecord(entry);
      const idValue = record.id;
      const id =
        typeof idValue === 'string' && idValue.trim() !== ''
          ? pathUuid(idValue, 'itemId')
          : null;
      const name = requiredString(record, 'name', { max: 160 });

      const qtyValue = record.qty;
      const qty =
        typeof qtyValue === 'number' && Number.isFinite(qtyValue) && qtyValue > 0
          ? Math.min(Math.round(qtyValue * 100) / 100, 9999)
          : 1;

      const unitValue = record.unitPriceMinor;
      const unitPriceMinor =
        typeof unitValue === 'number' &&
        Number.isSafeInteger(unitValue) &&
        unitValue >= 0
          ? unitValue
          : 0;

      return {
        id,
        name,
        qty,
        unitPriceMinor,
        lineTotalMinor: Math.round(unitPriceMinor * qty),
        unit: optionalString(record, 'unit', 24),
      };
    });

    const { rows: priorRows } = await query<PriorItemRow>(
      `select id, name, qty, unit_price, line_total, kind, unit
         from bill_items where bill_id = $1`,
      [billId],
    );
    const prior = new Map(priorRows.map((row) => [row.id, row]));

    const seen = new Set<string>();
    for (const item of items) {
      if (!item.id) continue;
      if (!prior.has(item.id)) {
        throw ApiError.badRequest(
          'invalid_itemId',
          'An item does not belong to this bill',
        );
      }
      if (seen.has(item.id)) {
        throw ApiError.badRequest('invalid_items', 'An item is listed twice');
      }
      seen.add(item.id);
    }

    const removed = priorRows.filter((row) => !seen.has(row.id));
    const priced = items.filter((item) => {
      if (!item.id) return true;
      const before = prior.get(item.id);
      return !before || Number(before.line_total) !== item.lineTotalMinor;
    });
    const moneyMoved = removed.length > 0 || priced.length > 0;

    const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);

    await withTransaction(async (tx) => {
      const { rows: billRows } = await tx.query<{
        tax: number;
        service_charge: number;
        tip: number;
        discount: number;
        warnings: unknown;
      }>(
        `select tax, service_charge, tip, discount, warnings
           from bills where id = $1 for update`,
        [billId],
      );
      const current = billRows[0];
      if (!current) throw ApiError.notFound('Bill not found');

      if (removed.length > 0) {
        await tx.query(`delete from bill_items where id = any($1::uuid[])`, [
          removed.map((row) => row.id),
        ]);
      }

      for (const item of items) {
        if (!item.id) {
          await tx.query(
            `insert into bill_items
               (bill_id, name, qty, unit_price, line_total, confidence, kind, unit)
             values ($1, $2, $3, $4, $5, 1, $6, $7)`,
            [
              billId,
              item.name,
              item.qty,
              item.unitPriceMinor,
              item.lineTotalMinor,
              null,
              item.unit,
            ],
          );
          continue;
        }

        // A line the fronter retyped by hand is no longer a guess, so it moves
        // to full confidence. A line that only travelled back unchanged keeps
        // whatever certainty the scanner gave it.
        await tx.query(
          `update bill_items
              set name = $2,
                  qty = $3,
                  unit_price = $4,
                  line_total = $5,
                  unit = $6,
                  confidence = case
                    when line_total = $5 and qty = $3 then confidence
                    else 1
                  end
            where id = $1 and bill_id = $7`,
          [
            item.id,
            item.name,
            item.qty,
            item.unitPriceMinor,
            item.lineTotalMinor,
            item.unit,
            billId,
          ],
        );
      }

      // Re-share a line whose money changed across whoever already had it, so
      // the members' amounts still add up to the new line total. Members whose
      // amount survives untouched keep their confirmation.
      for (const item of items) {
        if (!item.id) continue;
        const before = prior.get(item.id);
        if (!before || Number(before.line_total) === item.lineTotalMinor) continue;

        const { rows: allocationRows } = await tx.query<{
          id: string;
          qty: string | number;
          amount: string | number;
        }>(
          `select id, qty, amount from allocations
            where bill_item_id = $1 order by created_at asc`,
          [item.id],
        );
        if (allocationRows.length === 0) continue;

        const parts = allocate(
          item.lineTotalMinor,
          allocationRows.map((row) => Number(row.qty)),
        );
        for (let index = 0; index < allocationRows.length; index += 1) {
          const row = allocationRows[index];
          if (!row) continue;
          const amount = parts[index] ?? 0;
          if (Number(row.amount) === amount) continue;
          await tx.query(
            `update allocations set amount = $2, status = 'proposed' where id = $1`,
            [row.id, amount],
          );
        }
      }

      const tax = Number(current.tax);
      const totalMinor = Math.max(
        0,
        subtotalMinor +
          tax +
          Number(current.service_charge) +
          Number(current.tip) -
          Number(current.discount),
      );

      const warnings = Array.isArray(current.warnings)
        ? current.warnings.map(String)
        : [];
      const editedWarning =
        'Lines were edited by hand — the total no longer matches the printed receipt.';
      if (moneyMoved && !warnings.includes(editedWarning)) {
        warnings.push(editedWarning);
      }

      const { rows: countRows } = await tx.query<{
        items: number;
        allocated: number;
        proposed: number;
      }>(
        `select (select count(*)::int from bill_items where bill_id = $1) as items,
                (select count(distinct al.bill_item_id)::int
                   from allocations al
                   join bill_items bi on bi.id = al.bill_item_id
                  where bi.bill_id = $1) as allocated,
                (select count(*)::int
                   from allocations al
                   join bill_items bi on bi.id = al.bill_item_id
                  where bi.bill_id = $1 and al.status = 'proposed') as proposed`,
        [billId],
      );
      const counts = countRows[0];
      const itemCount = counts?.items ?? 0;
      const allocated = counts?.allocated ?? 0;
      const proposed = counts?.proposed ?? 0;
      const status =
        allocated === 0
          ? 'PARSED'
          : allocated < itemCount || proposed > 0
            ? 'ALLOCATED'
            : 'CONFIRMED';

      await tx.query(
        `update bills
            set subtotal = $2,
                total = $3,
                warnings = $4::jsonb,
                status = $5,
                version = version + 1
          where id = $1 and status in ${EDITABLE}`,
        [
          billId,
          subtotalMinor,
          totalMinor,
          JSON.stringify(warnings),
          status,
        ],
      );

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId: ctx.agreementId,
        memberId: ctx.member.id,
        eventType: 'bill.items_edited',
        amountMinor: totalMinor,
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `${ctx.member.displayName} corrected the lines — ${items.length} item${
          items.length === 1 ? '' : 's'
        }, total ${formatAmount(totalMinor, ctx.currency)}`,
      });
    });

    const loaded = await loadBill(billId);
    return { bill: mapBill(loaded.bill, loaded.items) };
  });

  /**
   * A group buy asks each member how many units they want. The claim is
   * member-scoped on purpose: the fronter-only `/allocations` route replaces
   * everybody's split, while this one touches only the caller's own row and
   * then re-shares that line across whoever has claimed so far. Units nobody
   * claimed stay with the fronter through `finalize`'s gap rule.
   */
  app.patch<BillParams>('/bills/:id/claims', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);

    if (ctx.source !== 'quantity_claim') {
      throw ApiError.conflict(
        'not_quantity_bill',
        'Only a group-buy bill takes quantity claims',
      );
    }
    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    const body = asRecord(request.body);
    const raw = body.claims;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw ApiError.badRequest('invalid_claims', 'Send at least one claim');
    }
    if (raw.length > 200) {
      throw ApiError.badRequest('invalid_claims', 'Too many claims in one request');
    }

    const claims = raw.map((entry) => {
      const record = asRecord(entry);
      const billItemId = requiredUuid(record, 'billItemId');
      const qtyValue = record.qty;
      if (
        typeof qtyValue !== 'number' ||
        !Number.isFinite(qtyValue) ||
        qtyValue < 0
      ) {
        throw ApiError.badRequest('invalid_qty', 'qty must be zero or more units');
      }
      return {
        billItemId,
        qty: Math.min(Math.round(qtyValue * 100) / 100, 9999),
      };
    });

    const { rows: itemRows } = await query<{
      id: string;
      name: string;
      qty: string;
      line_total: number;
    }>(`select id, name, qty, line_total from bill_items where bill_id = $1`, [
      billId,
    ]);
    if (itemRows.length === 0) {
      throw ApiError.conflict('bill_empty', 'This bill has no items yet');
    }
    const items = new Map(itemRows.map((row) => [row.id, row]));

    for (const claim of claims) {
      if (!items.has(claim.billItemId)) {
        throw ApiError.badRequest(
          'invalid_billItemId',
          'An item does not belong to this bill',
        );
      }
    }

    const touched = [...new Set(claims.map((claim) => claim.billItemId))];

    await withTransaction(async (tx) => {
      for (const claim of claims) {
        if (claim.qty === 0) {
          await tx.query(
            `delete from allocations where bill_item_id = $1 and member_id = $2`,
            [claim.billItemId, ctx.member.id],
          );
          continue;
        }
        await tx.query(
          `insert into allocations (bill_item_id, member_id, qty, amount, status)
           values ($1, $2, $3, 0, 'proposed')
           on conflict (bill_item_id, member_id) do update
             set qty = excluded.qty, status = 'proposed'`,
          [claim.billItemId, ctx.member.id, claim.qty],
        );
      }

      for (const itemId of touched) {
        const item = items.get(itemId);
        if (!item) continue;

        const catalogueQty = Number(item.qty);
        const { rows: claimRows } = await tx.query<{
          id: string;
          qty: string;
          amount: number;
          status: string;
        }>(
          `select id, qty, amount, status from allocations
            where bill_item_id = $1
            order by created_at, id`,
          [itemId],
        );

        const claimed = claimRows.reduce((sum, row) => sum + Number(row.qty), 0);
        if (catalogueQty > 0 && claimed > catalogueQty + 1e-9) {
          throw ApiError.conflict(
            'claim_exceeds_units',
            `Only ${catalogueQty} of "${item.name}" available — lower your claim`,
          );
        }

        // Claimed units are worth their share of the line; the unclaimed rest
        // becomes finalize()'s gap and lands on whoever fronted the purchase.
        const covered =
          catalogueQty > 0
            ? Math.round((item.line_total * claimed) / catalogueQty)
            : item.line_total;
        const parts = allocate(
          covered,
          claimRows.map((row) => Number(row.qty)),
        );

        for (let index = 0; index < claimRows.length; index += 1) {
          const row = claimRows[index];
          if (!row) continue;
          const amount = parts[index] ?? 0;
          if (row.amount === amount && row.status === 'proposed') continue;
          // A changed split invalidates earlier confirmations, including this
          // member's own — everyone re-confirms the amount they now owe.
          await tx.query(
            `update allocations set amount = $2, status = 'proposed' where id = $1`,
            [row.id, amount],
          );
        }
      }

      await tx.query(
        `update bills
            set status = 'ALLOCATED', version = version + 1
          where id = $1 and status in ${EDITABLE}`,
        [billId],
      );

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId: ctx.agreementId,
        memberId: ctx.member.id,
        eventType: 'bill.claimed',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `${ctx.member.displayName} updated their share of the group buy`,
      });
    });

    const allocations = await loadAllocations(billId);
    return { allocations: allocations.map(mapAllocation) };
  });

  /** A member confirms only the lines assigned to them. Idempotent. */
  app.post<AllocationParams>('/allocations/:id/confirm', async (request) => {
    const allocationId = pathUuid(request.params.id);

    const { rows } = await query<AllocationConfirmRow>(
      `select al.id, al.bill_item_id, al.member_id, al.amount, al.status,
              b.id as bill_id, a.group_id, b.currency, b.status as bill_status
         from allocations al
         join bill_items bi on bi.id = al.bill_item_id
         join bills b on b.id = bi.bill_id
         join agreements a on a.id = b.agreement_id
        where al.id = $1`,
      [allocationId],
    );
    const allocation = rows[0];
    if (!allocation) throw ApiError.notFound('Allocation not found');

    const member = await requireBillMember(request, allocation.bill_id);
    if (member.member.id !== allocation.member_id) {
      throw new ApiError(403, 'not_your_line', 'You can only confirm your own items');
    }
    if (LOCKED.has(allocation.bill_status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    if (allocation.status !== 'confirmed') {
      await withTransaction(async (tx) => {
        await tx.query(
          `insert into item_confirmations (allocation_id, member_id, status, confirmed_amount)
           values ($1, $2, 'confirmed', $3)`,
          [allocationId, allocation.member_id, allocation.amount],
        );
        await tx.query(
          `update allocations set status = 'confirmed'
            where id = $1 and status = 'proposed'`,
          [allocationId],
        );

        const { rows: pendingRows } = await tx.query<{ pending: number }>(
          `select count(*)::int as pending
             from allocations al
             join bill_items bi on bi.id = al.bill_item_id
            where bi.bill_id = $1 and al.status = 'proposed'`,
          [allocation.bill_id],
        );

        if ((pendingRows[0]?.pending ?? 0) === 0) {
          await tx.query(
            `update bills set status = 'CONFIRMED'
              where id = $1 and status in ('UPLOADED', 'PARSED', 'ALLOCATED')`,
            [allocation.bill_id],
          );
        }

        await recordEvent(tx, {
          groupId: allocation.group_id,
          agreementId: null,
          memberId: allocation.member_id,
          eventType: 'allocation.confirmed',
          amountMinor: allocation.amount,
          currency: allocation.currency,
          actor: member.member.displayName,
          summary: `${member.member.displayName} confirmed their line`,
        });
      });
    }

    return { allocation: mapAllocation(await loadAllocation(allocationId)) };
  });

  /**
   * Turn confirmed lines into one share per member. Tax, tip, service and any
   * unassigned lines land on the fronter so the shares always add to the total.
   */
  app.post<BillParams>('/bills/:id/finalize', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    const current = await loadBill(billId);

    if (current.bill.status === 'FINALIZED' || current.bill.status === 'COLLECTING') {
      const shares = await loadShares(billId);
      return {
        bill: mapBill(current.bill, current.items),
        shares: shares.map((share) => mapShare(share)),
      };
    }
    if (LOCKED.has(current.bill.status)) {
      throw ApiError.conflict('bill_closed', 'This bill is closed');
    }

    // The group's winning vote decides the arithmetic. `equal` means nobody
    // needs to assign line items at all: the total is divided between the
    // active members, and the largest-remainder `allocate` keeps the shares
    // adding up to the total to the last minor unit.
    const splitVote = await loadBillSplitSummary({
      billId,
      agreementId: ctx.agreementId,
      groupId: ctx.groupId,
      storedMode: ctx.splitMode,
      frontedBy: ctx.frontedBy,
      memberId: ctx.member.id,
    });
    const equalMode = splitVote.resolvedMode === 'equal';

    const allocations = equalMode ? [] : await loadAllocations(billId);
    if (!equalMode && allocations.length === 0) {
      throw ApiError.conflict('no_allocations', 'Assign the items before finalizing');
    }

    const pending = allocations.filter((row) => row.status === 'proposed');
    if (pending.length > 0) {
      throw ApiError.conflict(
        'confirmations_pending',
        `${pending.length} line(s) still need a member's confirmation`,
      );
    }

    const { rows: agreementRows } = await query<{
      fronted_by: string | null;
      deadline: Date | null;
    }>(`select fronted_by, deadline from agreements where id = $1`, [ctx.agreementId]);
    const agreement = agreementRows[0];
    if (!agreement) throw ApiError.notFound('Agreement not found');

    const totals = new Map<string, number>();
    if (equalMode) {
      const { rows: memberRows } = await query<{ id: string }>(
        `select id from members where group_id = $1 and status <> 'removed'
          order by id`,
        [ctx.groupId],
      );
      const evenShares = allocate(current.bill.total, memberRows.map(() => 1));
      memberRows.forEach((row, index) => {
        const amount = evenShares[index] ?? 0;
        if (amount > 0) totals.set(row.id, amount);
      });
    } else {
      for (const row of allocations) {
        totals.set(row.member_id, (totals.get(row.member_id) ?? 0) + row.amount);
      }
    }

    const covered = [...totals.values()].reduce((sum, value) => sum + value, 0);
    const gap = current.bill.total - covered;
    if (gap < 0) {
      throw ApiError.conflict(
        'totals_mismatch',
        'Allocated amounts exceed the bill total',
      );
    }
    if (gap > 0) {
      // Rounding, tax, tip and unassigned lines are carried by the fronter.
      const target = agreement.fronted_by ?? ctx.member.id;
      totals.set(target, (totals.get(target) ?? 0) + gap);
    }

    const rows = [...totals.entries()].filter(([, amount]) => amount > 0);
    if (rows.length === 0) {
      throw ApiError.conflict('nothing_to_collect', 'There is nothing to collect');
    }

    const sum = rows.reduce((acc, [, amount]) => acc + amount, 0);
    if (sum !== current.bill.total) {
      throw ApiError.conflict(
        'totals_mismatch',
        'The split does not add up to the bill total',
      );
    }

    const currency = current.bill.currency.trim();
    const dueAt =
      agreement.deadline ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // The fronter already handed the merchant the money for their own food, so
    // that share is spent, not owed — asking them to transfer to themselves
    // would keep the bill open forever.
    const fronterId = agreement.fronted_by ?? ctx.member.id;

    await withTransaction(async (tx) => {
      await tx.query(
        `delete from shares where bill_id = $1 and status = 'proposed'`,
        [billId],
      );

      for (const [memberId, amount] of rows) {
        const status = memberId === fronterId ? 'settled' : 'proposed';
        await tx.query(
          `insert into shares (bill_id, member_id, amount, currency, status, due_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [billId, memberId, amount, currency, status, dueAt],
        );
      }

      await tx.query(
        `update bills set status = 'FINALIZED', version = version + 1 where id = $1`,
        [billId],
      );

      // Fronting is the act the product is built around, so it pays Globie
      // too. Idempotent per agreement: only the first finalize lands an award.
      const fronted = await awardFrontedGlobie(tx, {
        agreementId: ctx.agreementId,
        groupId: ctx.groupId,
        memberId: fronterId,
      });

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId: ctx.agreementId,
        memberId: ctx.member.id,
        eventType: 'bill.finalized',
        amountMinor: current.bill.total,
        currency,
        actor: ctx.member.displayName,
        summary:
          `${ctx.member.displayName} locked the split ${
            equalMode ? 'evenly' : 'by line item'
          } — ${rows.length} shares ready` +
          (fronted.delta > 0 ? `, +${fronted.delta} Globie for fronting` : ''),
        metadata: {
          splitMode: splitVote.resolvedMode,
          splitSource: splitVote.source,
        },
      });
    });

    const [bill, shares] = await Promise.all([loadBill(billId), loadShares(billId)]);

    return {
      bill: mapBill(bill.bill, bill.items),
      shares: shares.map((share) => mapShare(share)),
    };
  });

  /** One NEP-141 transfer request per outstanding share, signed by each member. */
  app.post<BillParams>('/bills/:id/request-payments', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    if (ctx.status !== 'FINALIZED' && ctx.status !== 'COLLECTING') {
      throw ApiError.conflict(
        'bill_not_finalized',
        'Finalize the bill before requesting payments',
      );
    }

    const { bill } = await loadBill(billId);
    const shares = await loadShares(billId);

    const collected = shares.reduce((sum, row) => sum + row.amount, 0);
    if (collected !== bill.total) {
      throw ApiError.conflict(
        'totals_mismatch',
        'Shares do not add up to the bill total',
      );
    }

    // Requesting is idempotent on this rail: the on-chain memo carries the
    // share id, so asking again re-renders the same transfer instead of
    // opening a second, ambiguous payment.
    const transfers: TransferRequest[] = [];

    for (const share of shares) {
      if (['paid', 'settled', 'refunded'].includes(share.status)) continue;
      transfers.push(
        await requestTransferForShare({
          shareId: share.id,
          actor: ctx.member.displayName,
        }),
      );
    }

    await query(
      `update bills set status = 'COLLECTING'
        where id = $1 and status in ('FINALIZED', 'COLLECTING')`,
      [billId],
    );

    return { transfers };
  });
};
