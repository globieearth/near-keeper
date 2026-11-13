-- Split-mode votes — the group chooses "split evenly" or "split by line item"
-- without one member silently deciding for everyone.
--
-- `agreements.split_mode` is the mode the creator proposed and the mode every
-- member consents to in `terms_snapshot`. It is not enough on its own for two
-- reasons:
--
--   1. Members have different intentions. A housemate renting a room wants an
--      even split; a table of friends who ordered very different plates wants
--      line items. Whoever creates the agreement should not overrule the rest.
--   2. A single expense inside a running tab may deserve a different rule than
--      the agreement it belongs to. The choice therefore has to exist at both
--      levels: on the agreement, and per bill.
--
-- One row per (agreement, member) and per (bill, member). Re-voting updates the
-- row in place; abstaining is the absence of a row. Resolution is computed, not
-- stored: majority wins, the fronter breaks a tie, and no votes at all falls
-- back to `agreements.split_mode`. Keeping the outcome derived means a member
-- who changes their mind is honoured immediately, and the audit trail lives in
-- `ledger_events` rather than in a duplicated column that can drift.
--
-- Only two modes are votable. `weighted`, `quantity` and `exact` remain valid
-- stored values for older agreements and for `quantity_claim` bills, but they
-- are not choices a group votes between.

-- ---------------------------------------------------------------------------
-- Votes on the agreement
-- ---------------------------------------------------------------------------

create table if not exists agreement_split_votes (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  mode text not null check (mode in ('itemised', 'equal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agreement_id, member_id)
);

create index if not exists agreement_split_votes_agreement_idx
  on agreement_split_votes (agreement_id);

comment on table agreement_split_votes is
  'One vote per member on how an agreement total should be divided; absence of a row means abstained';
comment on column agreement_split_votes.mode is
  'itemised: each member takes the line items they consumed. equal: the total is divided evenly between active members';

-- ---------------------------------------------------------------------------
-- Votes on one bill
-- ---------------------------------------------------------------------------

create table if not exists bill_split_votes (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  mode text not null check (mode in ('itemised', 'equal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bill_id, member_id)
);

create index if not exists bill_split_votes_bill_idx
  on bill_split_votes (bill_id);

comment on table bill_split_votes is
  'Per-expense override of the agreement split choice; when present these votes outrank the agreement votes';
comment on column bill_split_votes.mode is
  'itemised: each member takes the line items they consumed. equal: the bill total is divided evenly between active members';
