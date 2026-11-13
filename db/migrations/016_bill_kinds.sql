-- Any shared cost, not only dinner — and a signature over the terms.
--
-- Until now every table assumed a restaurant: a group held exactly one
-- agreement, an agreement held one receipt with tax and service charge, and an
-- "accept" was a bare insert with no evidence of what the member agreed to.
-- A trip with four expenses, a rent split with no receipt, and a bulk order
-- split by units all had nowhere to live.
--
-- Three independent axes replace the implicit "dinner" default:
--   kind        what the money is for     (meal, trip, rent, group_buy, …)
--   split_mode  how it divides            (itemised, equal, weighted, quantity, exact)
--   capture     where the numbers came from (receipt_vision, manual, invoice, quantity_claim)
-- They are separate columns on purpose: a shared flat has a rent agreement with
-- an equal split and a manual bill, while that same group's utility bill is a
-- different agreement with the same split mode.
--
-- The consent columns are the second half. `terms_hash` is sha256 over the
-- canonical JSON of `terms_snapshot`; `consent_level` records whether the
-- fronter asked only for a NEP-413 signature ('signed', costs nothing, works
-- with any wallet) or additionally for a public record in the shared registry
-- contract ('anchored', 'anchor_tx_hash' is set once the receipt lands). The
-- hash is what makes a later dispute checkable: change any term and every
-- signature over the old hash stops matching.

-- ---------------------------------------------------------------------------
-- Three axes
-- ---------------------------------------------------------------------------

alter table groups
  add column if not exists kind text not null default 'meal';

alter table groups
  drop constraint if exists groups_kind_check;
alter table groups
  add constraint groups_kind_check check (kind in (
    'meal', 'group_buy', 'groceries', 'rent', 'utilities',
    'trip', 'gift', 'subscription', 'event', 'other'
  ));

comment on column groups.kind is
  'Default vocabulary for the group. meal/event/gift/subscription hold one active agreement at a time; the rest may hold many';

alter table agreements
  add column if not exists kind text not null default 'meal',
  add column if not exists split_mode text not null default 'itemised',
  add column if not exists recurrence text not null default 'none';

alter table agreements
  drop constraint if exists agreements_kind_check;
alter table agreements
  add constraint agreements_kind_check check (kind in (
    'meal', 'group_buy', 'groceries', 'rent', 'utilities',
    'trip', 'gift', 'subscription', 'event', 'other'
  ));

alter table agreements
  drop constraint if exists agreements_split_mode_check;
alter table agreements
  add constraint agreements_split_mode_check check (split_mode in (
    'itemised', 'equal', 'weighted', 'quantity', 'exact'
  ));

alter table agreements
  drop constraint if exists agreements_recurrence_check;
alter table agreements
  add constraint agreements_recurrence_check check (recurrence in (
    'none', 'weekly', 'monthly'
  ));

comment on column agreements.kind is
  'One agreement is one expense. A trip or rent group may hold several at once; a meal group may not';
comment on column agreements.split_mode is
  'Which allocation path the bill expects. itemised/equal/weighted/quantity all resolve through allocate(); exact stores a stated amount per member';
comment on column agreements.recurrence is
  'none for one-offs. weekly/monthly mark a rent or subscription that should be cloned into the next period';

alter table bills
  add column if not exists kind text not null default 'meal',
  add column if not exists source text not null default 'receipt_vision',
  add column if not exists title text;

alter table bills
  drop constraint if exists bills_source_check;
alter table bills
  add constraint bills_source_check check (source in (
    'receipt_vision', 'manual', 'invoice', 'quantity_claim'
  ));

comment on column bills.source is
  'receipt_vision needs an uploaded photo or video before parsing; manual, invoice and quantity_claim never touch the vision pipeline';
comment on column bills.title is
  'Human label for a bill that has no merchant, e.g. "Hotel, 2 nights" or "October rent"';

alter table bill_items
  add column if not exists kind text,
  add column if not exists unit text;

comment on column bill_items.kind is
  'Optional line category inside a bill, e.g. food, alcohol, service, fuel, ticket; null means uncategorised';
comment on column bill_items.unit is
  'Unit label for quantity claims — kg, bottle, case, seat. quantity_claim bills state what one unit means';

-- ---------------------------------------------------------------------------
-- Signed consent
-- ---------------------------------------------------------------------------

alter table agreements
  add column if not exists terms_hash text,
  add column if not exists consent_level text not null default 'signed';

alter table agreements
  drop constraint if exists agreements_consent_level_check;
alter table agreements
  add constraint agreements_consent_level_check check (consent_level in (
    'signed', 'anchored'
  ));

comment on column agreements.terms_hash is
  'sha256 of the canonical JSON of terms_snapshot. Written at creation and never rewritten; a changed term produces a new hash and invalidates earlier signatures';
comment on column agreements.consent_level is
  'signed: NEP-413 signature only, no gas, no contract. anchored: the same signature plus a record_acceptance call in the shared registry contract';

alter table agreement_acceptances
  add column if not exists near_account text,
  add column if not exists public_key text,
  add column if not exists signature text,
  add column if not exists nonce text,
  add column if not exists terms_hash text,
  add column if not exists signed_at timestamptz,
  add column if not exists anchor_tx_hash text;

comment on column agreement_acceptances.near_account is
  'The NEAR account that signed, taken from the wallet answer; must match members.near_account when one is linked';
comment on column agreement_acceptances.public_key is
  'ed25519:<base58> key that produced the signature. Kept so the signature can be checked again while that key is still on the account';
comment on column agreement_acceptances.signature is
  'base64 of the 64-byte ed25519 signature over the NEP-413 digest of the terms message';
comment on column agreement_acceptances.nonce is
  'base64 of the 32 raw nonce bytes; the same nonce is single-use and is replayed into the payload digest at verification time';
comment on column agreement_acceptances.terms_hash is
  'The hash the member actually signed. Compared against agreements.terms_hash on every read of the acceptance';
comment on column agreement_acceptances.anchor_tx_hash is
  'Hash of the record_acceptance transaction in the registry contract; null while unanchored, including for every "signed" acceptance';

-- One account can only ever record one acceptance per agreement. This is
-- separate from the (agreement_id, member_id) unique key because a member may
-- rotate their linked account and the wallet answer is what arrives first.
create unique index if not exists agreement_acceptances_account_unique
  on agreement_acceptances (agreement_id, near_account)
  where near_account is not null;

-- Drives the re-anchor retry: every anchored agreement whose acceptance has a
-- signature but no transaction hash yet needs another attempt.
create index if not exists agreement_acceptances_unanchored_idx
  on agreement_acceptances (agreement_id)
  where anchor_tx_hash is null and signature is not null;

-- Lookup shape for "which agreements in this group are still open", used by
-- GET /api/groups/:id once a group may hold more than one.
create index if not exists agreements_group_status_idx
  on agreements (group_id, status, created_at desc);
