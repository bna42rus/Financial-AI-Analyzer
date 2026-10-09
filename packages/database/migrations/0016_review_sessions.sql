-- Additive migration. Progress contains opaque operation IDs, never banking facts or AI text.
CREATE TABLE finance.review_session (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,
 generation uuid NOT NULL,operation_ids uuid[] NOT NULL CHECK(cardinality(operation_ids) BETWEEN 0 AND 1000),
 cursor integer NOT NULL DEFAULT 0 CHECK(cursor>=0),decisions jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(decisions)='object'),
 status text NOT NULL DEFAULT 'created' CHECK(status IN ('created','in_progress','paused','completed','abandoned')),
 revision bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id),CHECK(cursor<=cardinality(operation_ids))
);
CREATE TABLE finance.review_command (
 user_id text NOT NULL,id uuid NOT NULL,session_id uuid NOT NULL,request jsonb NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,session_id) REFERENCES finance.review_session(user_id,id) ON DELETE CASCADE
);
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['review_session','review_command'] LOOP
  EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON finance.%I TO finance_api',name);
  EXECUTE format('REVOKE ALL ON finance.%I FROM PUBLIC,control_api,mail_finance,mail_control',name);
  EXECUTE format('CREATE TRIGGER immutable_identity BEFORE UPDATE ON finance.%I FOR EACH ROW EXECUTE FUNCTION finance.fixed_tenant()',name);
 END LOOP;
END $$;
CREATE FUNCTION finance.clean_review_operation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 DELETE FROM finance.review_command c USING finance.review_session s WHERE c.user_id=OLD.user_id AND (c.user_id,c.session_id)=(s.user_id,s.id) AND OLD.id=ANY(s.operation_ids);
 UPDATE finance.review_session SET cursor=LEAST(cursor-CASE WHEN array_position(operation_ids,OLD.id)<=cursor THEN 1 ELSE 0 END,cardinality(operation_ids)-1),operation_ids=array_remove(operation_ids,OLD.id),decisions=decisions-OLD.id::text,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=OLD.user_id AND OLD.id=ANY(operation_ids);
 RETURN OLD;
END $$;
CREATE TRIGGER clean_review_operation AFTER DELETE ON finance.transaction FOR EACH ROW EXECUTE FUNCTION finance.clean_review_operation();
CREATE FUNCTION finance.clean_review_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN IF NEW.generation<>OLD.generation THEN DELETE FROM finance.review_session WHERE user_id=NEW.user_id;END IF;RETURN NEW;END $$;
CREATE TRIGGER clean_review_generation AFTER UPDATE OF generation ON finance.workspace FOR EACH ROW EXECUTE FUNCTION finance.clean_review_generation();
REVOKE ALL ON FUNCTION finance.clean_review_operation(),finance.clean_review_generation() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
