-- Globie Keeper — settlement plumbing.
-- A settlement carries a receipt reference, so a payment row must be findable
-- by it. For NEAR that reference is the NEP-141 transfer hash.

-- One payment row per receipt. NULL refs stay distinct, so the constraint only
-- guards rows that a verified settlement actually wrote.
create unique index if not exists payments_provider_ref_unique
  on payments (provider, provider_ref);
