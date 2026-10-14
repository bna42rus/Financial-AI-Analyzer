-- Technical cost is independent of customer task units and financial deletion.
-- NULL usage means unknown, never a free external call.
ALTER TABLE commerce.analyzer_request ALTER COLUMN input_tokens DROP NOT NULL;
ALTER TABLE commerce.analyzer_request ALTER COLUMN output_tokens DROP NOT NULL;
ALTER TABLE commerce.analyzer_request ALTER COLUMN input_tokens DROP DEFAULT;
ALTER TABLE commerce.analyzer_request ALTER COLUMN output_tokens DROP DEFAULT;
ALTER TABLE commerce.analyzer_request ADD COLUMN usage_state text NOT NULL DEFAULT 'unknown' CHECK(usage_state IN ('reported','unknown','not_sent'));
ALTER TABLE commerce.analyzer_request ADD COLUMN dispatched_at timestamptz;
UPDATE commerce.analyzer_request SET usage_state='reported' WHERE input_tokens>0 OR output_tokens>0;

CREATE TABLE commerce.ai_project_budget (
 project_id text NOT NULL CHECK(project_id ~ '^[a-z0-9._/-]{1,80}$'),
 period_start timestamptz NOT NULL,period_end timestamptz NOT NULL CHECK(period_end>period_start),
 limit_atoms numeric(30,0) NOT NULL CHECK(limit_atoms>0 AND limit_atoms<=1000000000000),
 spent_atoms numeric(30,0) NOT NULL DEFAULT 0 CHECK(spent_atoms>=0),
 reserved_atoms numeric(30,0) NOT NULL DEFAULT 0 CHECK(reserved_atoms>=0),
 blocked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(project_id,period_start)
);
CREATE TABLE commerce.ai_user_budget (
 user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 anchor_at timestamptz NOT NULL,period_start timestamptz NOT NULL,
 limit_atoms numeric(30,0) NOT NULL CHECK(limit_atoms=100000000000),
 spent_atoms numeric(30,0) NOT NULL DEFAULT 0 CHECK(spent_atoms>=0),
 reserved_atoms numeric(30,0) NOT NULL DEFAULT 0 CHECK(reserved_atoms>=0),
 PRIMARY KEY(user_id,anchor_at,period_start)
);
CREATE TABLE commerce.ai_cost_reservation (
 user_id text NOT NULL,request_id uuid NOT NULL,step text NOT NULL,
 project_id text NOT NULL,project_period_start timestamptz NOT NULL,
 anchor_at timestamptz NOT NULL,period_start timestamptz NOT NULL,
 price jsonb NOT NULL CHECK(jsonb_typeof(price)='object'),
 quoted_input_tokens integer NOT NULL CHECK(quoted_input_tokens BETWEEN 0 AND 1000000),
 quoted_output_tokens integer NOT NULL CHECK(quoted_output_tokens BETWEEN 0 AND 1000000),
 quoted_model_version text NOT NULL CHECK(quoted_model_version ~ '^[A-Za-z0-9._-]{1,100}$'),
 reserved_atoms numeric(30,0) NOT NULL CHECK(reserved_atoms>0),
 settled_atoms numeric(30,0) CHECK(settled_atoms>=0),
 reported_input_tokens integer CHECK(reported_input_tokens>=0),
 reported_output_tokens integer CHECK(reported_output_tokens>=0),
 reported_model_version text,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','unknown','released')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,request_id,step),
 FOREIGN KEY(user_id,request_id,step) REFERENCES commerce.analyzer_request(user_id,request_id,step) ON DELETE CASCADE,
 FOREIGN KEY(user_id,anchor_at,period_start) REFERENCES commerce.ai_user_budget(user_id,anchor_at,period_start),
 FOREIGN KEY(project_id,project_period_start) REFERENCES commerce.ai_project_budget(project_id,period_start)
);

ALTER TABLE commerce.ai_project_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.ai_project_budget FORCE ROW LEVEL SECURITY;
-- Project rows are technical aggregate metadata only, not user financial data.
CREATE POLICY project_cost ON commerce.ai_project_budget TO finance_api USING(true) WITH CHECK(true);
ALTER TABLE commerce.ai_user_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.ai_user_budget FORCE ROW LEVEL SECURITY;
CREATE POLICY own_cost ON commerce.ai_user_budget TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
ALTER TABLE commerce.ai_cost_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.ai_cost_reservation FORCE ROW LEVEL SECURITY;
CREATE POLICY own_cost_receipt ON commerce.ai_cost_reservation TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,UPDATE ON commerce.ai_project_budget,commerce.ai_user_budget,commerce.ai_cost_reservation TO finance_api;
REVOKE ALL ON commerce.ai_project_budget,commerce.ai_user_budget,commerce.ai_cost_reservation FROM PUBLIC,control_api,mail_finance,mail_control;

CREATE FUNCTION commerce.fixed_ai_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='ai_project_budget' THEN
  IF ROW(NEW.project_id,NEW.period_start,NEW.period_end,NEW.limit_atoms) IS DISTINCT FROM ROW(OLD.project_id,OLD.period_start,OLD.period_end,OLD.limit_atoms) THEN RAISE EXCEPTION 'IMMUTABLE_BUDGET';END IF;
 ELSE
  IF ROW(NEW.user_id,NEW.anchor_at,NEW.period_start,NEW.limit_atoms) IS DISTINCT FROM ROW(OLD.user_id,OLD.anchor_at,OLD.period_start,OLD.limit_atoms) THEN RAISE EXCEPTION 'IMMUTABLE_BUDGET';END IF;
 END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION commerce.fixed_ai_budget() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE TRIGGER fixed_budget BEFORE UPDATE ON commerce.ai_project_budget FOR EACH ROW EXECUTE FUNCTION commerce.fixed_ai_budget();
CREATE TRIGGER fixed_budget BEFORE UPDATE ON commerce.ai_user_budget FOR EACH ROW EXECUTE FUNCTION commerce.fixed_ai_budget();
CREATE FUNCTION commerce.fixed_ai_cost() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW.user_id,NEW.request_id,NEW.step,NEW.project_id,NEW.project_period_start,NEW.anchor_at,NEW.period_start,NEW.price,NEW.quoted_input_tokens,NEW.quoted_output_tokens,NEW.quoted_model_version,NEW.reserved_atoms,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.user_id,OLD.request_id,OLD.step,OLD.project_id,OLD.project_period_start,OLD.anchor_at,OLD.period_start,OLD.price,OLD.quoted_input_tokens,OLD.quoted_output_tokens,OLD.quoted_model_version,OLD.reserved_atoms,OLD.created_at)
 OR OLD.state IN ('settled','released') AND ROW(NEW.state,NEW.settled_atoms,NEW.reported_input_tokens,NEW.reported_output_tokens,NEW.reported_model_version) IS DISTINCT FROM ROW(OLD.state,OLD.settled_atoms,OLD.reported_input_tokens,OLD.reported_output_tokens,OLD.reported_model_version)
 THEN RAISE EXCEPTION 'IMMUTABLE_COST_RECEIPT';END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION commerce.fixed_ai_cost() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE TRIGGER fixed_cost BEFORE UPDATE ON commerce.ai_cost_reservation FOR EACH ROW EXECUTE FUNCTION commerce.fixed_ai_cost();
