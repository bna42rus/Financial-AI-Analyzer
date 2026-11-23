-- Only tenant-keyed complete identifiers; no bank files or plaintext recipient details.
CREATE TABLE finance.observation_peer_account(
 user_id text NOT NULL,
 observation_id uuid NOT NULL,
 bank_id text NOT NULL CHECK(bank_id IN ('tbank','ozon','sber','other')),
 alias_type text NOT NULL CHECK(alias_type IN ('bank_account','bank_contract','card','loan_contract')),
 alias_hmac text NOT NULL CHECK(alias_hmac ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(user_id,observation_id,bank_id,alias_type,alias_hmac),
 FOREIGN KEY(user_id,observation_id) REFERENCES finance.source_observation(user_id,id) ON DELETE CASCADE
);
ALTER TABLE finance.observation_peer_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.observation_peer_account FORCE ROW LEVEL SECURITY;
CREATE POLICY observation_peer_tenant ON finance.observation_peer_account USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,DELETE ON finance.observation_peer_account TO finance_api;
-- Revisit previously automatic interpretations once after the upgrade.
ALTER TABLE finance.workspace ADD COLUMN classifier_dictionary_initialized boolean NOT NULL DEFAULT false;
GRANT UPDATE(classifier_dictionary_initialized) ON finance.workspace TO finance_api;
