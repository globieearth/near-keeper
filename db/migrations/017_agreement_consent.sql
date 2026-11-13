-- NEP-413 consent: one single-use challenge per member per agreement.
--
-- The signed payload is
--   sha256(u32le(2^31+413) || borsh{message, nonce, recipient, callbackUrl})
-- so verification needs the exact message, the exact 32 nonce bytes and the
-- recipient the wallet displayed. A hash alone cannot rebuild any of them,
-- which is why this table mirrors `near_login_nonces` (013) rather than the
-- older hash-only shape.
--
-- Rows live for ten minutes and are pruned on the next mint, the same bounded
-- cleanup the sign-in nonce uses — no scheduled job.

create table if not exists agreement_consent_nonces (
  nonce_hash text primary key,
  agreement_id uuid not null references agreements(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  nonce text not null,
  message text not null,
  recipient text not null,
  terms_hash text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

-- Cleanup scans the tail of this index; the lookup key is the primary key.
create index if not exists agreement_consent_nonces_created_idx
  on agreement_consent_nonces (created_at);

comment on table agreement_consent_nonces is
  'Single-use NEP-413 challenges for accepting agreement terms. Consumed inside POST /api/agreements/:id/accept; a replayed nonce finds no live row';
comment on column agreement_consent_nonces.nonce is
  'base64 of the 32 raw bytes the wallet signs; borsh field order is message, nonce, recipient, callbackUrl';
comment on column agreement_consent_nonces.message is
  'exact string shown to and signed by the wallet — consentMessage(agreementId, termsHash)';
comment on column agreement_consent_nonces.recipient is
  'host the challenge was issued on; baked into the digest, so a challenge cannot be replayed against another domain';
comment on column agreement_consent_nonces.terms_hash is
  'terms hash at mint time. If agreements.terms_hash has moved on by the time the signature arrives, the accept is refused with 409 terms_changed';
