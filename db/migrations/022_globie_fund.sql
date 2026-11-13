-- Globie Fund — adopt a tree in the Isaan sanctuary, paid on NEAR.
--
-- The legacy Globie Earth page collected this money through PayPal. This
-- project must not carry that rail, so a gift here is a plain transfer from
-- the donor's own wallet to the sanctuary's account: either a NEP-141
-- `ft_transfer` of USDC or a native NEAR `Transfer` action. The server holds
-- no key and never touches the money, exactly like a share settlement.
--
-- A gift is a *deed*, not an order. There is no cart, no checkout session and
-- nothing to refund: the deed exists the moment a confirmed transfer is read
-- back from the chain. `settlement_tx_hash` is unique, so a replayed
-- settlement attempt cannot mint a second deed — the same replay guard that
-- `payments(provider, provider_ref)` gives a share.
--
-- The catalogue is the Globie MCP server's species list (`mcp.globie.earth`,
-- tool `search_forest_knowledge`), cached here so the donate screen still
-- renders when the MCP is unreachable. Price is not an MCP field — the
-- sanctuary sets it — so `unit_price_minor` is local and never overwritten by
-- a sync.

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

create table if not exists fund_projects (
  id text primary key,
  name text not null,
  latin_name text not null,
  thai_name text,
  story text not null,
  need_level text not null check (need_level in ('urgent', 'critical', 'steady')),
  need_note text not null,
  unit_price_minor bigint not null check (unit_price_minor > 0),
  currency char(3) not null default 'USD',
  source text not null default 'seed' check (source in ('seed', 'mcp')),
  synced_at timestamptz,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

comment on table fund_projects is
  'Species the sanctuary is asking to have adopted. Cache of the Globie MCP catalogue plus local seeds';
comment on column fund_projects.unit_price_minor is
  'Price of one sapling in minor units of `currency` (USD 5.00 = 500). A gift total is qty * this value';
comment on column fund_projects.source is
  'seed: shipped in this migration. mcp: last refreshed from mcp.globie.earth. Price stays local either way';

-- ---------------------------------------------------------------------------
-- Quotes — the exact integer the wallet signs, frozen before it opens
-- ---------------------------------------------------------------------------

create table if not exists fund_quotes (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references fund_projects (id) on delete restrict,
  user_id uuid references users (id) on delete set null,
  payer_account text not null,
  qty int not null check (qty between 1 and 1000),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD',
  asset text not null check (asset in ('usdc', 'near')),
  chain_amount numeric(40, 0) not null check (chain_amount > 0),
  quote_rate numeric(24, 12) not null,
  quote_as_of timestamptz not null,
  treasury_account text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table fund_quotes is
  'One frozen donation quote. `chain_amount` is exactly what the wallet is asked to sign and what settlement verifies';
comment on column fund_quotes.quote_rate is
  'USD per one unit of the ledger currency at quote_as_of; for native NEAR it also carries the NEAR price used';
comment on column fund_quotes.expires_at is
  'After this the quote is dead: a transfer found later cannot be attached to it';

create index if not exists fund_quotes_user_idx
  on fund_quotes (user_id, created_at desc);
create index if not exists fund_quotes_expiry_idx
  on fund_quotes (expires_at);

-- ---------------------------------------------------------------------------
-- Deeds
-- ---------------------------------------------------------------------------

create sequence if not exists fund_deed_ref_seq start 1;

create table if not exists fund_deeds (
  id uuid primary key default gen_random_uuid(),
  deed_ref text not null unique default (
    'GLB-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('fund_deed_ref_seq')::text, 6, '0')
  ),
  quote_id uuid not null unique references fund_quotes (id) on delete restrict,
  project_id text not null references fund_projects (id) on delete restrict,
  user_id uuid references users (id) on delete set null,
  payer_account text not null,
  qty int not null check (qty between 1 and 1000),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD',
  asset text not null check (asset in ('usdc', 'near')),
  chain_amount numeric(40, 0) not null check (chain_amount > 0),
  treasury_account text not null,
  provider text not null default 'near_transfer',
  settlement_tx_hash text not null unique,
  -- Deed number issued by mcp.globie.earth, when its adopt_species call succeeded.
  mcp_deed_ref text,
  mcp_synced_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table fund_deeds is
  'One adopted tree gift. Written only after the transfer is verified on chain; never before';
comment on column fund_deeds.deed_ref is
  'Human-readable certificate id shown on the screen, e.g. GLB-2026-000131';
comment on column fund_deeds.payer_account is
  'NEAR account that signed the transfer, as reported by the chain — not as claimed by the client';
comment on column fund_deeds.asset is
  'usdc: NEP-141 ft_transfer of NEAR_USDC_CONTRACT. near: native Transfer action, chain_amount is yoctoNEAR';
comment on column fund_deeds.chain_amount is
  'Exact amount read back from the chain in the asset own units: 6 decimals for USDC, 24 for native NEAR';
comment on column fund_deeds.treasury_account is
  'Recipient frozen at quote time. A transfer to any other account is rejected at settlement';
comment on column fund_deeds.mcp_deed_ref is
  'Living Deed number returned by mcp.globie.earth adopt_species. Null is allowed: a chain payment is real even when the MCP is down';

create index if not exists fund_deeds_recent_idx
  on fund_deeds (created_at desc);
create index if not exists fund_deeds_project_idx
  on fund_deeds (project_id, created_at desc);
create index if not exists fund_deeds_user_idx
  on fund_deeds (user_id, created_at desc) where user_id is not null;
create index if not exists fund_deeds_payer_idx
  on fund_deeds (lower(payer_account), created_at desc);

-- ---------------------------------------------------------------------------
-- Seeds — the two trees on the live donate page
-- ---------------------------------------------------------------------------

insert into fund_projects
  (id, name, latin_name, thai_name, story, need_level, need_note,
   unit_price_minor, currency, source, sort_order)
values
  ('yang-na', 'Yang Na', 'Dipterocarpus alatus', 'ต้นยางนา',
   'Deep-rooting giants that restore soil moisture, resist wildfire sweeps, capture massive carbon, and support community resin taps.',
   'urgent', 'URGENT RESIN PILLAR',
   500, 'USD', 'seed', 1),
  ('kae-na', 'Kae Na', 'Dolichandrone serrulata', 'ต้นแคนา',
   'Fast-growing pioneer tree producing edible medicinal blossoms. Fixes depleted paddy fields and builds canopy corridors.',
   'critical', 'CRITICAL NEED',
   500, 'USD', 'seed', 2)
on conflict (id) do nothing;
