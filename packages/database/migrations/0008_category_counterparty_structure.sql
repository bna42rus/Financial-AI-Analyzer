ALTER TABLE finance.counterparty ADD merged_into_id uuid;
ALTER TABLE finance.counterparty ADD FOREIGN KEY(user_id,merged_into_id) REFERENCES finance.counterparty(user_id,id);
ALTER TABLE finance.counterparty ADD CHECK(merged_into_id IS DISTINCT FROM id);
CREATE TABLE finance.counterparty_alias (
 user_id text NOT NULL,id uuid NOT NULL,counterparty_id uuid NOT NULL,alias_type text NOT NULL,
 alias_hmac text NOT NULL CHECK(alias_hmac ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,counterparty_id,id),UNIQUE(user_id,alias_type,alias_hmac),
 FOREIGN KEY(user_id,counterparty_id) REFERENCES finance.counterparty(user_id,id)
);
CREATE TABLE finance.observation_counterparty (
 user_id text NOT NULL,observation_id uuid NOT NULL,counterparty_id uuid NOT NULL,alias_id uuid,
 PRIMARY KEY(user_id,observation_id),
 FOREIGN KEY(user_id,observation_id) REFERENCES finance.source_observation(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,counterparty_id) REFERENCES finance.counterparty(user_id,id),
 FOREIGN KEY(user_id,counterparty_id,alias_id) REFERENCES finance.counterparty_alias(user_id,counterparty_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ON finance.counterparty_alias(user_id,counterparty_id);
CREATE INDEX ON finance.observation_counterparty(user_id,counterparty_id);
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['counterparty_alias','observation_counterparty'] LOOP
  EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON finance.%I TO finance_api',name);
 END LOOP;
END $$;
REVOKE ALL ON finance.counterparty_alias,finance.observation_counterparty FROM PUBLIC,control_api,mail_finance,mail_control;
CREATE FUNCTION finance.fixed_counterparty_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.user_id<>OLD.user_id OR (TG_TABLE_NAME='counterparty_alias' AND (to_jsonb(NEW)->>'id' IS DISTINCT FROM to_jsonb(OLD)->>'id' OR to_jsonb(NEW)->>'alias_type' IS DISTINCT FROM to_jsonb(OLD)->>'alias_type' OR to_jsonb(NEW)->>'alias_hmac' IS DISTINCT FROM to_jsonb(OLD)->>'alias_hmac')) OR
 (TG_TABLE_NAME='observation_counterparty' AND (to_jsonb(NEW)->>'observation_id' IS DISTINCT FROM to_jsonb(OLD)->>'observation_id' OR to_jsonb(NEW)->>'alias_id' IS DISTINCT FROM to_jsonb(OLD)->>'alias_id')) THEN RAISE EXCEPTION 'immutable source identity'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finance.fixed_counterparty_source() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE TRIGGER immutable_counterparty_alias BEFORE UPDATE ON finance.counterparty_alias FOR EACH ROW EXECUTE FUNCTION finance.fixed_counterparty_source();
CREATE TRIGGER immutable_counterparty_binding BEFORE UPDATE ON finance.observation_counterparty FOR EACH ROW EXECUTE FUNCTION finance.fixed_counterparty_source();
