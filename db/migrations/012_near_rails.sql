-- Globie Keeper on NEAR — the login and settlement rails.
--
-- Additive on purpose: these columns are added in their own migration so the
-- API can be deployed before the old schema is retired. 014 does that removal.
--
-- Money stays BIGINT minor units in ISO-4217 exponents. The chain stores the
-- token in its own decimals (USDC/NEP-141 = 6), so `near_chain_amount()` in
-- lib/near.ts is the only place that converts between the two.

-- ---------------------------------------------------------------------------
-- Identity: a NEAR account is the login (NEP-413 signed message, not OAuth).
-- ---------------------------------------------------------------------------

alter table users
  add column if not exists near_account text,
  add column if not exists near_public_key text,
  add column if not exists near_verified boolean not null default false,
  add column if not exists near_linked_at timestamptz;

-- One wallet owns at most one Globie account. lower() because NEAR account ids
-- are case-insensitive for implicit accounts and cheap to normalise here.
create unique index if not exists users_near_account_unique
  on users (lower(near_account)) where near_account is not null;

-- Nonces in flight: only the hash is stored, and
-- the signed message binds account + recipient + callback so a captured nonce
-- cannot be replayed on a different origin or surface.
create table if not exists near_login_nonces (
  nonce_hash text primary key,
  account_id text not null,
  recipient text not null,
  return_to text not null default 'web' check (return_to in ('web', 'native')),
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists near_login_nonces_created_idx
  on near_login_nonces (created_at);

-- ---------------------------------------------------------------------------
-- Treasury: each agreement can point at a sub-account acting as its treasury.
-- Function Call Keys scoped to that sub-account are what the agent is allowed
-- to use; the full-access key stays with the human.
-- ---------------------------------------------------------------------------

alter table members
  add column if not exists near_account text,
  add column if not exists near_subaccount text;

alter table agreements
  add column if not exists treasury_account text;

-- ---------------------------------------------------------------------------
-- Settlement: a NEP-141 transfer hash is the receipt. An unfunded cross-chain
-- deposit is tracked by the Intents quote + deposit address until it lands.
-- ---------------------------------------------------------------------------

alter table shares
  add column if not exists settlement_tx_hash text,
  add column if not exists intent_quote_id text,
  add column if not exists intent_deposit_address text;

create unique index if not exists shares_settlement_tx_unique
  on shares (settlement_tx_hash) where settlement_tx_hash is not null;

create index if not exists shares_intent_deposit_idx
  on shares (intent_deposit_address) where intent_deposit_address is not null;

alter table tips
  add column if not exists settlement_tx_hash text,
  add column if not exists intent_quote_id text,
  add column if not exists intent_deposit_address text;

create unique index if not exists tips_settlement_tx_unique
  on tips (settlement_tx_hash) where settlement_tx_hash is not null;

-- `payments` already keys on (provider, provider_ref), so a NEAR settlement is
-- just provider = 'near_transfer' and provider_ref = the tx hash. No schema
-- change needed; lib/settlement.ts takes the provider from SettleInput.

-- ---------------------------------------------------------------------------
-- Event spine: keep chain facts queryable without parsing raw_payload.
-- ---------------------------------------------------------------------------

create index if not exists ledger_events_rail_idx
  on ledger_events ((metadata ->> 'rail'), time desc)
  where metadata ? 'rail';
