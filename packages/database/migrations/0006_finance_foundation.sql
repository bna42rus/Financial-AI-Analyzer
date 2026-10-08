-- Operator-owned foundation; source observations are append-only to runtime callers.
CREATE TABLE finance.workspace (
 user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 generation uuid NOT NULL DEFAULT gen_random_uuid(), revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 loan_mode text NOT NULL DEFAULT 'cashflow' CHECK(loan_mode IN ('cashflow','economic'))
);
CREATE TABLE finance.account (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,
 bank_id text NOT NULL,system_name text NOT NULL,display_name text NOT NULL,
 account_type text NOT NULL CHECK(account_type IN ('debit_card','credit_card','bank_account','loan','savings','deposit','other')),
 currency text NOT NULL DEFAULT 'RUB' CHECK(currency='RUB'),analytics_enabled boolean NOT NULL DEFAULT true,default_visible boolean NOT NULL DEFAULT true,
 loan_mode text CHECK(loan_mode IN ('cashflow','economic')),revision bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id)
);
CREATE TABLE finance.category (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,parent_id uuid,
 name text NOT NULL,role text NOT NULL CHECK(role IN ('expense','income','both')),hidden boolean NOT NULL DEFAULT false,revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,parent_id) REFERENCES finance.category(user_id,id),CHECK(parent_id IS DISTINCT FROM id)
);
CREATE TABLE finance.counterparty (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,name text NOT NULL,
 state text NOT NULL CHECK(state IN ('discovered','registered','ignored')),is_self boolean NOT NULL DEFAULT false,revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,id)
);
CREATE TABLE finance.transaction (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,source_observation_id uuid NOT NULL,
 corrections jsonb NOT NULL DEFAULT '{}',semantics jsonb NOT NULL,comment text NOT NULL DEFAULT '',
 analytics_override text NOT NULL DEFAULT 'default' CHECK(analytics_override IN ('default','include','exclude')),
 decomposition boolean NOT NULL DEFAULT false,review_reasons jsonb NOT NULL DEFAULT '[]',revision bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 corrected_account_id uuid GENERATED ALWAYS AS ((corrections->>'accountId')::uuid) STORED,
 category_id uuid GENERATED ALWAYS AS ((semantics->'category'->>'value')::uuid) STORED,
 subcategory_id uuid GENERATED ALWAYS AS ((semantics->'subcategory'->>'value')::uuid) STORED,
 counterparty_id uuid GENERATED ALWAYS AS ((semantics->'counterparty'->>'value')::uuid) STORED,
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,corrected_account_id) REFERENCES finance.account(user_id,id),
 FOREIGN KEY(user_id,category_id) REFERENCES finance.category(user_id,id),FOREIGN KEY(user_id,subcategory_id) REFERENCES finance.category(user_id,id),
 FOREIGN KEY(user_id,counterparty_id) REFERENCES finance.counterparty(user_id,id),CHECK(jsonb_typeof(corrections)='object' AND jsonb_typeof(semantics)='object' AND jsonb_typeof(review_reasons)='array')
);
CREATE TABLE finance.source_observation (
 user_id text NOT NULL,id uuid NOT NULL,transaction_id uuid NOT NULL,account_id uuid NOT NULL,
 operation_date jsonb NOT NULL,posted_date jsonb,amount_minor bigint NOT NULL,currency text NOT NULL CHECK(currency='RUB'),source_kind text NOT NULL CHECK(source_kind IN ('purchase','transfer_in','transfer_out','own_transfer','refund','reversal','cash_withdrawal','cash_deposit','credit_card_repayment','loan_disbursement','loan_payment','interest','fee','insurance','cashback','other')),
 operation_amount_minor bigint,operation_currency text CHECK(operation_currency ~ '^[A-Z]{3}$'),CHECK((operation_amount_minor IS NULL)=(operation_currency IS NULL)),
 merchant_text text NOT NULL,description text NOT NULL,bank_category text NOT NULL,bank_ref_hmac text CHECK(bank_ref_hmac ~ '^[0-9a-f]{64}$'),
 versions jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,transaction_id,id),
 FOREIGN KEY(user_id,transaction_id) REFERENCES finance.transaction(user_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(user_id,account_id) REFERENCES finance.account(user_id,id)
);
ALTER TABLE finance.transaction ADD FOREIGN KEY(user_id,id,source_observation_id) REFERENCES finance.source_observation(user_id,transaction_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ON finance.source_observation(user_id,transaction_id,observed_at);
CREATE TABLE finance.component (
 user_id text NOT NULL,id uuid NOT NULL,transaction_id uuid NOT NULL,
 type text NOT NULL CHECK(type IN ('principal','interest','fee','insurance','other')),amount_minor bigint NOT NULL,active boolean NOT NULL DEFAULT true,
 role jsonb NOT NULL,category jsonb NOT NULL,subcategory jsonb NOT NULL,
 category_id uuid GENERATED ALWAYS AS ((category->>'value')::uuid) STORED,
 subcategory_id uuid GENERATED ALWAYS AS ((subcategory->>'value')::uuid) STORED,
 PRIMARY KEY(user_id,id),UNIQUE(user_id,transaction_id,id),FOREIGN KEY(user_id,transaction_id) REFERENCES finance.transaction(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,category_id) REFERENCES finance.category(user_id,id),FOREIGN KEY(user_id,subcategory_id) REFERENCES finance.category(user_id,id)
);
CREATE TABLE finance.link (
 user_id text NOT NULL,id uuid NOT NULL,source_id uuid NOT NULL,target_id uuid NOT NULL,source_component_id uuid,target_component_id uuid,
 kind text NOT NULL CHECK(kind IN ('own_transfer','credit_card_repayment','refund','reversal','expense_reimbursement','debt_repayment')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),status text NOT NULL CHECK(status IN ('candidate','confirmed','rejected')),
 confidence integer NOT NULL CHECK(confidence BETWEEN 0 AND 100),created_by text NOT NULL CHECK(created_by IN ('user','personal_rule','deterministic_system_rule','global_rule','ai','bank')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,id),CHECK(source_id<>target_id),
 FOREIGN KEY(user_id,source_id) REFERENCES finance.transaction(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,target_id) REFERENCES finance.transaction(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,source_id,source_component_id) REFERENCES finance.component(user_id,transaction_id,id),
 FOREIGN KEY(user_id,target_id,target_component_id) REFERENCES finance.component(user_id,transaction_id,id)
);
CREATE INDEX ON finance.link(user_id,source_id);CREATE INDEX ON finance.link(user_id,target_id);
CREATE TABLE finance.rule (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,name text NOT NULL,enabled boolean NOT NULL DEFAULT true,
 priority integer NOT NULL DEFAULT 0,conditions jsonb NOT NULL,assignments jsonb NOT NULL,revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,id),CHECK(jsonb_typeof(conditions)='object' AND jsonb_typeof(assignments)='object')
);
CREATE TABLE finance.action (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,generation uuid NOT NULL,expected_revision bigint NOT NULL,
 intent jsonb NOT NULL,preview jsonb NOT NULL,status text NOT NULL DEFAULT 'previewed' CHECK(status IN ('previewed','committed')),
 result jsonb,undo_patch jsonb,committed_revision bigint,undone boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '20 minutes',committed_at timestamptz,
 PRIMARY KEY(user_id,id)
);
CREATE INDEX ON finance.action(user_id,committed_at);
-- Composite keys are the hard boundary even when an ID is supplied from another account.
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['workspace','account','category','counterparty','transaction','source_observation','component','link','rule','action'] LOOP
  EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON finance.%I TO finance_api',name);
 END LOOP;
END $$;
REVOKE UPDATE,DELETE ON finance.source_observation FROM finance_api;
REVOKE ALL ON ALL TABLES IN SCHEMA finance FROM PUBLIC,control_api,mail_finance,mail_control;
-- Runtime cannot relabel tenant IDs or overwrite the original facts through corrections.
CREATE FUNCTION finance.fixed_tenant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN IF NEW.user_id<>OLD.user_id OR (to_jsonb(NEW)->>'id') IS DISTINCT FROM (to_jsonb(OLD)->>'id') THEN RAISE EXCEPTION 'immutable identity'; END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION finance.fixed_tenant() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['workspace','account','category','counterparty','transaction','component','link','rule','action'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_identity BEFORE UPDATE ON finance.%I FOR EACH ROW EXECUTE FUNCTION finance.fixed_tenant()',name);
 END LOOP;
END $$;
