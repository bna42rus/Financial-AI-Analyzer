-- Explicit owner mappings for semantic catalog targets. No automatic starter
-- update and no source/transaction rewrite. Deleting a category removes its map.
CREATE TABLE finance.category_binding (
 user_id text NOT NULL REFERENCES finance.workspace(user_id) ON DELETE CASCADE,
 id uuid NOT NULL, target_key text NOT NULL CHECK(target_key ~ '^[a-z][a-z_]{1,63}$'),
 category_id uuid NOT NULL, subcategory_id uuid,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,target_key),
 FOREIGN KEY(user_id,category_id) REFERENCES finance.category(user_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(user_id,subcategory_id) REFERENCES finance.category(user_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE finance.category_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.category_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY own_data ON finance.category_binding TO finance_api
 USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON finance.category_binding TO finance_api;
REVOKE ALL ON finance.category_binding FROM PUBLIC,control_api,mail_finance,mail_control;
