-- Only validated, text-free rows may be staged. Raw files/identifiers never enter this schema.
CREATE TABLE finance.ingestion_batch (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,
 generation uuid NOT NULL,key_version uuid NOT NULL,request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 versions jsonb NOT NULL,status text NOT NULL CHECK(status IN ('accepted','processing','completed','partial','invalidated')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 PRIMARY KEY(user_id,id)
);
CREATE UNIQUE INDEX one_active_ingestion ON finance.ingestion_batch(user_id) WHERE status IN ('accepted','processing');
CREATE TABLE finance.ingestion_file (
 user_id text NOT NULL,id uuid NOT NULL,batch_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 1 AND 10),
 bank text NOT NULL CHECK(bank IN ('tbank','ozon','sber','other')),file_hmac text NOT NULL CHECK(file_hmac ~ '^[0-9a-f]{64}$'),
 rows_found integer NOT NULL CHECK(rows_found BETWEEN 0 AND 1000),blocked boolean NOT NULL,error text CHECK(error='LOCAL_READ_FAILED'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,batch_id,position),FOREIGN KEY(user_id,batch_id) REFERENCES finance.ingestion_batch(user_id,id) ON DELETE CASCADE,
 CHECK(blocked=(error IS NOT NULL))
);
CREATE INDEX ON finance.ingestion_file(user_id,bank,file_hmac);
CREATE TABLE finance.ingestion_row (
 user_id text NOT NULL,id uuid NOT NULL,file_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 1000),
 status text NOT NULL CHECK(status IN ('pending','imported','issue')),payload jsonb,
 issue text CHECK(issue IN ('INVALID_DATE','INVALID_AMOUNT','INVALID_CURRENCY','INVALID_ACCOUNT','INVALID_DIRECTION','INVALID_BANK_REFERENCE','INVALID_PSEUDONYM','IMPORT_INVALIDATED','ACCOUNT_MATCH_CONFLICT')),
 outcome text CHECK(outcome IN ('created','existing','updated')),observation_id uuid,
 alias_kind text CHECK(alias_kind IN ('bank_account','card','loan_contract')),alias_hmac text CHECK(alias_hmac ~ '^[0-9a-f]{64}$'),
 direction text CHECK(direction IN ('debit','credit','unknown')),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,file_id,ordinal),
 FOREIGN KEY(user_id,file_id) REFERENCES finance.ingestion_file(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,observation_id) REFERENCES finance.source_observation(user_id,id) ON DELETE CASCADE,
 CHECK((status='pending' AND payload IS NOT NULL AND issue IS NULL AND outcome IS NULL AND observation_id IS NULL AND alias_hmac IS NULL)
 OR (status='issue' AND payload IS NULL AND issue IS NOT NULL AND outcome IS NULL AND observation_id IS NULL AND alias_hmac IS NULL)
 OR (status='imported' AND payload IS NULL AND issue IS NULL AND outcome IS NOT NULL AND observation_id IS NOT NULL AND alias_kind IS NOT NULL AND alias_hmac IS NOT NULL AND direction IS NOT NULL))
);
CREATE INDEX ON finance.ingestion_row(user_id,alias_kind,alias_hmac) WHERE status='imported';
CREATE TABLE finance.ingestion_account (
 user_id text NOT NULL,id uuid NOT NULL,batch_id uuid NOT NULL,account_id uuid NOT NULL,
 PRIMARY KEY(user_id,id),UNIQUE(user_id,batch_id,account_id),
 FOREIGN KEY(user_id,batch_id) REFERENCES finance.ingestion_batch(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,account_id) REFERENCES finance.account(user_id,id) ON DELETE CASCADE
);
CREATE TABLE finance.duplicate_candidate (
 user_id text NOT NULL,id uuid NOT NULL,left_id uuid NOT NULL,right_id uuid NOT NULL,
 PRIMARY KEY(user_id,id),UNIQUE(user_id,left_id,right_id),CHECK(left_id<right_id),
 FOREIGN KEY(user_id,left_id) REFERENCES finance.transaction(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,right_id) REFERENCES finance.transaction(user_id,id) ON DELETE CASCADE
);
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate'] LOOP
  EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON finance.%I TO finance_api',name);
  EXECUTE format('REVOKE ALL ON finance.%I FROM PUBLIC,control_api,mail_finance,mail_control',name);
  EXECUTE format('CREATE TRIGGER immutable_identity BEFORE UPDATE ON finance.%I FOR EACH ROW EXECUTE FUNCTION finance.fixed_tenant()',name);
 END LOOP;
END $$;
-- Scheduler exposes only job tenant/batch IDs, no rows, fingerprints, dates or amounts.
CREATE TABLE finance.ingestion_dispatch (
 user_id text NOT NULL,batch_id uuid NOT NULL,next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),attempts integer NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,batch_id),FOREIGN KEY(user_id,batch_id) REFERENCES finance.ingestion_batch(user_id,id) ON DELETE CASCADE
);
ALTER TABLE finance.ingestion_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.ingestion_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduler_metadata ON finance.ingestion_dispatch FOR SELECT TO finance_api USING(true);
CREATE POLICY own_insert ON finance.ingestion_dispatch FOR INSERT TO finance_api WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY own_update ON finance.ingestion_dispatch FOR UPDATE TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY own_delete ON finance.ingestion_dispatch FOR DELETE TO finance_api USING(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON finance.ingestion_dispatch TO finance_api;
REVOKE ALL ON finance.ingestion_dispatch FROM PUBLIC,control_api,mail_finance,mail_control;
