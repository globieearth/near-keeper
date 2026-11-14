/**
 * The Globie agent (DEV_PLAN §2.11).
 *
 * One deterministic dispatcher over the eight tools the product promises. Every
 * call is authorised against the database — never on the ids the caller claims —
 * audited to `agent_events`, and the four tools that move money or people need a
 * short-lived HMAC confirmation token issued by a previous, unconfirmed call.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { query, withTransaction } from '../db/pool.js';
import { requireUser } from '../plugins/auth.js';
import {
    requireAgreementMember,
    requireBillMember,
    requireFronter,
} from './access.js';
import {
    LOCKED,
    loadAllocations,
    loadBill,
    loadShareById,
    loadShares,
    startBillParse,
} from './bills.js';
import { config, isProduction } from './config.js';
import {
    catalogue,
    findTopic,
    matchTopic,
    type HelpTopic,
} from './help.js';
import { ApiError } from './http-error.js';
import { listInterestCharges } from './interest.js';
import { recordEvent } from './ledger.js';
import { allocate, formatAmount } from './money.js';
import { requestTransferForShare } from './near-settlement.js';
import { reminderMessage } from './notify.js';
import {
    composeChatReply,
    composeToolReply,
    type ConversationTurn,
} from './reply.js';
import {
    mapAllocation,
    mapBillItem,
    mapInterestCharge,
    mapShare,
} from './serialize.js';
import { awardGlobie } from './settlement.js';
import { asRecord, optionalString, pathUuid, requiredUuid } from './validate.js';

export const AGENT_TOOLS = [
  'parse_receipt_media',
  'propose_allocation',
  'request_item_confirmation',
  'create_payment_request',
  'get_bill_status',
  'send_reminder',
  'award_points',
  'explain_feature',
] as const;

export type AgentToolName = (typeof AGENT_TOOLS)[number];

/** Tools that must be confirmed out-of-band before they take effect. */
const CONFIRMATION_TOOLS = new Set<AgentToolName>([
  'create_payment_request',
  'send_reminder',
  'award_points',
]);

const CONFIRM_QUESTION: Record<string, string> = {
  create_payment_request:
    'This asks a member to send a real NEAR payment. Confirm to continue.',
  send_reminder: 'This messages the member. Confirm to send it.',
  award_points: 'This writes Globie points. Confirm to continue.',
};

const REMINDER_TONES = new Set(['friendly', 'firm', 'final']);

const CONFIRM_TTL_MS = 10 * 60 * 1000;
const DEV_CONFIRM_SECRET = 'globie-dev-confirm';

// ---------------------------------------------------------------------------
// Confirmation tokens
// ---------------------------------------------------------------------------

function confirmKey(): string {
  const secret = config.agentConfirmSecret || (isProduction ? '' : DEV_CONFIRM_SECRET);
  if (!secret) {
    throw new ApiError(
      503,
      'agent_not_configured',
      'Set AGENT_CONFIRMATION_SECRET before the agent can move money',
    );
  }
  return secret;
}

/** Stable JSON so the same arguments always hash to the same token. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function argsFingerprint(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(args)).digest('hex');
}

function sign(payload: string): string {
  return createHmac('sha256', confirmKey()).update(payload).digest('base64url');
}

function issueConfirmation(input: {
  memberId: string;
  tool: AgentToolName;
  args: Record<string, unknown>;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      a: input.memberId,
      t: input.tool,
      h: argsFingerprint(input.args),
      e: Date.now() + CONFIRM_TTL_MS,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyConfirmation(input: {
  memberId: string;
  tool: AgentToolName;
  args: Record<string, unknown>;
  token: string;
}): boolean {
  const [payload, mac] = input.token.split('.');
  if (!payload || !mac) return false;

  const given = Buffer.from(mac);
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return false;
  }

  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { a?: unknown; t?: unknown; h?: unknown; e?: unknown };
    return (
      claims.a === input.memberId &&
      claims.t === input.tool &&
      claims.h === argsFingerprint(input.args) &&
      typeof claims.e === 'number' &&
      claims.e > Date.now()
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type ToolOutcome = {
  /** `null` for a tool that does not act inside a group (e.g. help). */
  groupId: string | null;
  executed: boolean;
  confirmationRequired: boolean;
  confirmToken: string | null;
  result: Record<string, unknown>;
  reply: string;
};

type ConfirmationPending = {
  confirmationRequired: true;
  confirmToken: string;
  result: Record<string, unknown>;
  reply: string;
};

/** Returns a challenge when the token is missing, and `null` once it checks out. */
function demandConfirmation(
  tool: AgentToolName,
  args: Record<string, unknown>,
  confirmToken: string | null,
  memberId: string,
): ConfirmationPending | null {
  const token = confirmToken?.trim();
  if (token) {
    if (!verifyConfirmation({ memberId, tool, args, token })) {
      throw ApiError.badRequest(
        'invalid_confirmation',
        'That confirmation token is invalid or has expired — ask again',
      );
    }
    return null;
  }

  return {
    confirmationRequired: true,
    confirmToken: issueConfirmation({ memberId, tool, args }),
    result: { tool, args },
    reply: CONFIRM_QUESTION[tool] ?? 'Confirm to continue.',
  };
}

function billTotals(bill: {
  subtotal: number;
  tax: number;
  service_charge: number;
  tip: number;
  discount: number;
  total: number;
}) {
  return {
    subtotalMinor: bill.subtotal,
    taxMinor: bill.tax,
    serviceChargeMinor: bill.service_charge,
    tipMinor: bill.tip,
    discountMinor: bill.discount,
    totalMinor: bill.total,
  };
}

// --- parse_receipt_media ---------------------------------------------------

const parseReceiptMedia: ToolHandler = async (request, args) => {
  const billId = requiredUuid(args, 'bill_id');
  const ctx = await requireBillMember(request, billId);
  requireFronter(ctx);

  if (LOCKED.has(ctx.status)) {
    throw ApiError.conflict('bill_locked', 'This bill is already locked');
  }

  if (ctx.status === 'PARSING') {
    return {
      groupId: ctx.groupId,
      executed: false,
      confirmationRequired: false,
      confirmToken: null,
      result: { status: 'PARSING', items: [], totals: null, warnings: [], confidence: 0 },
      reply: 'I am still reading that receipt — ask me again in a moment.',
    };
  }

  await startBillParse({
    billId,
    agreementId: ctx.agreementId,
    groupId: ctx.groupId,
    memberId: ctx.member.id,
    actor: ctx.member.displayName,
    currency: ctx.currency,
    log: request.log,
    wait: true,
  });

  const { bill, items } = await loadBill(billId);
  const confidences = items
    .map((item) => Number(item.confidence))
    .filter((value) => Number.isFinite(value));
  const confidence =
    confidences.length > 0
      ? Number(
          (
            confidences.reduce((sum, value) => sum + value, 0) /
            confidences.length
          ).toFixed(3),
        )
      : 0;

  const warnings = Array.isArray(bill.warnings) ? bill.warnings.map(String) : [];
  const currency = bill.currency.trim();
  // A hand-typed bill has nothing to read; it was already PARSED when it was
  // opened, so the reply must not claim the vision model saw a receipt.
  const reply =
    bill.status === 'PARSED'
      ? bill.source === 'receipt_vision' || bill.source === undefined
        ? `I read ${items.length} line${items.length === 1 ? '' : 's'} from ${
            bill.merchant ?? 'the receipt'
          } — ${formatAmount(bill.total, currency)} ${currency}.`
        : `That bill has ${items.length} line${items.length === 1 ? '' : 's'} — ${formatAmount(
            bill.total,
            currency,
          )} ${currency}.`
      : 'I could not read that receipt — try a clearer photo or a short video.';

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      bill_id: billId,
      status: bill.status,
      merchant: bill.merchant,
      currency: bill.currency.trim(),
      items: items.map(mapBillItem),
      totals: billTotals(bill),
      warnings,
      confidence,
    },
    reply,
  };
};

// --- propose_allocation ----------------------------------------------------

function hintedMembers(args: Record<string, unknown>): string[] | null {
  if (args.hints === undefined || args.hints === null) return null;

  const hints = asRecord(args.hints);
  const raw = hints.member_ids ?? hints.memberIds;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw ApiError.badRequest('invalid_hints', 'hints.member_ids must be an array');
  }

  const ids = raw.map((value) => pathUuid(value, 'member_ids'));
  return [...new Set(ids)];
}

const proposeAllocation: ToolHandler = async (request, args) => {
  const billId = requiredUuid(args, 'bill_id');
  const ctx = await requireBillMember(request, billId);
  requireFronter(ctx);

  if (LOCKED.has(ctx.status)) {
    throw ApiError.conflict('bill_locked', 'This bill is already locked');
  }

  const { bill, items } = await loadBill(billId);
  if (items.length === 0) {
    throw ApiError.conflict('bill_empty', 'Read the receipt before splitting it');
  }

  const { rows: memberRows } = await query<{ id: string }>(
    `select m.id
       from members m
      where m.group_id = $1 and m.status <> 'removed'
      order by m.joined_at asc`,
    [ctx.groupId],
  );
  const activeIds = new Set(memberRows.map((row) => row.id));

  const hinted = hintedMembers(args);
  if (hinted) {
    for (const id of hinted) {
      if (!activeIds.has(id)) {
        throw ApiError.badRequest(
          'invalid_member_ids',
          'A member does not belong to this group',
        );
      }
    }
  }

  const members = hinted && hinted.length > 0 ? hinted : [...activeIds];
  if (members.length === 0) {
    throw ApiError.conflict('no_members', 'This group has no active members');
  }

  await withTransaction(async (tx) => {
    // Replacing the split must also clear the previous one.
    await tx.query(
      `delete from allocations
        where bill_item_id in (select id from bill_items where bill_id = $1)`,
      [billId],
    );

    for (const item of items) {
      const parts = allocate(
        item.line_total,
        members.map(() => 1),
      );
      for (let index = 0; index < members.length; index += 1) {
        await tx.query(
          `insert into allocations (bill_item_id, member_id, qty, amount, status)
           values ($1, $2, 1, $3, 'proposed')`,
          [item.id, members[index], parts[index] ?? 0],
        );
      }
    }

    await tx.query(
      `update bills set status = 'ALLOCATED', version = version + 1 where id = $1`,
      [billId],
    );

    await recordEvent(tx, {
      groupId: ctx.groupId,
      agreementId: ctx.agreementId,
      memberId: ctx.member.id,
      eventType: 'bill.allocated',
      currency: ctx.currency,
      actor: ctx.member.displayName,
      summary: `Globie split the bill equally across ${members.length} member${
        members.length === 1 ? '' : 's'
      } — each member confirms their own lines`,
      metadata: { tool: 'propose_allocation' },
    });
  });

  const allocations = await loadAllocations(billId);

  const lineSum = items.reduce((sum, item) => sum + item.line_total, 0);
  const questions: string[] = [];
  for (const item of items) {
    const expected = Math.round(Number(item.qty) * item.unit_price);
    if (expected !== item.line_total) {
      questions.push(
        `${item.name}: quantity × unit price does not match the line total.`,
      );
    }
  }
  if (lineSum !== bill.total) {
    questions.push(
      `The lines add up to ${formatAmount(lineSum, bill.currency.trim())} but the receipt says ${formatAmount(
        bill.total,
        bill.currency.trim(),
      )} — the difference lands on the fronter.`,
    );
  }

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      bill_id: billId,
      allocations: allocations.map(mapAllocation),
      questions,
    },
    reply: `I split ${items.length} line${items.length === 1 ? '' : 's'} across ${
      members.length
    } member${members.length === 1 ? '' : 's'}. Everyone still needs to confirm their own lines.`,
  };
};

// --- request_item_confirmation --------------------------------------------

const requestItemConfirmation: ToolHandler = async (request, args) => {
  const billId = requiredUuid(args, 'bill_id');
  const ctx = await requireBillMember(request, billId);
  requireFronter(ctx);

  if (LOCKED.has(ctx.status)) {
    throw ApiError.conflict('bill_locked', 'This bill is already locked');
  }

  const { rows } = await query<{ id: string; member_id: string }>(
    `select al.id, al.member_id
       from allocations al
       join bill_items bi on bi.id = al.bill_item_id
      where bi.bill_id = $1 and al.status = 'proposed'
      order by al.created_at asc`,
    [billId],
  );

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.member_id) ?? [];
    list.push(row.id);
    grouped.set(row.member_id, list);
  }

  const { rows: versionRows } = await query<{ version: number }>(
    `select version from bills where id = $1`,
    [billId],
  );
  const version = versionRows[0]?.version ?? 1;

  let sent = 0;
  await withTransaction(async (tx) => {
    for (const [memberId, allocationIds] of grouped) {
      const { rowCount } = await tx.query(
        `insert into notification_outbox (channel, recipient, template, payload, idempotency_key)
         values ('in_app', $1, 'item_confirmation', $2::jsonb, $3)
         on conflict (idempotency_key) do nothing`,
        [
          memberId,
          JSON.stringify({ billId, memberId, allocationIds }),
          `item-confirm:${billId}:${memberId}:${version}`,
        ],
      );
      sent += rowCount ?? 0;
    }

    if (grouped.size > 0) {
      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId: ctx.agreementId,
        memberId: ctx.member.id,
        eventType: 'allocation.confirmation_requested',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `Globie asked ${grouped.size} member${
          grouped.size === 1 ? '' : 's'
        } to confirm their lines`,
        metadata: { tool: 'request_item_confirmation' },
      });
    }
  });

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: { bill_id: billId, sent },
    reply:
      sent > 0
        ? `I asked ${sent} member${sent === 1 ? '' : 's'} to confirm their lines.`
        : 'Nobody has unconfirmed lines right now.',
  };
};

// --- create_payment_request ----------------------------------------------

const createPaymentRequest: ToolHandler = async (request, args, confirmToken) => {
  const billId = requiredUuid(args, 'bill_id');
  const shareId = requiredUuid(args, 'share_id');
  const ctx = await requireBillMember(request, billId);
  requireFronter(ctx);

  const gate = demandConfirmation(
    'create_payment_request',
    args,
    confirmToken,
    ctx.member.id,
  );
  if (gate) {
    return { groupId: ctx.groupId, executed: false, ...gate };
  }

  if (ctx.status !== 'FINALIZED' && ctx.status !== 'COLLECTING') {
    throw ApiError.conflict(
      'bill_not_finalized',
      'Finalize the bill before requesting payments',
    );
  }

  const share = await loadShareById(shareId);
  if (share.bill_id !== billId) {
    throw ApiError.badRequest(
      'share_not_on_bill',
      'That share belongs to another bill',
    );
  }

  const { bill } = await loadBill(billId);
  const shares = await loadShares(billId);
  const collected = shares.reduce((sum, row) => sum + row.amount, 0);
  if (collected !== bill.total) {
    throw ApiError.conflict('totals_mismatch', 'Shares do not add up to the bill total');
  }

  const result = await requestTransferForShare({
    shareId: share.id,
    actor: ctx.member.displayName,
  });

  await query(
    `update bills set status = 'COLLECTING'
      where id = $1 and status in ('FINALIZED', 'COLLECTING')`,
    [billId],
  );

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      share_id: result.shareId,
      pay_to: result.payTo,
      token_contract: result.tokenContract,
      chain_amount: result.chainAmount,
      memo: result.memo,
      amount: result.amount,
      currency: result.currency,
    },
    reply: `I asked ${share.member_name} to send ${formatAmount(
      result.amount,
      result.currency,
    )} ${result.currency} on NEAR to ${result.payTo}.`,
  };
};

// --- get_bill_status -------------------------------------------------------

const getBillStatus: ToolHandler = async (request, args) => {
  const billId = requiredUuid(args, 'bill_id');
  const ctx = await requireBillMember(request, billId);

  const [{ bill }, shares, interest] = await Promise.all([
    loadBill(billId),
    loadShares(billId),
    listInterestCharges(billId),
  ]);
  const outstanding = shares.filter(
    (row) => !['paid', 'settled', 'refunded'].includes(row.status),
  );
  const outstandingMinor = outstanding.reduce((sum, row) => sum + row.amount, 0);
  const openInterest = interest.filter((row) => row.status === 'requested');
  const openInterestMinor = openInterest.reduce((sum, row) => sum + row.amount, 0);
  const currency = bill.currency.trim();

  const lateFees =
    openInterest.length === 0
      ? ''
      : ` On top of that, ${openInterest.length} late fee${
          openInterest.length === 1 ? '' : 's'
        } (${formatAmount(openInterestMinor, currency)} ${currency}) ${
          openInterest.length === 1 ? 'is' : 'are'
        } still unpaid.`;

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      bill_id: billId,
      status: bill.status,
      shares: shares.map((share) => mapShare(share)),
      totals: billTotals(bill),
      outstanding: {
        count: outstanding.length,
        amountMinor: outstandingMinor,
        shareIds: outstanding.map((row) => row.id),
      },
      // Late fees are money owed on top of the shares, so the assistant
      // must see them before it says anyone is square.
      interestCharges: interest.map((row) => mapInterestCharge(row)),
      interestOutstanding: {
        count: openInterest.length,
        amountMinor: openInterestMinor,
        chargeIds: openInterest.map((row) => row.id),
      },
    },
    reply:
      outstanding.length === 0
        ? `Everyone has paid — this bill is settled.${lateFees}`
        : `${outstanding.length} share${
            outstanding.length === 1 ? '' : 's'
          } still open: ${formatAmount(outstandingMinor, currency)} ${currency} outstanding.${lateFees}`,
  };
};

// --- send_reminder ---------------------------------------------------------

const sendReminder: ToolHandler = async (request, args, confirmToken) => {
  const shareId = requiredUuid(args, 'share_id');
  const tone = optionalString(args, 'tone', 16)?.toLowerCase() ?? 'friendly';
  if (!REMINDER_TONES.has(tone)) {
    throw ApiError.badRequest('invalid_tone', 'tone must be friendly, firm or final');
  }

  const share = await loadShareById(shareId);
  const ctx = await requireBillMember(request, share.bill_id);
  requireFronter(ctx);

  const gate = demandConfirmation('send_reminder', args, confirmToken, ctx.member.id);
  if (gate) {
    return { groupId: ctx.groupId, executed: false, ...gate };
  }

  if (['paid', 'settled', 'refunded'].includes(share.status)) {
    throw ApiError.conflict('share_already_paid', 'This share is already paid');
  }

  const currency = share.currency.trim();
  const message = reminderMessage({
    firstName: share.member_name.split(' ')[0] ?? share.member_name,
    amount: formatAmount(share.amount, currency),
    currency,
    groupName: share.group_name,
    tone,
  });

  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `reminder:${shareId}:${tone}:${day}`;

  const sentAt = await withTransaction(async (tx) => {
    const { rows } = await tx.query<{ sent_at: Date }>(
      `insert into reminders
         (share_id, scheduled_for, sent_at, channel, template, message, idempotency_key, status)
       values ($1, now(), now(), 'in_app', 'reminder', $2, $3, 'sent')
       on conflict (idempotency_key) do nothing
       returning sent_at`,
      [shareId, message, idempotencyKey],
    );

    await tx.query(
      `insert into notification_outbox (channel, recipient, template, payload, idempotency_key)
       values ('in_app', $1, 'reminder', $2::jsonb, $3)
       on conflict (idempotency_key) do nothing`,
      [
        share.member_id,
        JSON.stringify({
          shareId,
          billId: share.bill_id,
          tone,
          message,
          amountMinor: share.amount,
          currency,
        }),
        `outbox:${idempotencyKey}`,
      ],
    );

    await recordEvent(tx, {
      groupId: ctx.groupId,
      agreementId: ctx.agreementId,
      shareId,
      memberId: share.member_id,
      eventType: 'reminder.sent',
      amountMinor: share.amount,
      currency,
      actor: ctx.member.displayName,
      summary: `Globie nudged ${share.member_name} (${tone})`,
      metadata: { tool: 'send_reminder', tone },
    });

    return rows[0]?.sent_at ?? new Date();
  });

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: { share_id: shareId, tone, message, sent_at: sentAt.toISOString() },
    reply: `Reminder sent to ${share.member_name}.`,
  };
};

// --- award_points ----------------------------------------------------------

const awardPoints: ToolHandler = async (request, args, confirmToken) => {
  const agreementId = requiredUuid(args, 'agreement_id');
  const shareId = requiredUuid(args, 'share_id');
  const reason = optionalString(args, 'reason', 40) ?? 'globie';

  const ctx = await requireAgreementMember(request, agreementId);
  requireFronter(ctx);

  const gate = demandConfirmation('award_points', args, confirmToken, ctx.member.id);
  if (gate) {
    return { groupId: ctx.groupId, executed: false, ...gate };
  }

  const share = await loadShareById(shareId);
  if (share.agreement_id !== agreementId) {
    throw ApiError.badRequest(
      'share_not_in_agreement',
      'That share belongs to another agreement',
    );
  }
  if (!['paid', 'settled'].includes(share.status)) {
    throw ApiError.conflict(
      'share_unpaid',
      'Globie is awarded when the share is paid',
    );
  }

  const award = await withTransaction(async (tx) => {
    const result = await awardGlobie(tx, {
      agreementId,
      groupId: ctx.groupId,
      memberId: share.member_id,
      shareId,
      reason,
    });

    if (result.delta > 0) {
      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId,
        shareId,
        memberId: share.member_id,
        eventType: 'globie.awarded',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `Globie awarded ${share.member_name} +${result.delta} (rank ${result.rank})`,
        metadata: { tool: 'award_points', reason },
      });
    }

    return result;
  });

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      share_id: shareId,
      delta: award.delta,
      balance: award.balance,
      rank: award.rank,
      reason,
    },
    reply:
      award.delta > 0
        ? `${share.member_name} earned ${award.delta} Globie — balance ${award.balance}.`
        : `${share.member_name} already had this award; balance stays at ${award.balance}.`,
  };
};

// --- explain_feature -------------------------------------------------------

/** The manual page as plain text: the assistant must not rephrase it. */
function helpReply(topic: HelpTopic): string {
  return [topic.summary, ...topic.steps.map((step, index) => `${index + 1}. ${step}`)].join(
    '\n',
  );
}

const explainFeature: ToolHandler = async (_request, args) => {
  const topicId = optionalString(args, 'topic', 64);
  const question = optionalString(args, 'question', 280);

  const topic = topicId
    ? findTopic(topicId)
    : question
      ? matchTopic(question)
      : null;

  if (topic) {
    return {
      groupId: null,
      executed: false,
      confirmationRequired: false,
      confirmToken: null,
      result: { topic, matched: true },
      reply: helpReply(topic),
    };
  }

  // Nothing matched: hand back the index and say so, rather than guess.
  const titles = catalogue()
    .map((entry) => entry.title)
    .join(' · ');
  const reply = question || topicId
    ? `I don't have a page for that yet. The manual covers: ${titles}.`
    : `The manual covers: ${titles}.`;

  return {
    groupId: null,
    executed: false,
    confirmationRequired: false,
    confirmToken: null,
    result: { topics: catalogue(), matched: false },
    reply,
  };
};

// ---------------------------------------------------------------------------

type ToolHandler = (
  request: FastifyRequest,
  args: Record<string, unknown>,
  confirmToken: string | null,
) => Promise<ToolOutcome>;

const HANDLERS: Record<AgentToolName, ToolHandler> = {
  parse_receipt_media: parseReceiptMedia,
  propose_allocation: proposeAllocation,
  request_item_confirmation: requestItemConfirmation,
  create_payment_request: createPaymentRequest,
  get_bill_status: getBillStatus,
  send_reminder: sendReminder,
  award_points: awardPoints,
  explain_feature: explainFeature,
};

export type AgentResponse = ToolOutcome & { tool: AgentToolName };

/** How this group sees the caller — the model needs it to pick a next step. */
async function roleInGroup(
  groupId: string,
  userId: string | undefined,
): Promise<string> {
  if (!userId) return 'member';
  const { rows } = await query<{ role: string }>(
    `select role from members
      where group_id = $1 and user_id = $2 and status <> 'removed'
      limit 1`,
    [groupId, userId],
  );
  return rows[0]?.role ?? 'member';
}

function parseTool(value: string): AgentToolName {
  if (!(AGENT_TOOLS as readonly string[]).includes(value)) {
    throw ApiError.badRequest(
      'unknown_tool',
      `Unknown tool "${value}" — one of ${AGENT_TOOLS.join(', ')}`,
    );
  }
  return value as AgentToolName;
}

/**
 * Run one tool and append it to `agent_events`. Authorisation happens inside the
 * handler, so a refused call is still audited with whatever the caller claimed.
 *
 * The handler's `reply` is the ground truth. When the call has actually run,
 * `composeToolReply` may restate it in Globie's own words for this member; a
 * confirmation challenge is never reworded, because that copy is the thing the
 * member is agreeing to.
 */
export async function runAgentTool(input: {
  request: FastifyRequest;
  tool: string;
  args: Record<string, unknown>;
  confirmToken: string | null;
  say?: string | null;
  history?: ConversationTurn[];
  /** `false` when the client reads for data and never shows the sentence. */
  narrate?: boolean;
}): Promise<AgentResponse> {
  const startedAt = Date.now();
  const actor = input.request.auth?.displayName ?? 'anonymous';
  let groupId: string | null = null;
  let output: Record<string, unknown> = {};
  let confirmed = false;

  try {
    const tool = parseTool(input.tool);
    confirmed = Boolean(
      CONFIRMATION_TOOLS.has(tool) && input.confirmToken?.trim(),
    );

    const outcome = await HANDLERS[tool](input.request, input.args, input.confirmToken);
    groupId = outcome.groupId;
    output = outcome.executed
      ? outcome.result
      : { confirmationRequired: outcome.confirmationRequired, result: outcome.result };

    // The manual is returned verbatim: rewording product copy would be a
    // correctness bug, and the reply filter would mangle its numbers anyway.
    if (
      input.narrate !== false &&
      !outcome.confirmationRequired &&
      tool !== 'explain_feature'
    ) {
      outcome.reply = await composeToolReply({
        tool,
        fact: outcome.reply,
        result: outcome.result,
        memberName: actor,
        role: outcome.groupId
          ? await roleInGroup(outcome.groupId, input.request.auth?.userId)
          : 'member',
        say: input.say ?? null,
        history: input.history ?? [],
      });
    }

    return { tool, ...outcome };
  } catch (error) {
    output = {
      error: error instanceof ApiError ? error.code : 'internal_error',
      message: error instanceof Error ? error.message : 'Unexpected failure',
    };
    throw error;
  } finally {
    await query(
      `insert into agent_events (group_id, actor, tool, input, output, latency_ms)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        groupId,
        actor,
        input.tool.slice(0, 64) || 'unknown',
        JSON.stringify({ args: input.args, confirmed }),
        JSON.stringify(output),
        Date.now() - startedAt,
      ],
    ).catch((error: unknown) => {
      input.request.log.warn({ err: error }, 'agent_events insert failed');
    });
  }
}

export type AgentChatResponse = { reply: string; groupId: string | null };

/**
 * Plain conversation, with no tool behind it (DEV_PLAN §2.22).
 *
 * Reading is authorisation enough: the state below is built from the member's
 * own bill or agreement, so the model can answer questions about it without
 * being able to change anything. A member still only sees bills they belong to.
 */
export async function runAgentChat(input: {
  request: FastifyRequest;
  say: string;
  history: ConversationTurn[];
  billId: string | null;
  agreementId: string | null;
}): Promise<AgentChatResponse> {
  const auth = requireUser(input.request);
  let groupId: string | null = null;
  let role = 'member';
  let state: Record<string, unknown> = {};

  if (input.billId) {
    const ctx = await requireBillMember(input.request, input.billId);
    groupId = ctx.groupId;
    role = ctx.member.role;

    const [{ bill }, shares] = await Promise.all([
      loadBill(input.billId),
      loadShares(input.billId),
    ]);
    const currency = bill.currency.trim();
    const outstanding = shares.filter(
      (row) => !['paid', 'settled', 'refunded'].includes(row.status),
    );
    const outstandingMinor = outstanding.reduce((sum, row) => sum + row.amount, 0);
    const mine = shares.find((row) => row.member_id === ctx.member.id);

    state = {
      currency,
      bill: {
        label: bill.merchant ?? bill.title ?? 'the expense',
        kind: bill.kind ?? null,
        status: bill.status,
        total: `${formatAmount(bill.total, currency)} ${currency}`,
      },
      outstanding: {
        count: outstanding.length,
        amount: `${formatAmount(outstandingMinor, currency)} ${currency}`,
        members: outstanding.map((row) => row.member_name),
      },
      shares: shares.map((row) => ({
        member: row.member_name,
        amount: `${formatAmount(row.amount, currency)} ${currency}`,
        status: row.status,
      })),
      // The member's own share, stated explicitly: without it the model has to
      // match `member` back to the asker and reads a settled fronter share as
      // money still owed.
      you: mine
        ? {
            share: `${formatAmount(mine.amount, currency)} ${currency}`,
            status: mine.status,
            owes: !['paid', 'settled', 'refunded'].includes(mine.status),
            fronter: ctx.member.id === ctx.frontedBy,
          }
        : null,
    };
  } else if (input.agreementId) {
    const ctx = await requireAgreementMember(input.request, input.agreementId);
    groupId = ctx.groupId;
    role = ctx.member.role;

    // An agreement can exist before any bill does, so read it directly rather
    // than letting the model answer from an empty object.
    const { rows } = await query<{
      status: string;
      currency: string;
      estimated_total: number;
      // `pg` hands a timestamptz back as a Date, not the string the column is
      // declared as, so accept both and normalise before use.
      deadline: Date | string | null;
      recurrence: string;
      fronted_by: string | null;
      member_count: number;
      accepted_count: number;
      bill_id: string | null;
      bill_status: string | null;
      bill_total: number | null;
    }>(
      `select a.status, a.currency, a.estimated_total, a.deadline, a.recurrence,
              f.display_name as fronted_by,
              (select count(*) from members m
                where m.group_id = a.group_id and m.status <> 'removed') as member_count,
              (select count(*) from agreement_acceptances aa
                where aa.agreement_id = a.id) as accepted_count,
              b.id as bill_id, b.status as bill_status, b.total as bill_total
         from agreements a
         left join members fm on fm.id = a.fronted_by
         left join users f on f.id = fm.user_id
         left join lateral (
           select id, status, total from bills
            where agreement_id = a.id
            order by created_at desc limit 1
         ) b on true
        where a.id = $1`,
      [input.agreementId],
    );
    const row = rows[0];
    const currency = (row?.currency ?? ctx.currency).trim();
    const dueDate = row?.deadline
      ? new Date(row.deadline).toISOString().slice(0, 10)
      : null;

    state = {
      currency,
      agreement: row
        ? {
            status: row.status,
            frontedBy: row.fronted_by,
            recurrence: row.recurrence,
            accepted: `${row.accepted_count} of ${row.member_count} members`,
            estimatedTotal: `${formatAmount(row.estimated_total, currency)} ${currency}`,
            due: dueDate,
          }
        : null,
      bill: row?.bill_id
        ? {
            status: row.bill_status,
            total: `${formatAmount(row.bill_total ?? 0, currency)} ${currency}`,
          }
        : null,
    };

    if (row?.bill_id) {
      const shares = await loadShares(row.bill_id);
      const outstanding = shares.filter(
        (share) => !['paid', 'settled', 'refunded'].includes(share.status),
      );
      state.outstanding = {
        count: outstanding.length,
        amount: `${formatAmount(
          outstanding.reduce((sum, share) => sum + share.amount, 0),
          currency,
        )} ${currency}`,
        members: outstanding.map((share) => share.member_name),
      };
      const mine = shares.find((share) => share.member_id === ctx.member.id);
      state.you = mine
        ? {
            share: `${formatAmount(mine.amount, currency)} ${currency}`,
            status: mine.status,
            owes: !['paid', 'settled', 'refunded'].includes(mine.status),
            fronter: ctx.member.id === ctx.frontedBy,
          }
        : null;
    }
  }

  const reply = await composeChatReply({
    memberName: auth.displayName,
    role,
    state,
    say: input.say,
    history: input.history,
  });

  return { reply, groupId };
}
