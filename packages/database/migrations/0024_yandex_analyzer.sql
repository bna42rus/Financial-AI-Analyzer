-- External-call tombstones contain no question, provider text or financial result.
CREATE TABLE commerce.analyzer_request (
 user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,step text NOT NULL CHECK(step IN ('gate','plan')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('sent','received','completed','failed','unknown')),
 provider text NOT NULL DEFAULT 'yandex-ai-studio',model text NOT NULL,
 model_version text,error_code text,input_tokens integer NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
 output_tokens integer NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 period_start timestamptz,anchor_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,request_id,step)
);
CREATE INDEX analyzer_request_day ON commerce.analyzer_request(user_id,created_at);
ALTER TABLE commerce.analyzer_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.analyzer_request FORCE ROW LEVEL SECURITY;
CREATE POLICY own_request ON commerce.analyzer_request TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,UPDATE ON commerce.analyzer_request TO finance_api;
REVOKE ALL ON commerce.analyzer_request FROM PUBLIC,control_api,mail_finance,mail_control;
CREATE FUNCTION commerce.fixed_analyzer_request() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW.user_id,NEW.request_id,NEW.step,NEW.fingerprint,NEW.provider,NEW.model,NEW.period_start,NEW.anchor_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.user_id,OLD.request_id,OLD.step,OLD.fingerprint,OLD.provider,OLD.model,OLD.period_start,OLD.anchor_at,OLD.created_at)
 THEN RAISE EXCEPTION 'IMMUTABLE_REQUEST';END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION commerce.fixed_analyzer_request() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE TRIGGER immutable_identity BEFORE UPDATE ON commerce.analyzer_request FOR EACH ROW EXECUTE FUNCTION commerce.fixed_analyzer_request();

-- Only parsed, bounded plans are cached. They are financial-private, and follow
-- the existing chat/source-deletion/full-reset cascades, unlike billing metadata.
CREATE TABLE finance.analyzer_provider_plan (
 user_id text NOT NULL,request_id uuid NOT NULL,step text NOT NULL,
 chat_id uuid NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 PRIMARY KEY(user_id,request_id,step),
 FOREIGN KEY(user_id,request_id,step) REFERENCES commerce.analyzer_request(user_id,request_id,step),
 FOREIGN KEY(user_id,chat_id) REFERENCES finance.analyzer_chat(user_id,id) ON DELETE CASCADE
);
ALTER TABLE finance.analyzer_provider_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.analyzer_provider_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY own_provider_plan ON finance.analyzer_provider_plan TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,DELETE ON finance.analyzer_provider_plan TO finance_api;
REVOKE ALL ON finance.analyzer_provider_plan FROM PUBLIC,control_api,mail_finance,mail_control;

-- A receipt can exist before the financial transaction creates a message and
-- its dependencies. Purge references in such pending plans as well.
CREATE FUNCTION finance.purge_analyzer_provider_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE reference_id uuid;
BEGIN
 IF TG_TABLE_NAME='source_observation' THEN reference_id=finance.canonical_operation(OLD.user_id,OLD.transaction_id);ELSE reference_id=OLD.id;END IF;
 DELETE FROM finance.analyzer_provider_plan WHERE user_id=OLD.user_id AND strpos(payload::text,reference_id::text)>0;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION finance.purge_analyzer_provider_reference() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['transaction','source_observation','account','category','counterparty'] LOOP
 EXECUTE format('CREATE TRIGGER analyzer_provider_reference_delete BEFORE DELETE ON finance.%I FOR EACH ROW EXECUTE FUNCTION finance.purge_analyzer_provider_reference()',t);
END LOOP;END $$;
