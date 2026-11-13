/**
 * The closed vocabularies introduced in migration 016 and specified in
 * DEV_PLAN §2.21. Kept in one module so the routes, the vision prompt and the
 * client cannot disagree about spelling.
 */

/** What kind of shared cost a group holds. */
export const GROUP_KINDS = [
  'meal',
  'group_buy',
  'groceries',
  'rent',
  'utilities',
  'trip',
  'gift',
  'subscription',
  'event',
  'other',
] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

/** How a bill's total is divided among members. */
export const SPLIT_MODES = [
  'itemised',
  'equal',
  'weighted',
  'quantity',
  'exact',
] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];

/**
 * The two ways a group may choose to divide a bill, and therefore the only
 * values a split vote can carry. `weighted`, `quantity` and `exact` stay in
 * `SPLIT_MODES` for older rows and `quantity_claim` bills, but they are not
 * something the group votes between.
 */
export const SPLIT_VOTES = ['itemised', 'equal'] as const;
export type SplitVote = (typeof SPLIT_VOTES)[number];

/** How often an agreement repeats. `none` is a one-off. */
export const RECURRENCES = ['none', 'weekly', 'monthly'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

/** Where a bill's line items came from. */
export const BILL_SOURCES = [
  'receipt_vision',
  'manual',
  'invoice',
  'quantity_claim',
] as const;
export type BillSource = (typeof BILL_SOURCES)[number];

/** How acceptance is proven: a wallet signature, or a signature plus an anchor. */
export const CONSENT_LEVELS = ['signed', 'anchored'] as const;
export type ConsentLevel = (typeof CONSENT_LEVELS)[number];

/**
 * The late-fee rule agreed when an agreement is created. `none` is a real
 * choice, stored and hashed, not an absent column.
 */
export const INTEREST_MODES = ['none', 'monthly'] as const;
export type InterestMode = (typeof INTEREST_MODES)[number];

/**
 * Kinds that are a running tab rather than a single occasion. These may hold
 * several live agreements at once; the rest keep the "one active agreement"
 * rule that protects a dinner from a second, contradictory split.
 */
export const MULTI_EXPENSE_KINDS = new Set<GroupKind>([
  'group_buy',
  'groceries',
  'trip',
  'rent',
  'utilities',
]);

export function allowsMultipleAgreements(kind: string | null | undefined): boolean {
  return MULTI_EXPENSE_KINDS.has((kind ?? 'meal') as GroupKind);
}
