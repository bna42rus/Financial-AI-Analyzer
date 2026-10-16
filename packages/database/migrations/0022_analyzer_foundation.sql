CREATE TABLE finance.analyzer_chat (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,
 title text NOT NULL DEFAULT 'Новый диалог' CHECK(length(title) BETWEEN 1 AND 100),pinned boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),modified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id)
);
CREATE TABLE finance.analyzer_message (
 user_id text NOT NULL, id uuid NOT NULL,chat_id uuid NOT NULL,question text NOT NULL CHECK(length(question) BETWEEN 1 AND 2000),
 answer jsonb NOT NULL CHECK(jsonb_typeof(answer)='object'),context jsonb,request jsonb NOT NULL,
 action_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,chat_id) REFERENCES finance.analyzer_chat(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,action_id) REFERENCES finance.action(user_id,id) ON DELETE SET NULL (action_id)
);
CREATE TABLE finance.analyzer_dependency (
 user_id text NOT NULL,message_id uuid NOT NULL,transaction_id uuid NOT NULL,PRIMARY KEY(user_id,message_id,transaction_id),
 FOREIGN KEY(user_id,message_id) REFERENCES finance.analyzer_message(user_id,id) ON DELETE CASCADE
);
CREATE INDEX analyzer_dependency_operation ON finance.analyzer_dependency(user_id,transaction_id);
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['analyzer_chat','analyzer_message','analyzer_dependency'] LOOP
 EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON finance.%I TO finance_api',t);
 EXECUTE format('REVOKE ALL ON finance.%I FROM PUBLIC,control_api,mail_finance,mail_control',t);
END LOOP;END $$;
CREATE TRIGGER immutable_identity BEFORE UPDATE ON finance.analyzer_chat FOR EACH ROW EXECUTE FUNCTION finance.fixed_tenant();
CREATE TRIGGER immutable_identity BEFORE UPDATE ON finance.analyzer_message FOR EACH ROW EXECUTE FUNCTION finance.fixed_tenant();

-- Deletion/cancellation must also remove dependent snapshots, text and semantic context.
-- Drop the affected conversation rather than leave a follow-up based on deleted facts.
CREATE FUNCTION finance.purge_analyzer_dependencies() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE operation_id uuid;
BEGIN
 IF TG_TABLE_NAME='transaction' THEN operation_id=OLD.id;ELSE operation_id=finance.canonical_operation(OLD.user_id,OLD.transaction_id);END IF;
 DELETE FROM finance.analyzer_chat c WHERE c.user_id=OLD.user_id AND EXISTS (
  SELECT 1 FROM finance.analyzer_message m JOIN finance.analyzer_dependency d ON (d.user_id,d.message_id)=(m.user_id,m.id)
  WHERE (m.user_id,m.chat_id)=(c.user_id,c.id) AND d.transaction_id=operation_id
 );RETURN OLD;
END $$;
CREATE TRIGGER analyzer_transaction_delete BEFORE DELETE ON finance.transaction FOR EACH ROW EXECUTE FUNCTION finance.purge_analyzer_dependencies();
CREATE TRIGGER analyzer_source_delete BEFORE DELETE ON finance.source_observation FOR EACH ROW EXECUTE FUNCTION finance.purge_analyzer_dependencies();
CREATE FUNCTION finance.purge_analyzer_reset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.key_version<>OLD.key_version THEN DELETE FROM finance.analyzer_chat WHERE user_id=OLD.user_id;END IF;RETURN NEW;END $$;
CREATE TRIGGER analyzer_reset BEFORE UPDATE OF generation ON finance.workspace FOR EACH ROW EXECUTE FUNCTION finance.purge_analyzer_reset();
REVOKE ALL ON FUNCTION finance.purge_analyzer_dependencies(),finance.purge_analyzer_reset() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;

-- Only usage metadata crosses the financial/control boundary; deletion never refunds AI usage.
CREATE TABLE commerce.analyzer_usage (
 user_id text NOT NULL REFERENCES commerce.access_cycle(user_id) ON DELETE CASCADE REFERENCES identity.auth_user(id) ON DELETE CASCADE,request_id uuid NOT NULL,
 anchor_at timestamptz NOT NULL,period_start timestamptz NOT NULL,units integer NOT NULL CHECK(units>0),
 input_tokens integer NOT NULL CHECK(input_tokens>=0),output_tokens integer NOT NULL CHECK(output_tokens>=0),
 provider text NOT NULL,model text NOT NULL,provider_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,request_id)
);
ALTER TABLE commerce.analyzer_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.analyzer_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY own_usage ON commerce.analyzer_usage TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY control_usage ON commerce.analyzer_usage TO control_api USING(true);
GRANT SELECT,INSERT ON commerce.analyzer_usage TO finance_api;
GRANT SELECT ON commerce.analyzer_usage TO control_api;
REVOKE ALL ON commerce.analyzer_usage FROM PUBLIC,mail_finance,mail_control;

CREATE FUNCTION finance.purge_analyzer_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 DELETE FROM finance.analyzer_chat c WHERE c.user_id=OLD.user_id AND EXISTS(SELECT 1 FROM finance.analyzer_message m WHERE (m.user_id,m.chat_id)=(c.user_id,c.id) AND strpos(m.request::text||m.answer::text||COALESCE(m.context::text,''),OLD.id::text)>0);RETURN OLD;END $$;
CREATE TRIGGER analyzer_account_delete BEFORE DELETE ON finance.account FOR EACH ROW EXECUTE FUNCTION finance.purge_analyzer_scope();
REVOKE ALL ON FUNCTION finance.purge_analyzer_scope() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
