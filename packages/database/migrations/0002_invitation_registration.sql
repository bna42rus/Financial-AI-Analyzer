-- Forward-only extension. Control never obtains identity credentials or finance data.
CREATE TABLE commerce.review_state (
 request_id text PRIMARY KEY REFERENCES access.request ON DELETE CASCADE, data jsonb NOT NULL
);
CREATE TABLE commerce.action (
 id text PRIMARY KEY, actor_id text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE commerce.purchase (
 id text PRIMARY KEY, request_id text NOT NULL UNIQUE REFERENCES access.request ON DELETE CASCADE,
 data jsonb NOT NULL, state text NOT NULL DEFAULT 'paid_not_activated' CHECK(state IN ('paid_not_activated','active')),
 user_id text UNIQUE, activated_at timestamptz, access_end timestamptz, timezone text,
 CHECK((state='active')=(user_id IS NOT NULL AND activated_at IS NOT NULL AND access_end IS NOT NULL))
);
CREATE TABLE commerce.invitation (
 id text PRIMARY KEY, purchase_id text NOT NULL REFERENCES commerce.purchase,
 email text NOT NULL, verifier text NOT NULL UNIQUE, sealed_token text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('active','expired','cancelled','superseded','used')), used_at timestamptz,
 CHECK((state='used')=(used_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_invitation ON commerce.invitation(purchase_id) WHERE state='active';
CREATE TABLE access.registration_proof (
 verifier text PRIMARY KEY, invitation_id text NOT NULL REFERENCES commerce.invitation ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
GRANT UPDATE ON access.request TO control_api;
GRANT INSERT ON access.outbox TO control_api;
GRANT SELECT,INSERT,UPDATE ON commerce.review_state,commerce.action,commerce.purchase,commerce.invitation TO control_api;
GRANT USAGE ON SCHEMA commerce TO finance_api;
GRANT SELECT ON commerce.purchase TO finance_api;
GRANT SELECT(id,purchase_id,email,verifier,created_at,expires_at,state,used_at) ON commerce.invitation TO finance_api;
GRANT UPDATE(state,used_at) ON commerce.invitation TO finance_api;
GRANT UPDATE(state,user_id,activated_at,access_end,timezone) ON commerce.purchase TO finance_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON access.registration_proof TO finance_api;
