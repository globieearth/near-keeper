/**
 * Row -> JSON mappers. Every route speaks the camelCase shapes defined in
 * lib/types.ts so the Expo client can consume responses without adapters.
 * Money columns are bigint minor units and already arrive as JS numbers.
 */

import { quoteFromRow } from './settlement-quote.js';

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numeric(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type GroupRow = {
  id: string;
  name: string;
  default_currency: string;
  owner_id: string;
  invite_token: string;
  created_at: Date;
  /** What kind of shared cost this group holds; drives copy, prompt and claims. */
  kind?: string;
};

export function mapGroup(row: GroupRow) {
  return {
    id: row.id,
    name: row.name,
    defaultCurrency: row.default_currency.trim(),
    ownerId: row.owner_id,
    inviteToken: row.invite_token,
    createdAt: iso(row.created_at),
    kind: row.kind ?? 'meal',
  };
}

export type MemberRow = {
  id: string;
  group_id: string;
  user_id: string;
  display_name: string;
  role: string;
  status: string;
};

export function mapMember(row: MemberRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role as 'owner' | 'fronter' | 'member',
    status: row.status as 'invited' | 'active' | 'removed',
  };
}

export type AgreementRow = {
  id: string;
  group_id: string;
  currency: string;
  estimated_total: number;
  deadline: Date | null;
  status: string;
  created_by: string;
  fronted_by?: string | null;
  accepted_count?: number | string;
  member_count?: number | string;
  kind?: string;
  split_mode?: string;
  recurrence?: string;
  terms_hash?: string | null;
  consent_level?: string;
  interest_mode?: string;
  interest_rate_bps?: number | null;
  interest_cap_bps?: number | null;
};

export function mapAgreement(row: AgreementRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    currency: row.currency.trim(),
    estimatedTotalMinor: row.estimated_total,
    deadline: row.deadline ? iso(row.deadline) : null,
    status: row.status as
      | 'draft'
      | 'pending'
      | 'accepted'
      | 'cancelled'
      | 'settled',
    createdBy: row.created_by,
    frontedBy: row.fronted_by ?? null,
    acceptedCount: numeric(row.accepted_count),
    memberCount: numeric(row.member_count),
    kind: row.kind ?? 'meal',
    splitMode: row.split_mode ?? 'itemised',
    recurrence: row.recurrence ?? 'none',
    /** sha256 of the canonical terms snapshot; null until the first accept. */
    termsHash: row.terms_hash ?? null,
    consentLevel: (row.consent_level ?? 'signed') as 'signed' | 'anchored',
    /** The late-fee rule, as agreed and hashed into the terms. */
    interestMode: (row.interest_mode ?? 'none') as 'none' | 'monthly',
    interestRateBps: row.interest_rate_bps ?? null,
    interestCapBps: row.interest_cap_bps ?? null,
  };
}

export type BillRow = {
  id: string;
  agreement_id: string;
  merchant: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  service_charge: number;
  tip: number;
  discount: number;
  total: number;
  status: string;
  warnings: unknown;
  frames_extracted: number;
  kind?: string;
  source?: string;
  title?: string | null;
};

export type BillItemRow = {
  id: string;
  name: string;
  qty: number | string;
  unit_price: number;
  line_total: number;
  confidence: number | string;
  kind?: string | null;
  unit?: string | null;
};

export function mapBillItem(row: BillItemRow) {
  return {
    id: row.id,
    name: row.name,
    qty: numeric(row.qty, 1),
    unitPriceMinor: row.unit_price,
    lineTotalMinor: row.line_total,
    confidence: numeric(row.confidence, 1),
    kind: row.kind ?? null,
    unit: row.unit ?? null,
  };
}

export function mapBill(row: BillRow, items: BillItemRow[]) {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    merchant: row.merchant,
    currency: row.currency.trim(),
    subtotalMinor: row.subtotal,
    taxMinor: row.tax,
    serviceChargeMinor: row.service_charge,
    tipMinor: row.tip,
    discountMinor: row.discount,
    totalMinor: row.total,
    status: row.status,
    items: items.map(mapBillItem),
    framesExtracted: row.frames_extracted,
    warnings: Array.isArray(row.warnings) ? row.warnings.map(String) : [],
    kind: row.kind ?? 'meal',
    source: (row.source ?? 'receipt_vision') as
      | 'receipt_vision'
      | 'manual'
      | 'invoice'
      | 'quantity_claim',
    title: row.title ?? null,
  };
}

export type AllocationRow = {
  id: string;
  bill_item_id: string;
  member_id: string;
  member_name: string;
  item_name: string;
  qty: number | string;
  amount: number;
  status: string;
};

export function mapAllocation(row: AllocationRow) {
  return {
    id: row.id,
    billItemId: row.bill_item_id,
    memberId: row.member_id,
    memberName: row.member_name,
    itemName: row.item_name,
    qty: numeric(row.qty, 1),
    amountMinor: row.amount,
    status: row.status as 'proposed' | 'confirmed' | 'disputed',
  };
}

export type ShareRow = {
  id: string;
  bill_id: string;
  agreement_id: string;
  group_id: string;
  group_name: string;
  member_id: string;
  member_name: string;
  amount: number;
  currency: string;
  status: string;
  due_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
  settlement_tx_hash?: string | null;
  /** Fronter's NEAR account; only selected by routes that show NEAR instructions. */
  pay_to?: string | null;
  /** The frozen settlement quote; only selected by routes that show NEAR instructions. */
  quoted_chain_amount?: string | null;
  quote_rate?: string | number | null;
  quote_as_of?: Date | string | null;
};

export function mapShare(row: ShareRow) {
  const quote = quoteFromRow(row);
  return {
    id: row.id,
    billId: row.bill_id,
    groupId: row.group_id,
    groupName: row.group_name,
    memberId: row.member_id,
    memberName: row.member_name,
    amountMinor: row.amount,
    currency: row.currency.trim(),
    status: row.status as
      | 'proposed'
      | 'confirmed'
      | 'requested'
      | 'paid'
      | 'settled'
      | 'disputed'
      | 'failed'
      | 'refunded',
    dueAt: row.due_at ? iso(row.due_at) : null,
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    /** The NEP-141 transaction that settled this share, when it was paid on NEAR. */
    settlementTxHash: row.settlement_tx_hash ?? null,
    /** The USDC amount frozen when this share was quoted, in token units. */
    chainAmount: quote?.amount ?? null,
    quoteRate: quote?.rate ?? null,
    quoteAsOf: quote?.asOf ?? null,
    /** Where the payer sends the transfer; null until the fronter has an account. */
    payTo: row.pay_to ?? null,
    /** Carried on chain so a receipt names the share it settles. */
    memo: `globie:${row.id}`,
  };
}

export type TipRow = {
  id: string;
  bill_id: string;
  from_member_id: string;
  from_member_name: string;
  to_member_id: string;
  to_member_name: string;
  amount: number;
  currency: string;
  message: string | null;
  status: string;
  settlement_tx_hash?: string | null;
  /** Fronter's NEAR account; only selected by routes that show NEAR instructions. */
  pay_to?: string | null;
  /** The frozen settlement quote; only selected by routes that show NEAR instructions. */
  quoted_chain_amount?: string | null;
  quote_rate?: string | number | null;
  quote_as_of?: Date | string | null;
  paid_at: Date | null;
  created_at: Date;
};

export function mapTip(row: TipRow) {
  const quote = quoteFromRow(row);
  return {
    id: row.id,
    billId: row.bill_id,
    fromMemberId: row.from_member_id,
    fromMemberName: row.from_member_name,
    toMemberId: row.to_member_id,
    toMemberName: row.to_member_name,
    amountMinor: row.amount,
    currency: row.currency.trim(),
    message: row.message,
    status: row.status as
      | 'proposed'
      | 'requested'
      | 'paid'
      | 'refunded'
      | 'failed',
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    createdAt: iso(row.created_at),
    settlementTxHash: row.settlement_tx_hash ?? null,
    payTo: row.pay_to ?? null,
    /** The USDC amount frozen when this tip was quoted, in token units. */
    chainAmount: quote?.amount ?? null,
    quoteRate: quote?.rate ?? null,
    quoteAsOf: quote?.asOf ?? null,
  };
}

export type InterestChargeRow = {
  id: string;
  share_id: string;
  bill_id: string;
  agreement_id: string;
  /** The member who owes the late fee. */
  member_id: string;
  member_name: string;
  /** The fronter who receives it. */
  to_member_id: string;
  to_member_name: string;
  amount: number;
  currency: string;
  rate_bps: number;
  cap_bps: number | null;
  days_late: number;
  status: string;
  settlement_tx_hash?: string | null;
  /** The fronter's NEAR account; only selected by routes that show NEAR instructions. */
  pay_to?: string | null;
  /** The frozen settlement quote; only selected by routes that show NEAR instructions. */
  quoted_chain_amount?: string | null;
  quote_rate?: string | number | null;
  quote_as_of?: Date | string | null;
  raised_at: Date;
  paid_at: Date | null;
  created_at: Date;
};

export function mapInterestCharge(row: InterestChargeRow) {
  const quote = quoteFromRow(row);
  return {
    id: row.id,
    shareId: row.share_id,
    billId: row.bill_id,
    agreementId: row.agreement_id,
    memberId: row.member_id,
    memberName: row.member_name,
    toMemberId: row.to_member_id,
    toMemberName: row.to_member_name,
    amountMinor: row.amount,
    currency: row.currency.trim(),
    rateBps: row.rate_bps,
    capBps: row.cap_bps ?? null,
    daysLate: row.days_late,
    status: row.status as 'requested' | 'paid' | 'waived' | 'failed',
    raisedAt: iso(row.raised_at),
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    createdAt: iso(row.created_at),
    settlementTxHash: row.settlement_tx_hash ?? null,
    payTo: row.pay_to ?? null,
    /** The USDC amount frozen when this charge was raised, in token units. */
    chainAmount: quote?.amount ?? null,
    quoteRate: quote?.rate ?? null,
    quoteAsOf: quote?.asOf ?? null,
    /** Carried on chain so a receipt names the charge it settles. */
    memo: `globie:interest:${row.id}`,
  };
}
