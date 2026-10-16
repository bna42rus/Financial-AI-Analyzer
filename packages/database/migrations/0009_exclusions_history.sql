ALTER TABLE finance.action ADD change_set jsonb CHECK(change_set IS NULL OR jsonb_typeof(change_set)='array');
ALTER TABLE finance.action ADD affected_operation_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX ON finance.action USING gin(affected_operation_ids);
ALTER TABLE finance.component ADD revision bigint NOT NULL DEFAULT 0;
ALTER TABLE finance.account_alias ADD revision bigint NOT NULL DEFAULT 0;
ALTER TABLE finance.observation_account ADD revision bigint NOT NULL DEFAULT 0;
ALTER TABLE finance.counterparty_alias ADD revision bigint NOT NULL DEFAULT 0;
ALTER TABLE finance.observation_counterparty ADD revision bigint NOT NULL DEFAULT 0;
ALTER TABLE finance.workspace ADD config_revision bigint NOT NULL DEFAULT 0;
CREATE FUNCTION finance.advance_object_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.revision=OLD.revision+1;RETURN NEW;END $$;
CREATE FUNCTION finance.advance_config_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.config_revision=OLD.config_revision+CASE WHEN NEW.loan_mode IS DISTINCT FROM OLD.loan_mode THEN 1 ELSE 0 END;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION finance.advance_object_revision(),finance.advance_config_revision() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['account','category','counterparty','transaction','component','link','rule','account_alias','observation_account','counterparty_alias','observation_counterparty'] LOOP
  EXECUTE format('CREATE TRIGGER advance_revision BEFORE UPDATE ON finance.%I FOR EACH ROW EXECUTE FUNCTION finance.advance_object_revision()',name);
 END LOOP;
END $$;
CREATE TRIGGER advance_config_revision BEFORE UPDATE ON finance.workspace FOR EACH ROW EXECUTE FUNCTION finance.advance_config_revision();
