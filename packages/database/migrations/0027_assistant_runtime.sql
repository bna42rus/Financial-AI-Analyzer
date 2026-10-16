-- New assistant state is opt-in. Historical task receipts retain their identity.
ALTER TABLE commerce.analyzer_request DROP CONSTRAINT analyzer_request_step_check;
ALTER TABLE commerce.analyzer_request ADD CONSTRAINT analyzer_request_step_check
 CHECK(step IN ('gate','plan','assistant_0','assistant_1','assistant_2'));

-- A financial calendar preference, independent of the commercial Moscow cycle.
-- No default timezone: the client must explicitly initialize a valid profile.
CREATE TABLE finance.assistant_profile (
 user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100)
);
CREATE TABLE finance.assistant_conversation (
 user_id text NOT NULL,chat_id uuid NOT NULL,chat_epoch uuid NOT NULL,generation uuid NOT NULL,
 conversation jsonb NOT NULL CHECK(jsonb_typeof(conversation)='object'),
 PRIMARY KEY(user_id,chat_id),
 FOREIGN KEY(user_id,chat_id,chat_epoch) REFERENCES finance.analyzer_chat(user_id,id,epoch) ON DELETE CASCADE
);
CREATE TABLE finance.assistant_run (
 user_id text NOT NULL,request_id uuid NOT NULL,
 workflow text NOT NULL,receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 PRIMARY KEY(user_id,request_id),
 FOREIGN KEY(user_id,request_id) REFERENCES finance.analyzer_task_request(user_id,id) ON DELETE CASCADE,
 CHECK(octet_length(receipt::text)<=2097152),
 CHECK(jsonb_typeof(receipt->'calls')='array' AND jsonb_array_length(receipt->'calls')<=3),
 CHECK((receipt ? 'result')=(receipt ? 'conversation'))
);
CREATE FUNCTION finance.fixed_assistant_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW.user_id,NEW.request_id,NEW.workflow) IS DISTINCT FROM ROW(OLD.user_id,OLD.request_id,OLD.workflow)
 OR NEW.receipt->>'fingerprint' IS DISTINCT FROM OLD.receipt->>'fingerprint'
 OR jsonb_array_length(NEW.receipt->'calls')<jsonb_array_length(OLD.receipt->'calls')
 OR OLD.receipt ? 'result' AND NEW.receipt IS DISTINCT FROM OLD.receipt
 THEN RAISE EXCEPTION 'IMMUTABLE_ASSISTANT_RECEIPT';END IF;RETURN NEW;END $$;
CREATE TRIGGER fixed_run BEFORE UPDATE ON finance.assistant_run FOR EACH ROW EXECUTE FUNCTION finance.fixed_assistant_run();
REVOKE ALL ON FUNCTION finance.fixed_assistant_run() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['assistant_profile','assistant_conversation','assistant_run'] LOOP
 EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON finance.%I TO finance_api',t);
 EXECUTE format('REVOKE ALL ON finance.%I FROM PUBLIC,control_api,mail_finance,mail_control',t);
END LOOP;END $$;

CREATE FUNCTION finance.assistant_generation_reset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.generation<>OLD.generation AND NEW.key_version=OLD.key_version THEN
  UPDATE finance.assistant_conversation SET generation=NEW.generation,
   conversation=jsonb_set(conversation,'{book,scope,generation}',to_jsonb(NEW.generation::text)) WHERE user_id=OLD.user_id;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER assistant_generation_reset BEFORE UPDATE OF generation ON finance.workspace FOR EACH ROW EXECUTE FUNCTION finance.assistant_generation_reset();
REVOKE ALL ON FUNCTION finance.assistant_generation_reset() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;

-- Include the pending category draft; it is absent from the successful book.
CREATE FUNCTION finance.purge_assistant_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE reference_id uuid;
BEGIN
 IF TG_TABLE_NAME='source_observation' THEN reference_id=finance.canonical_operation(OLD.user_id,OLD.transaction_id);ELSE reference_id=OLD.id;END IF;
 DELETE FROM finance.analyzer_chat c WHERE c.user_id=OLD.user_id AND EXISTS(
  SELECT 1 FROM finance.assistant_conversation a WHERE (a.user_id,a.chat_id)=(c.user_id,c.id)
   AND strpos(a.conversation::text,reference_id::text)>0);
 RETURN OLD;
END $$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['transaction','source_observation','account','category','counterparty'] LOOP
 EXECUTE format('CREATE TRIGGER assistant_reference_delete BEFORE DELETE ON finance.%I FOR EACH ROW EXECUTE FUNCTION finance.purge_assistant_reference()',t);
END LOOP;END $$;
REVOKE ALL ON FUNCTION finance.purge_assistant_reference() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
