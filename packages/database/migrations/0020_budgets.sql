-- Saved financial filters and versioned limits. No bank facts are rewritten.
CREATE TABLE finance.budget (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='array' AND jsonb_array_length(limits)>0),
 enabled boolean NOT NULL DEFAULT true,
 dependency_status text NOT NULL DEFAULT 'ready' CHECK(dependency_status IN ('ready','needs_setup')),
 revision bigint NOT NULL DEFAULT 0,PRIMARY KEY(user_id,id)
);
ALTER TABLE finance.budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.budget FORCE ROW LEVEL SECURITY;
CREATE POLICY own_data ON finance.budget TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON finance.budget TO finance_api;
REVOKE ALL ON finance.budget FROM PUBLIC,control_api,mail_finance,mail_control;
CREATE TRIGGER immutable_identity BEFORE UPDATE ON finance.budget FOR EACH ROW EXECUTE FUNCTION finance.fixed_tenant();
CREATE TRIGGER object_revision BEFORE UPDATE ON finance.budget FOR EACH ROW EXECUTE FUNCTION finance.advance_object_revision();
