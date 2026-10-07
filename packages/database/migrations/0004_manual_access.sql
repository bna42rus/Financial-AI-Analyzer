-- Forward-only Development migration. Minimal directory projection, never identity credentials.
ALTER TABLE commerce.access_cycle ALTER COLUMN access_end DROP NOT NULL;
ALTER TABLE commerce.access_cycle ADD COLUMN indefinite boolean NOT NULL DEFAULT false;
ALTER TABLE commerce.access_cycle ADD COLUMN end_offset_ms bigint NOT NULL DEFAULT 0 CHECK(abs(end_offset_ms)<=3153600000000);
ALTER TABLE commerce.access_cycle ADD COLUMN quota_policy jsonb;
ALTER TABLE commerce.access_cycle ADD CONSTRAINT cycle_end_mode CHECK(indefinite=(access_end IS NULL));
UPDATE commerce.access_cycle c SET quota_policy=jsonb_build_object('source','tariff','tariffId',p.data->'tariff'->>'id','limit',p.data->'tariff'->'aiQuota')
 FROM commerce.purchase p WHERE p.user_id=c.user_id;
CREATE TABLE commerce.account_directory (
 user_id text PRIMARY KEY REFERENCES identity.auth_user ON DELETE CASCADE,
 email text NOT NULL UNIQUE, name text NOT NULL, registered_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'active'
);
INSERT INTO commerce.account_directory SELECT u.id,u.email,u.name,u.created_at,COALESCE(s.status,'active') FROM identity.auth_user u LEFT JOIN identity.security_state s ON s.user_id=u.id;
CREATE FUNCTION commerce.project_account() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='auth_user' THEN
  INSERT INTO commerce.account_directory(user_id,email,name,registered_at) VALUES(NEW.id,NEW.email,NEW.name,NEW.created_at)
   ON CONFLICT(user_id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name;
 ELSE
  UPDATE commerce.account_directory SET status=NEW.status WHERE user_id=NEW.user_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce.project_account() FROM PUBLIC,finance_api,control_api;
CREATE TRIGGER project_account AFTER INSERT OR UPDATE OF email,name ON identity.auth_user FOR EACH ROW EXECUTE FUNCTION commerce.project_account();
CREATE TRIGGER project_status AFTER INSERT OR UPDATE OF status ON identity.security_state FOR EACH ROW EXECUTE FUNCTION commerce.project_account();
-- Existing operator-provisioned grants acquire the canonical clock; unknown quota stays unset until explicit policy.
INSERT INTO commerce.access_cycle(user_id,anchor_at,access_end,timezone,calendar_months,extra_days,indefinite)
 SELECT u.id,u.created_at,CASE WHEN s.indefinite THEN NULL ELSE s.access_end END,'Europe/Moscow',0,0,s.indefinite
 FROM identity.auth_user u JOIN identity.security_state s ON s.user_id=u.id
 WHERE (s.indefinite OR s.access_end>u.created_at) AND NOT EXISTS(SELECT 1 FROM commerce.access_cycle c WHERE c.user_id=u.id);
CREATE TABLE commerce.manual_grant (
 id text PRIMARY KEY, email text NOT NULL, term jsonb NOT NULL, access_type text NOT NULL CHECK(access_type IN ('Paid','Test','Free','Other')),
 quota_policy jsonb NOT NULL, reason text NOT NULL, creator text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','expired')),
 user_id text REFERENCES identity.auth_user ON DELETE CASCADE, activated_at timestamptz, access_end timestamptz,
 CHECK((state='active')=(user_id IS NOT NULL AND activated_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_manual_grant ON commerce.manual_grant(email) WHERE state='pending';
ALTER TABLE commerce.invitation ALTER COLUMN purchase_id DROP NOT NULL;
ALTER TABLE commerce.invitation ADD COLUMN manual_grant_id text REFERENCES commerce.manual_grant;
ALTER TABLE commerce.invitation ADD CONSTRAINT one_invitation_source CHECK((purchase_id IS NULL)<>(manual_grant_id IS NULL));
CREATE UNIQUE INDEX one_active_manual_invitation ON commerce.invitation(manual_grant_id) WHERE state='active';
CREATE TABLE commerce.manual_access_audit (
 action_id text PRIMARY KEY REFERENCES commerce.action, user_id text, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT ON commerce.account_directory TO control_api;
GRANT SELECT,INSERT,UPDATE ON commerce.manual_grant TO control_api;
GRANT SELECT,INSERT ON commerce.manual_access_audit TO control_api;
GRANT INSERT ON commerce.access_cycle TO control_api;
GRANT SELECT(id,email,term,quota_policy,state,user_id,activated_at,access_end) ON commerce.manual_grant TO finance_api;
GRANT UPDATE(state,user_id,activated_at,access_end) ON commerce.manual_grant TO finance_api;
GRANT SELECT(manual_grant_id) ON commerce.invitation TO finance_api;
