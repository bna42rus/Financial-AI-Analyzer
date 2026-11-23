-- Reclassify only automatic statement facets, lazily under the user's workspace lock.
-- Source observations, amounts, matching fingerprints and owner corrections remain intact.
ALTER TABLE finance.workspace ADD COLUMN bank_events_repaired boolean NOT NULL DEFAULT false;
GRANT UPDATE(bank_events_repaired) ON finance.workspace TO finance_api;
