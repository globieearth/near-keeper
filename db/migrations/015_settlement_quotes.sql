-- A settlement quote is the number the wallet signs.
--
-- Before this, `chainAmount` was a pass-through of the ledger amount: one group
-- currency unit was written as one USDC, so a ฿50.00 tip was quoted as 50 USDC
-- while the same amount rendered as `≈ $1.49`. The quote now comes from the FX
-- rate table and is frozen on the row it belongs to.
--
-- Freezing is what makes it safe: the member signs exactly the integer we
-- quoted, and `verifyTransfer()` compares against the same stored integer. A
-- rate that moves after the wallet opened cannot turn a correct transfer into
-- `near_tx_wrong_amount`.

alter table shares
  add column if not exists quoted_chain_amount bigint,
  add column if not exists quote_rate numeric(24, 12),
  add column if not exists quote_as_of timestamptz;

alter table tips
  add column if not exists quoted_chain_amount bigint,
  add column if not exists quote_rate numeric(24, 12),
  add column if not exists quote_as_of timestamptz;

comment on column shares.quoted_chain_amount is
  'USDC base units this share was quoted at; the amount verifyTransfer() requires';
comment on column tips.quoted_chain_amount is
  'USDC base units this tip was quoted at; the amount verifyTransfer() requires';
comment on column shares.quote_rate is
  'USD per one unit of the bill currency, as published at quote_as_of';
comment on column tips.quote_rate is
  'USD per one unit of the bill currency, as published at quote_as_of';
