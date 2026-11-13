-- Email sign-in codes.
--
-- `POST /api/auth/session` used to accept an email string as proof of identity,
-- so anyone who guessed an address could take over that account. A session now
-- needs a code that was delivered to the address itself.
--
-- Only the sha256 hash is stored, so a database reader cannot sign in with it.
-- A code lives for LOGIN_CODE_TTL_MINUTES (10 by default), is consumed exactly
-- once, and dies after five wrong guesses. `DEMO_LOGIN_CODE` (config) bypasses
-- this table entirely so the demo still works with no SMTP server.

create table if not exists login_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Lookup is "the newest live code for this address"; the throttle counts the
-- rows created for the address in the last hour.
create index if not exists login_codes_email_created_idx
  on login_codes (lower(email), created_at desc);

comment on table login_codes is
  'Single-use email sign-in codes. Only the sha256 hash of the six-digit code is stored; a row is consumed by POST /api/auth/session';
comment on column login_codes.attempts is
  'Wrong guesses against this code; the row is consumed when it reaches five so six digits cannot be brute-forced';
