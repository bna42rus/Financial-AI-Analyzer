-- Stable per-user pseudonymization keys live outside ordinary financial tables.
ALTER TABLE finance.workspace ADD key_version uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE finance.workspace ADD interface_epoch uuid NOT NULL DEFAULT gen_random_uuid();
CREATE FUNCTION finance.fixed_key_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN IF NEW.key_version IS DISTINCT FROM OLD.key_version AND current_user='finance_api' THEN RAISE EXCEPTION 'key rotation capability required' USING ERRCODE='42501'; END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION finance.fixed_key_version() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE TRIGGER protected_key_version BEFORE UPDATE ON finance.workspace FOR EACH ROW EXECUTE FUNCTION finance.fixed_key_version();
CREATE TABLE protected_keys.pseudonym_key (
 user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 version uuid NOT NULL, sealed_key text NOT NULL CHECK(length(sealed_key) BETWEEN 1 AND 4096),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE protected_keys.pseudonym_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE protected_keys.pseudonym_key FORCE ROW LEVEL SECURITY;
CREATE POLICY own_key ON protected_keys.pseudonym_key USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
REVOKE ALL ON protected_keys.pseudonym_key FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
-- The API can use only these tenant-bound capabilities, not SELECT the protected schema.
CREATE FUNCTION finance.ensure_pseudonym_key(expected_generation uuid,expected_version uuid,candidate text)
RETURNS TABLE(version uuid,sealed_key text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=current_setting('app.user_id',true);
BEGIN
 IF tenant IS NULL OR tenant='' OR NOT EXISTS(SELECT 1 FROM finance.workspace w WHERE w.user_id=tenant AND w.generation=expected_generation AND w.key_version=expected_version FOR UPDATE) THEN RAISE EXCEPTION 'stale pseudonym context' USING ERRCODE='40001'; END IF;
 INSERT INTO protected_keys.pseudonym_key(user_id,version,sealed_key) VALUES(tenant,expected_version,candidate) ON CONFLICT(user_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM protected_keys.pseudonym_key k WHERE k.user_id=tenant AND k.version=expected_version) THEN RAISE EXCEPTION 'key version mismatch' USING ERRCODE='40001'; END IF;
 RETURN QUERY SELECT k.version,k.sealed_key FROM protected_keys.pseudonym_key k WHERE k.user_id=tenant;
END $$;
CREATE FUNCTION finance.rotate_pseudonym_key(expected_generation uuid,expected_version uuid,new_generation uuid,new_version uuid,candidate text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=current_setting('app.user_id',true);
BEGIN
 IF tenant IS NULL OR tenant='' OR new_generation=expected_generation OR new_version=expected_version OR NOT EXISTS(SELECT 1 FROM finance.workspace w WHERE w.user_id=tenant AND w.generation=expected_generation AND w.key_version=expected_version FOR UPDATE) THEN RAISE EXCEPTION 'stale pseudonym context' USING ERRCODE='40001'; END IF;
 INSERT INTO protected_keys.pseudonym_key(user_id,version,sealed_key) VALUES(tenant,new_version,candidate)
 ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version,sealed_key=EXCLUDED.sealed_key,created_at=clock_timestamp();
 UPDATE finance.workspace SET generation=new_generation,key_version=new_version WHERE user_id=tenant;
END $$;
REVOKE ALL ON FUNCTION finance.ensure_pseudonym_key(uuid,uuid,text),finance.rotate_pseudonym_key(uuid,uuid,uuid,uuid,text) FROM PUBLIC,control_api,mail_finance,mail_control;
GRANT EXECUTE ON FUNCTION finance.ensure_pseudonym_key(uuid,uuid,text),finance.rotate_pseudonym_key(uuid,uuid,uuid,uuid,text) TO finance_api;
CREATE TABLE finance.ingestion_context (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,
 generation uuid NOT NULL,key_version uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
 PRIMARY KEY(user_id,id)
);
ALTER TABLE finance.ingestion_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.ingestion_context FORCE ROW LEVEL SECURITY;
CREATE POLICY own_data ON finance.ingestion_context TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,DELETE ON finance.ingestion_context TO finance_api;
REVOKE ALL ON finance.ingestion_context FROM PUBLIC,control_api,mail_finance,mail_control;
