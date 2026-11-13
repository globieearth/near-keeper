-- NEP-413 needs the raw bytes that were signed, not just their hash.
--
-- 012 stored only nonce_hash because a nonce is a one-time lookup key. But the
-- signature covers sha256(u32le(2^31+413) || borsh{message, nonce, recipient,
-- callbackUrl}), so verification has to rebuild the payload with the exact
-- 32 nonce bytes and the exact message string the wallet displayed. Hashing
-- alone cannot reconstruct either of them.
--
-- Nonce rows live for minutes, so the two deletes below are a no-op in
-- practice: they only clear in-flight rows created before this migration so
-- `not null` can be enforced.

-- A nonce is requested before the wallet says which account is signing, so the
-- account is only a hint: when present the signature must match it, when null
-- the account is taken from the wallet's answer.
alter table near_login_nonces
  add column if not exists nonce text,
  add column if not exists message text,
  add column if not exists callback_url text,
  alter column account_id drop not null;

delete from near_login_nonces where nonce is null or message is null;

alter table near_login_nonces
  alter column nonce set not null,
  alter column message set not null;

comment on column near_login_nonces.nonce is
  'base64 of the 32 raw bytes the wallet signed; borsh field order is message, nonce, recipient, callbackUrl';
comment on column near_login_nonces.message is
  'exact string shown to and signed by the wallet';
comment on column near_login_nonces.callback_url is
  'borsh Option<String>; null means the field was absent when the payload was built';
