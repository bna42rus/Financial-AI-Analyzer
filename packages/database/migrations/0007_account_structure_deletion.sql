-- Source account facts stay immutable; matching assignments are separate decisions.
ALTER TABLE finance.account ADD merged_into_id uuid;
ALTER TABLE finance.account ADD FOREIGN KEY(user_id,merged_into_id) REFERENCES finance.account(user_id,id);
ALTER TABLE finance.account ADD CHECK(merged_into_id IS DISTINCT FROM id);
ALTER TABLE finance.rule ADD dependency_status text NOT NULL DEFAULT 'ready' CHECK(dependency_status IN ('ready','needs_setup'));
CREATE TABLE finance.observation_account (
 user_id text NOT NULL,observation_id uuid NOT NULL,account_id uuid NOT NULL,
 PRIMARY KEY(user_id,observation_id),
 FOREIGN KEY(user_id,observation_id) REFERENCES finance.source_observation(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,account_id) REFERENCES finance.account(user_id,id)
);
-- The migration owner backfills existing rows atomically; runtime RLS stays enforced.
ALTER TABLE finance.source_observation NO FORCE ROW LEVEL SECURITY;
INSERT INTO finance.observation_account SELECT user_id,id,account_id FROM finance.source_observation;
ALTER TABLE finance.source_observation FORCE ROW LEVEL SECURITY;
CREATE INDEX ON finance.observation_account(user_id,account_id);
CREATE TABLE finance.account_alias (
 user_id text NOT NULL,id uuid NOT NULL,account_id uuid NOT NULL,alias_type text NOT NULL,
 alias_hmac text NOT NULL CHECK(alias_hmac ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,alias_type,alias_hmac),
 FOREIGN KEY(user_id,account_id) REFERENCES finance.account(user_id,id)
);
CREATE INDEX ON finance.account_alias(user_id,account_id);
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['observation_account','account_alias'] LOOP
  EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON finance.%I TO finance_api',name);
 END LOOP;
END $$;
REVOKE ALL ON finance.observation_account,finance.account_alias FROM PUBLIC,control_api,mail_finance,mail_control;
CREATE TRIGGER immutable_alias BEFORE UPDATE ON finance.account_alias FOR EACH ROW EXECUTE FUNCTION finance.fixed_tenant();
CREATE FUNCTION finance.fixed_observation_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN IF NEW.user_id<>OLD.user_id OR NEW.observation_id<>OLD.observation_id THEN RAISE EXCEPTION 'immutable identity'; END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION finance.fixed_observation_binding() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE TRIGGER immutable_observation_binding BEFORE UPDATE ON finance.observation_account FOR EACH ROW EXECUTE FUNCTION finance.fixed_observation_binding();
