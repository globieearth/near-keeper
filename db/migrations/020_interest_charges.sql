-- Late fees — an agreed percentage after the deadline, not a surprise line item.
--
-- A late fee cannot live in `shares`. `shares` is unique per (bill_id,
-- member_id) and every bill-side guard asserts `sum(shares.amount) =
-- bills.total`; adding an interest row there would make the bill un-finalisable
-- and un-requestable. It cannot live in `payments` either, because
-- `payments.share_id` is NOT NULL and a late fee is money owed to the fronter,
-- not a payment of the share.
--
-- So it mirrors `tips`: its own row, its own amount, its own frozen quote, its
-- own settlement transaction hash. The difference is the debtor: a tip flows
-- passthrough fronter -> member, a late fee flows member -> fronter, and only
-- the fronter may raise it, only after the share's `due_at`.
--
-- The rate is agreed when the agreement is created and written into
-- `terms_snapshot`, so the member consents to the rule before any fee can be
-- charged. `interest_mode = 'none'` is an explicit stored choice, not an absent
-- column: "no late fee" is then provable inside the signed terms hash.

-- ---------------------------------------------------------------------------
-- The agreed rule, on the agreement
-- ---------------------------------------------------------------------------

alter table agreements
  add column if not exists interest_mode text not null default 'none',
  add column if not exists interest_rate_bps int,
  add column if not exists interest_cap_bps int;

alter table agreements
  drop constraint if exists agreements_interest_mode_check;
alter table agreements
  add constraint agreements_interest_mode_check check (interest_mode in (
    'none', 'monthly'
  ));

alter table agreements
  drop constraint if exists agreements_interest_rate_check;
alter table agreements
  add constraint agreements_interest_rate_check check (
    interest_mode = 'none'
    or (interest_rate_bps is not null and interest_rate_bps > 0 and interest_rate_bps <= 10000)
  );

alter table agreements
  drop constraint if exists agreements_interest_cap_check;
alter table agreements
  add constraint agreements_interest_cap_check check (
    interest_cap_bps is null
    or (interest_cap_bps > 0 and interest_cap_bps <= 10000)
  );

comment on column agreements.interest_mode is
  'none: no late fee was agreed. monthly: interest_rate_bps per started month after shares.due_at. Copied into terms_snapshot and covered by terms_hash';
comment on column agreements.interest_rate_bps is
  'Late fee in basis points of the share amount per started month late; null when interest_mode is none';
comment on column agreements.interest_cap_bps is
  'Ceiling in basis points of the share amount; the accrual never quotes more than this. Null means uncapped';

-- ---------------------------------------------------------------------------
-- The charge itself
-- ---------------------------------------------------------------------------

create table if not exists interest_charges (
  id uuid primary key default gen_random_uuid(),
  -- The share being penalised. One charge per share: raising again reuses the
  -- row and re-quotes it rather than stacking a second penalty.
  share_id uuid not null references shares (id) on delete cascade,
  bill_id uuid not null references bills (id) on delete cascade,
  agreement_id uuid not null references agreements (id) on delete cascade,
  -- The member who owes it, and the fronter who is owed.
  member_id uuid not null references members (id) on delete cascade,
  to_member_id uuid not null references members (id),
  -- The rule as it stood when the charge was raised, so a later agreement edit
  -- cannot retroactively change a quoted fee.
  rate_bps int not null check (rate_bps > 0 and rate_bps <= 10000),
  cap_bps int,
  days_late int not null check (days_late >= 0),
  amount bigint not null check (amount > 0),
  currency char(3) not null,
  status text not null default 'requested'
    check (status in ('requested', 'paid', 'waived', 'failed')),
  settlement_tx_hash text,
  -- Frozen at raise time, exactly like shares and tips (migration 015).
  quoted_chain_amount bigint,
  quote_rate numeric(24, 12),
  quote_as_of timestamptz,
  raised_at timestamptz not null default now(),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (share_id)
);

create index if not exists interest_charges_bill_idx
  on interest_charges (bill_id, created_at desc);
create index if not exists interest_charges_member_idx
  on interest_charges (member_id, status);
create index if not exists interest_charges_to_member_idx
  on interest_charges (to_member_id, status);

comment on column interest_charges.amount is
  'Interest owed in the bill currency minor units; computed at raise time from rate_bps, days_late and the share amount, capped at cap_bps of that share';
comment on column interest_charges.rate_bps is
  'The rate that produced this charge, copied from agreements.interest_rate_bps so a later agreement edit cannot change a quoted fee';
comment on column interest_charges.days_late is
  'Whole days between shares.due_at and raised_at, as observed when the charge was raised';
comment on column interest_charges.quoted_chain_amount is
  'USDC base units this late fee was quoted at; the amount verifyTransfer() requires';
comment on column interest_charges.quote_rate is
  'USD per one unit of the bill currency, as published at quote_as_of';
