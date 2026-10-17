-- Count reservations across tenants without granting access to their receipts.
LOCK TABLE commerce.ai_cost_reservation IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE commerce.ai_project_budget ADD COLUMN dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count>=0);
UPDATE commerce.ai_project_budget p SET dispatch_count=(SELECT count(*) FROM commerce.ai_cost_reservation r WHERE r.project_id=p.project_id AND r.project_period_start=p.period_start);
CREATE FUNCTION commerce.count_ai_dispatch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 UPDATE commerce.ai_project_budget SET dispatch_count=dispatch_count+1 WHERE project_id=NEW.project_id AND period_start=NEW.project_period_start;
 RETURN NEW;END $$;
CREATE TRIGGER count_ai_dispatch AFTER INSERT ON commerce.ai_cost_reservation FOR EACH ROW EXECUTE FUNCTION commerce.count_ai_dispatch();
REVOKE ALL ON FUNCTION commerce.count_ai_dispatch() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;

-- Operator-funded categorization is distinct from customer Analyzer task quota.
ALTER TABLE commerce.analyzer_request DROP CONSTRAINT analyzer_request_step_check;
ALTER TABLE commerce.analyzer_request ADD CONSTRAINT analyzer_request_step_check
 CHECK(step IN ('gate','plan','assistant_0','assistant_1','assistant_2','classification'));
CREATE TABLE finance.classification_dispatch (
 user_id text PRIMARY KEY REFERENCES finance.workspace(user_id) ON DELETE CASCADE,
 generation uuid NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','completed','blocked')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE finance.classification_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.classification_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduler_metadata ON finance.classification_dispatch FOR SELECT TO finance_api USING(true);
CREATE POLICY own_insert ON finance.classification_dispatch FOR INSERT TO finance_api WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY own_update ON finance.classification_dispatch FOR UPDATE TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY own_delete ON finance.classification_dispatch FOR DELETE TO finance_api USING(user_id=current_setting('app.user_id',true));
CREATE TABLE finance.classification_run (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE, id uuid NOT NULL,
 generation uuid NOT NULL, engine text NOT NULL, catalog_hash text NOT NULL CHECK(catalog_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('sent','received','completed','failed','unknown','discarded')),
 decisions jsonb, applied integer NOT NULL DEFAULT 0 CHECK(applied>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,id)
);
CREATE TABLE finance.classification_cache (
 user_id text NOT NULL, signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'), run_id uuid NOT NULL,
 decision jsonb, PRIMARY KEY(user_id,signature),
 FOREIGN KEY(user_id,run_id) REFERENCES finance.classification_run(user_id,id) ON DELETE CASCADE
);
CREATE TABLE finance.classification_assignment (
 user_id text NOT NULL,id uuid NOT NULL,transaction_id uuid NOT NULL,run_id uuid NOT NULL,
 before_facets jsonb NOT NULL,after_facets jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,transaction_id) REFERENCES finance.transaction(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,run_id) REFERENCES finance.classification_run(user_id,id) ON DELETE CASCADE
);
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['classification_run','classification_cache','classification_assignment'] LOOP
 EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',t);
END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON finance.classification_dispatch,finance.classification_run,finance.classification_cache,finance.classification_assignment TO finance_api;
REVOKE ALL ON finance.classification_dispatch,finance.classification_run,finance.classification_cache,finance.classification_assignment FROM PUBLIC,control_api,mail_finance,mail_control;
CREATE FUNCTION finance.clear_classification_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.generation<>OLD.generation OR NEW.key_version<>OLD.key_version THEN
  DELETE FROM finance.classification_run WHERE user_id=OLD.user_id;
  DELETE FROM finance.classification_dispatch WHERE user_id=OLD.user_id;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER clear_classification_generation BEFORE UPDATE OF generation,key_version ON finance.workspace FOR EACH ROW EXECUTE FUNCTION finance.clear_classification_generation();
REVOKE ALL ON FUNCTION finance.clear_classification_generation() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
