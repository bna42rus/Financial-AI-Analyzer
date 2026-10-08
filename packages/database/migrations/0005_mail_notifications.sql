-- Operator owned. Mail runtimes receive neither passwords/sessions nor financial data.
CREATE ROLE mail_finance NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE mail_control NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE SCHEMA mail;
REVOKE ALL ON SCHEMA mail FROM PUBLIC;
CREATE TABLE mail.delivery (
 id uuid PRIMARY KEY, source_schema text NOT NULL, source_scope text NOT NULL,
 kind text NOT NULL, subject_id text, created_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','sent','failed')), attempts integer NOT NULL,
 sent_at timestamptz, next_attempt_at timestamptz, last_error text,
 acceptance text CHECK(acceptance IS NULL OR acceptance='sandbox')
);
CREATE TABLE mail.sandbox_inbox (
 id uuid PRIMARY KEY REFERENCES mail.delivery ON DELETE CASCADE, source_scope text NOT NULL,
 sealed_message text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE mail.resend_audit (
 action_id uuid PRIMARY KEY, actor_id text NOT NULL, delivery_id uuid NOT NULL REFERENCES mail.delivery,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX delivery_subject ON mail.delivery(subject_id,kind,created_at);
CREATE FUNCTION mail.project_delivery() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM mail.delivery WHERE id=OLD.id; RETURN OLD; END IF;
 INSERT INTO mail.delivery(id,source_schema,source_scope,kind,subject_id,created_at,state,attempts,sent_at,next_attempt_at,last_error,acceptance)
 VALUES(NEW.id,TG_TABLE_SCHEMA,NEW.source_scope,NEW.kind,NEW.subject_id,NEW.created_at,NEW.state,NEW.attempts,NEW.sent_at,NEW.next_attempt_at,NEW.last_error,NEW.acceptance)
 ON CONFLICT(id) DO UPDATE SET subject_id=EXCLUDED.subject_id,state=EXCLUDED.state,attempts=EXCLUDED.attempts,sent_at=EXCLUDED.sent_at,next_attempt_at=EXCLUDED.next_attempt_at,last_error=EXCLUDED.last_error,acceptance=EXCLUDED.acceptance;
 IF NEW.state='sent' AND OLD.state IS DISTINCT FROM 'sent' AND NEW.kind='payment_claim' THEN
  UPDATE access.request SET data=jsonb_set(data,'{adminNotificationSentAt}',to_jsonb(NEW.sent_at)) WHERE id=NEW.subject_id;
 ELSIF NEW.state='sent' AND OLD.state IS DISTINCT FROM 'sent' AND NEW.kind='renewal_claim' THEN
  UPDATE commerce.renewal_request SET data=jsonb_set(data,'{adminNotificationSentAt}',to_jsonb(NEW.sent_at)) WHERE id=NEW.subject_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mail.project_delivery() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
DO $$ DECLARE s text; BEGIN
 FOREACH s IN ARRAY ARRAY['identity','control','access'] LOOP
  EXECUTE format('ALTER TABLE %I.outbox ADD source_scope text, ADD subject_id text, ADD expires_at timestamptz, ADD dedupe_key text, ADD sent_at timestamptz, ADD next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), ADD last_error text, ADD lease_id uuid, ADD lease_until timestamptz, ADD acceptance text, ADD retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count>=0)',s);
  EXECUTE format('UPDATE %I.outbox SET source_scope=CASE WHEN $1=''control'' OR kind IN (''invitation'',''payment_decision'',''renewal_decision'',''manual_access_changed'') THEN ''control'' ELSE ''finance'' END',s) USING s;
  EXECUTE format('ALTER TABLE %I.outbox ALTER source_scope SET NOT NULL, ADD CHECK(source_scope IN (''finance'',''control''))',s);
  EXECUTE format('CREATE UNIQUE INDEX ON %I.outbox(dedupe_key) WHERE dedupe_key IS NOT NULL',s);
  EXECUTE format('CREATE INDEX ON %I.outbox(next_attempt_at) WHERE state=''queued''',s);
  EXECUTE format('CREATE TRIGGER delivery_projection AFTER INSERT OR UPDATE OR DELETE ON %I.outbox FOR EACH ROW EXECUTE FUNCTION mail.project_delivery()',s);
  EXECUTE format('INSERT INTO mail.delivery(id,source_schema,source_scope,kind,subject_id,created_at,state,attempts,next_attempt_at) SELECT id,$1,source_scope,kind,subject_id,created_at,state,attempts,next_attempt_at FROM %I.outbox',s) USING s;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA mail TO finance_api,control_api,mail_finance,mail_control;
GRANT SELECT ON mail.delivery TO finance_api,control_api,mail_finance,mail_control;
ALTER TABLE mail.delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail.delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY control_metadata ON mail.delivery TO control_api USING(true);
CREATE POLICY user_metadata ON mail.delivery TO finance_api USING(subject_id=nullif(current_setting('app.user_id',true),''));
CREATE POLICY worker_metadata ON mail.delivery TO mail_finance,mail_control USING(source_scope=CASE current_user WHEN 'mail_finance' THEN 'finance' ELSE 'control' END);
GRANT SELECT,INSERT ON mail.resend_audit TO control_api;
GRANT USAGE ON SCHEMA identity,access,commerce TO mail_finance;
GRANT USAGE ON SCHEMA control,access,commerce TO mail_control;
GRANT SELECT,UPDATE,INSERT ON identity.outbox TO mail_finance;
GRANT SELECT,UPDATE ON control.outbox TO mail_control;
GRANT SELECT,UPDATE ON access.outbox TO mail_finance,mail_control;
ALTER TABLE access.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY api_enqueue ON access.outbox FOR INSERT TO finance_api,control_api WITH CHECK(source_scope=CASE current_user WHEN 'finance_api' THEN 'finance' ELSE 'control' END);
CREATE POLICY scoped_mail ON access.outbox TO mail_finance,mail_control USING(source_scope=CASE current_user WHEN 'mail_finance' THEN 'finance' ELSE 'control' END) WITH CHECK(source_scope=CASE current_user WHEN 'mail_finance' THEN 'finance' ELSE 'control' END);
GRANT SELECT(id,email,email_verified) ON identity.auth_user TO mail_finance;
GRANT SELECT(user_id,epoch,status) ON identity.security_state TO mail_finance;
GRANT SELECT ON identity.reset_token,access.email_token,access.registration_proof TO mail_finance;
GRANT SELECT(id,data) ON access.request TO mail_finance;
GRANT SELECT(id,email,email_verified) ON control.auth_user TO mail_control;
GRANT SELECT(user_id,epoch,status) ON control.security_state TO mail_control;
GRANT SELECT ON control.reset_token TO mail_control;
GRANT SELECT(id,verifier,purchase_id,manual_grant_id,state,expires_at,email) ON commerce.invitation TO mail_finance,mail_control;
GRANT SELECT(id,state) ON commerce.purchase TO mail_finance,mail_control;
GRANT SELECT(id,state,term) ON commerce.manual_grant TO mail_finance,mail_control;
GRANT SELECT(user_id,access_end,indefinite,revision,timezone) ON commerce.access_cycle TO mail_finance;
CREATE POLICY mail_cycles ON commerce.access_cycle FOR SELECT TO mail_finance USING(true);
GRANT SELECT,INSERT ON mail.sandbox_inbox TO mail_finance,mail_control;
ALTER TABLE mail.sandbox_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail.sandbox_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_scope ON mail.sandbox_inbox TO mail_finance,mail_control USING(source_scope=CASE current_user WHEN 'mail_finance' THEN 'finance' ELSE 'control' END) WITH CHECK(source_scope=CASE current_user WHEN 'mail_finance' THEN 'finance' ELSE 'control' END);
-- A closed, token-free resend function. Reset links are never returned or admin-resendable.
CREATE FUNCTION mail.retry_delivery(delivery uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row mail.delivery; affected integer; BEGIN
 SELECT * INTO row FROM mail.delivery WHERE id=delivery;
 IF row.source_schema!='access' OR row.kind NOT IN ('invitation','payment_claim','renewal_claim','payment_decision','renewal_decision','manual_access_changed') OR row.state!='failed' OR row.last_error IN ('STALE','DELIVERY_UNKNOWN','INVALID_PAYLOAD') THEN RETURN false; END IF;
 EXECUTE format('UPDATE %I.outbox SET state=''queued'',retry_count=0,next_attempt_at=clock_timestamp(),last_error=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1 AND state=''failed'' AND lease_id IS NULL',row.source_schema) USING delivery;
 GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION mail.retry_delivery(uuid) FROM PUBLIC,finance_api,mail_finance,mail_control;
GRANT EXECUTE ON FUNCTION mail.retry_delivery(uuid) TO control_api;
