-- Shareable pay links.
--
-- A member can forward a link instead of asking someone to install the app and
-- sign in. The token is a bearer secret of 192 bits, so guessing one is not a
-- search anyone can finish, and it reveals only one share's payment
-- instructions: the amount, the payee and the memo.
--
-- A link is read-only. It never charges anything; the payer still signs the
-- NEP-141 `ft_transfer` in their own wallet, and the ledger moves only when a
-- verified receipt comes back.
--
-- One live token per share: forwarding the same link twice reuses the row, so a
-- share cannot accumulate a family of links that each look authoritative.

create table if not exists share_pay_links (
  token text primary key,
  share_id uuid not null unique references shares(id) on delete cascade,
  created_by_member_id uuid references members(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table share_pay_links is
  'Bearer links to one share''s payment instructions, resolved by GET /api/pay/:token; the share still settles only through a verified NEP-141 transfer';
