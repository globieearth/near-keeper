-- Social money — bounties that pay contributors out of a Sputnik DAO treasury.
--
-- NEAR track 12 ("Coordinate value together") asks for programmable rewards on
-- top of an existing multisig. The multisig itself is not rebuilt here: a group
-- registers the Sputnik DAO it already owns (or the Trezu vault that wraps one)
-- in `dao_treasuries`, and every payout leaves through a proposal the DAO's own
-- policy decides. The server never holds a key and never custody money, exactly
-- like a share settlement or a Globie Fund gift.
--
-- This file only adds tables. Nothing that existed before is altered, and no
-- bounty row is written into `ledger_events`, `points_awards` or `payments`:
--   * `ledger_events` is read in full by `GET /groups/:id/timeline`, so a
--     bounty event there would change the group's chat history.
--   * `points_awards` feeds `GET /groups/:id/leaderboard`; bounty reputation is
--     a different scale and lives in `contributor_trust`.
--   * `payments.share_id` is NOT NULL, so a payout cannot be a payment row.
-- `bounty_events` and `contributor_trust` are this feature's own record.
--
-- One engine, three presets. `bounties.source` says why the reward exists:
--   fronting    a member put their own money up first and is paid back with a
--               premium (source = 'fronting', often generated from a bill)
--   collection  a member chased the group's debtors and earns a finder's fee
--               (source = 'collection')
--   manual      any other community job: design, translation, moderation
-- Presets differ only in default copy and category; the lifecycle and the
-- payout policy are shared, which is what keeps this one feature rather than
-- three half-features.

-- ---------------------------------------------------------------------------
-- Treasuries — the Sputnik DAO (or Trezu vault) a group pays from
-- ---------------------------------------------------------------------------

create table if not exists dao_treasuries (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups (id) on delete cascade,
  label text not null,
  network text not null default 'testnet' check (network in ('testnet', 'mainnet')),
  dao_account text not null,
  source text not null default 'sputnik' check (source in ('sputnik', 'trezu')),
  -- Role names are read from the live policy; these are the defaults a fresh
  -- Sputnik DAO ships with, and the API re-reads `get_policy` on every payout.
  auto_role text not null default 'payout',
  council_role text not null default 'council',
  auto_approve_cap_minor bigint not null default 500
    check (auto_approve_cap_minor > 0),
  mid_approve_cap_minor bigint not null default 2500
    check (mid_approve_cap_minor > 0),
  period_days int not null default 30 check (period_days between 1 and 365),
  period_cap_minor bigint not null default 10000 check (period_cap_minor > 0),
  policy jsonb,
  policy_synced_at timestamptz,
  created_by uuid references members (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (group_id, dao_account),
  check (mid_approve_cap_minor >= auto_approve_cap_minor),
  check (period_cap_minor >= mid_approve_cap_minor)
);

comment on table dao_treasuries is
  'A Sputnik DAO (or a Trezu vault in front of one) that a group pays bounties from. The DAO keeps the money; the server only prepares proposals';
comment on column dao_treasuries.dao_account is
  'Account id of the DAO contract, e.g. globie-demo.sputnik-dao.near. The policy is read from this account, never assumed';
comment on column dao_treasuries.source is
  'sputnik: a plain *.sputnik-dao.near. trezu: a Trezu workspace, which is the same contract with a different UI';
comment on column dao_treasuries.auto_role is
  'Policy role allowed to approve the smallest payouts. The API still enforces auto_approve_cap_minor before proposing';
comment on column dao_treasuries.auto_approve_cap_minor is
  'Largest payout a trusted contributor can be paid without a second approval, in minor units of the group currency';
comment on column dao_treasuries.period_cap_minor is
  'Total bounty spend allowed per period_days. Anything beyond the remaining room escalates to the DAO council';
comment on column dao_treasuries.policy is
  'Last snapshot of the on-chain get_policy result: roles, thresholds and vote policy. Display only; policy_synced_at says how old it is';

create index if not exists dao_treasuries_group_idx
  on dao_treasuries (group_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Bounties
-- ---------------------------------------------------------------------------

create table if not exists bounties (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups (id) on delete cascade,
  treasury_id uuid references dao_treasuries (id) on delete set null,
  title text not null,
  description text not null,
  category text not null default 'general',
  source text not null default 'manual'
    check (source in ('fronting', 'collection', 'manual')),
  asset text not null default 'near' check (asset in ('near', 'usdc')),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD',
  chain_amount numeric(40, 0) not null check (chain_amount > 0),
  status text not null default 'open'
    check (status in ('open', 'claimed', 'submitted', 'approved', 'paid',
                      'rejected', 'cancelled')),
  visibility text not null default 'group'
    check (visibility in ('group', 'public')),
  deadline timestamptz,
  claimer_member_id uuid references members (id) on delete set null,
  claimed_at timestamptz,
  created_by uuid not null references members (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table bounties is
  'One reward a group is offering. The reward is a fixed amount, not an hourly rate: claiming is a promise to deliver, and approval releases the payout';
comment on column bounties.source is
  'fronting: pay back a member who fronted cash. collection: fee for chasing debt. manual: any other community job';
comment on column bounties.asset is
  'near: native Transfer action from the DAO. usdc: NEP-141 ft_transfer. chain_amount is frozen in that asset own units';
comment on column bounties.chain_amount is
  'Exact amount the DAO proposal will move: yoctoNEAR for native, token base units for USDC. Frozen when the bounty is created';
comment on column bounties.status is
  'open → claimed → submitted → approved → paid. rejected and cancelled are terminal. Only approved may be paid';
comment on column bounties.visibility is
  'public bounties render on the shareable board; group bounties need a session';

create index if not exists bounties_group_idx
  on bounties (group_id, created_at desc);
create index if not exists bounties_open_idx
  on bounties (group_id, status) where status in ('open', 'claimed', 'submitted');
create index if not exists bounties_public_idx
  on bounties (group_id, created_at desc) where visibility = 'public';
create index if not exists bounties_claimer_idx
  on bounties (claimer_member_id) where claimer_member_id is not null;

-- ---------------------------------------------------------------------------
-- Claims — who says they did the work, and who agrees
-- ---------------------------------------------------------------------------

create table if not exists bounty_claims (
  id uuid primary key default gen_random_uuid(),
  bounty_id uuid not null references bounties (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  note text not null,
  evidence_url text,
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'rejected')),
  submitted_at timestamptz not null default now(),
  decided_by uuid references members (id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  unique (bounty_id, member_id)
);

comment on table bounty_claims is
  'A contributor submission for one bounty. One row per member per bounty, so a retry cannot double-submit';
comment on column bounty_claims.evidence_url is
  'Optional link to the delivered work. Never fetched by the server; shown as text';

create index if not exists bounty_claims_bounty_idx
  on bounty_claims (bounty_id, submitted_at desc);
create index if not exists bounty_claims_member_idx
  on bounty_claims (member_id, submitted_at desc);

-- ---------------------------------------------------------------------------
-- Events — this feature's own ledger (never ledger_events)
-- ---------------------------------------------------------------------------

create table if not exists bounty_events (
  id uuid primary key default gen_random_uuid(),
  bounty_id uuid not null references bounties (id) on delete cascade,
  group_id uuid not null references groups (id) on delete cascade,
  actor_member_id uuid references members (id) on delete set null,
  event_type text not null,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table bounty_events is
  'Append-only history for a bounty. Kept separate from ledger_events so the group timeline and chat never change';
comment on column bounty_events.event_type is
  'e.g. bounty.created, bounty.claimed, claim.submitted, claim.approved, payout.proposed, payout.executed';

create index if not exists bounty_events_bounty_idx
  on bounty_events (bounty_id, created_at asc);
create index if not exists bounty_events_group_idx
  on bounty_events (group_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Payouts — the proposal that actually moves the money
-- ---------------------------------------------------------------------------

create table if not exists bounty_payouts (
  id uuid primary key default gen_random_uuid(),
  bounty_id uuid not null references bounties (id) on delete cascade,
  claim_id uuid not null unique references bounty_claims (id) on delete cascade,
  treasury_id uuid not null references dao_treasuries (id) on delete restrict,
  recipient_account text not null,
  asset text not null check (asset in ('near', 'usdc')),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  chain_amount numeric(40, 0) not null check (chain_amount > 0),
  tier text not null check (tier in ('auto', 'council_one', 'dao')),
  policy_role text not null,
  required_approvals int not null default 1 check (required_approvals between 1 and 32),
  proposal_id text,
  proposal_tx_hash text,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'executed', 'failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table bounty_payouts is
  'The payout decided by the tier engine. `proposal_id` is filled after the wallet publishes add_proposal, and `status` follows the on-chain proposal';
comment on column bounty_payouts.tier is
  'auto: trusted contributor under the small cap. council_one: one extra approval. dao: full council proposal, used for large or untrusted payouts';
comment on column bounty_payouts.policy_role is
  'Role the proposal is addressed to. Its on-chain threshold is what required_approvals mirrors';
comment on column bounty_payouts.recipient_account is
  'Contributor NEAR account frozen when the claim was approved. A payout can never be redirected afterwards';

create index if not exists bounty_payouts_bounty_idx
  on bounty_payouts (bounty_id, created_at desc);
create index if not exists bounty_payouts_status_idx
  on bounty_payouts (status) where status in ('proposed', 'approved');

-- ---------------------------------------------------------------------------
-- Contributor trust — the reputation that unlocks the auto tier
-- ---------------------------------------------------------------------------

create table if not exists contributor_trust (
  group_id uuid not null references groups (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  score int not null default 0 check (score between 0 and 100),
  completed_count int not null default 0 check (completed_count >= 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  last_paid_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (group_id, member_id)
);

comment on table contributor_trust is
  'Persisted reputation per member per group. Only executed bounty payouts raise it, so a claim that is never paid cannot farm the auto tier';
comment on column contributor_trust.score is
  '0-100. 30 unlocks the small auto tier, 60 unlocks the mid tier. Recomputed from completed_count and paid_minor on every executed payout';
comment on column contributor_trust.paid_minor is
  'Lifetime bounty money paid to this member in this group, minor units of the group currency';
