-- Named interface configurations. Financial records remain in their original tables.
CREATE TABLE finance.operations_view (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 is_default boolean NOT NULL DEFAULT false,dependency_status text NOT NULL DEFAULT 'ready' CHECK(dependency_status IN ('ready','needs_setup')),
 default_user text GENERATED ALWAYS AS (CASE WHEN is_default THEN user_id ELSE NULL END) STORED,
 position integer NOT NULL DEFAULT 0 CHECK(position BETWEEN 0 AND 100),modified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revision bigint NOT NULL DEFAULT 0,PRIMARY KEY(user_id,id),UNIQUE(default_user) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE finance.operations_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.operations_view FORCE ROW LEVEL SECURITY;
CREATE POLICY own_data ON finance.operations_view TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON finance.operations_view TO finance_api;
REVOKE ALL ON finance.operations_view FROM PUBLIC,control_api,mail_finance,mail_control;
CREATE TRIGGER immutable_identity BEFORE UPDATE ON finance.operations_view FOR EACH ROW EXECUTE FUNCTION finance.fixed_tenant();
CREATE TRIGGER object_revision BEFORE UPDATE ON finance.operations_view FOR EACH ROW EXECUTE FUNCTION finance.advance_object_revision();

CREATE FUNCTION finance.modify_operations_view() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN NEW.modified_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER modified_at BEFORE UPDATE ON finance.operations_view FOR EACH ROW EXECUTE FUNCTION finance.modify_operations_view();
REVOKE ALL ON FUNCTION finance.modify_operations_view() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
