-- Globie Keeper — members reimburse the fronter directly (DEV_PLAN §2.9).
--
-- The fronter settles the merchant bill however they like (cash, card,
-- PromptPay — anything outside this app). Members then reimburse them with a
-- NEP-141 transfer to the fronter's own NEAR account, verified by tx hash. The
-- platform never holds the money, which retires the payout batch that used to
-- send it back from ours.

-- `payouts` only tracked batches sent from the platform account.
alter table tips drop column if exists payout_id;
drop table if exists payouts;
