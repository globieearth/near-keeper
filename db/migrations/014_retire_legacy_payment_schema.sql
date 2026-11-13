-- Globie Keeper on NEAR — retire the pre-NEAR payment schema.
--
-- 001/003/006/009 no longer create any of these objects, so a freshly migrated
-- database never sees them. This file exists for databases that were migrated
-- before that cleanup: it removes the leftovers and brings the migration ledger
-- in line with the files on disk.
--
-- Every statement is idempotent, so re-running this file is a no-op.

-- Identity columns from the retired provider login.
drop index if exists users_paypal_payer_id_unique;
alter table users
  drop column if exists paypal_email,
  drop column if exists paypal_verified,
  drop column if exists paypal_linked_at,
  drop column if exists paypal_payer_id;

-- Payee details per group.
alter table members
  drop column if exists paypal_email,
  drop column if exists paypal_merchant_id;

-- Checkout handles on a share.
drop index if exists shares_paypal_order_idx;
alter table shares
  drop column if exists paypal_order_id,
  drop column if exists paypal_capture_id,
  drop column if exists paypal_approve_url;

-- Checkout handles on a tip.
drop index if exists tips_order_idx;
drop index if exists tips_capture_idx;
alter table tips
  drop column if exists paypal_order_id,
  drop column if exists paypal_capture_id,
  drop column if exists paypal_approve_url;

-- Login state machines and one-time handoffs from the redirect flow.
drop table if exists paypal_login_states;
drop table if exists auth_handoffs;

-- Webhook intake: NEAR settlement is pull-verified by tx hash, so there is no
-- pushed event to receive or de-duplicate.
drop table if exists webhook_events;
drop table if exists webhook_receipts;

-- Money rows: nothing may keep pointing at the retired provider, and new rows
-- default to the only provider the API writes.
delete from payments where provider = 'paypal';
alter table payments alter column provider set default 'near_transfer';

-- The ledger only names files that exist. The runner keys on names alone, so
-- removing the rows of deleted migration files is safe.
delete from schema_migrations
 where name in ('005_paypal_login.sql', '014_drop_paypal.sql');
