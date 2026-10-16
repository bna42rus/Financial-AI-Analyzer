-- Operator-only migration; runtime roles are not owners and have no BYPASSRLS.
DO $$ BEGIN CREATE ROLE finance_api NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE control_api NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA identity;
CREATE SCHEMA control;
CREATE SCHEMA access;
CREATE SCHEMA commerce;
CREATE SCHEMA finance;
CREATE SCHEMA protected_keys;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA identity, control, access, commerce, finance, protected_keys FROM PUBLIC;

CREATE TABLE identity.auth_user (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE CHECK(email=lower(email)), email_verified boolean NOT NULL DEFAULT false,
 image text, two_factor_enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE identity.auth_session (
 id text PRIMARY KEY, token text NOT NULL UNIQUE, user_id text NOT NULL REFERENCES identity.auth_user ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, ip_address text, user_agent text
);
CREATE INDEX ON identity.auth_session(user_id);
CREATE TABLE identity.auth_account (
 id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES identity.auth_user ON DELETE CASCADE,
 password text, access_token text, refresh_token text, id_token text, scope text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, UNIQUE(provider_id, account_id)
);
CREATE TABLE identity.auth_verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX ON identity.auth_verification(identifier);
CREATE TABLE identity.auth_two_factor (
 id text PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES identity.auth_user ON DELETE CASCADE, secret text NOT NULL, backup_codes text NOT NULL,
 verified boolean NOT NULL DEFAULT true, failed_verification_count integer NOT NULL DEFAULT 0, locked_until timestamptz
);
-- Independent auth realm. No shared users, cookies or sessions with finance/user API.
CREATE TABLE control.auth_user (LIKE identity.auth_user INCLUDING ALL);
CREATE TABLE control.auth_session (LIKE identity.auth_session INCLUDING ALL);
ALTER TABLE control.auth_session ADD FOREIGN KEY(user_id) REFERENCES control.auth_user ON DELETE CASCADE;
CREATE TABLE control.auth_account (LIKE identity.auth_account INCLUDING ALL);
ALTER TABLE control.auth_account ADD FOREIGN KEY(user_id) REFERENCES control.auth_user ON DELETE CASCADE;
CREATE TABLE control.auth_verification (LIKE identity.auth_verification INCLUDING ALL);
CREATE TABLE control.auth_two_factor (LIKE identity.auth_two_factor INCLUDING ALL);
ALTER TABLE control.auth_two_factor ADD FOREIGN KEY(user_id) REFERENCES control.auth_user ON DELETE CASCADE;

CREATE TABLE identity.security_state (
 user_id text PRIMARY KEY REFERENCES identity.auth_user ON DELETE CASCADE, epoch integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')), access_end timestamptz, indefinite boolean NOT NULL DEFAULT false
);
CREATE TABLE control.security_state (
 user_id text PRIMARY KEY REFERENCES control.auth_user ON DELETE CASCADE, epoch integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')), bootstrap_pending boolean NOT NULL DEFAULT false
);
CREATE TABLE control.session_proof (
 session_id text PRIMARY KEY REFERENCES control.auth_session ON DELETE CASCADE, user_id text NOT NULL REFERENCES control.auth_user ON DELETE CASCADE,
 epoch integer NOT NULL, level text NOT NULL CHECK(level IN ('enrollment','recovery','admin')), verified_at timestamptz
);
CREATE TABLE control.recovery_code (
 verifier text PRIMARY KEY, user_id text NOT NULL REFERENCES control.auth_user ON DELETE CASCADE, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.totp_replay (user_id text NOT NULL REFERENCES control.auth_user ON DELETE CASCADE, verifier text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(user_id, verifier));
CREATE TABLE identity.reset_token (
 verifier text PRIMARY KEY, user_id text NOT NULL REFERENCES identity.auth_user ON DELETE CASCADE, epoch integer NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE control.reset_token (LIKE identity.reset_token INCLUDING ALL);
ALTER TABLE control.reset_token ADD FOREIGN KEY(user_id) REFERENCES control.auth_user ON DELETE CASCADE;
CREATE TABLE identity.outbox (
 id uuid PRIMARY KEY, kind text NOT NULL, sealed_payload text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sent','failed')), attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE control.outbox (LIKE identity.outbox INCLUDING ALL);
CREATE TABLE access.outbox (LIKE identity.outbox INCLUDING ALL);
CREATE TABLE identity.security_event (
 id uuid PRIMARY KEY, user_id text NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.security_event (LIKE identity.security_event INCLUDING ALL);
CREATE TABLE identity.rate_limit (key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE control.rate_limit (LIKE identity.rate_limit INCLUDING ALL);
CREATE TABLE access.rate_limit (LIKE identity.rate_limit INCLUDING ALL);
CREATE TABLE access.tariff (id text PRIMARY KEY, snapshot jsonb NOT NULL);
CREATE TABLE access.request (
 id text PRIMARY KEY, email text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON access.request(email);
CREATE TABLE access.email_token (
 verifier text PRIMARY KEY, request_id text NOT NULL REFERENCES access.request ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE access.application_session (
 verifier text PRIMARY KEY, request_id text NOT NULL REFERENCES access.request ON DELETE CASCADE, expires_at timestamptz NOT NULL
);
-- Isolation canary only. Actual financial schemas arrive with finance implementation.
CREATE TABLE finance.isolation_canary (user_id text PRIMARY KEY, marker text NOT NULL);
ALTER TABLE finance.isolation_canary ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.isolation_canary FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON finance.isolation_canary TO finance_api
 USING(user_id = nullif(current_setting('app.user_id', true), ''))
 WITH CHECK(user_id = nullif(current_setting('app.user_id', true), ''));
CREATE TABLE protected_keys.isolation_canary (marker text);

GRANT USAGE ON SCHEMA identity, access, finance TO finance_api;
GRANT USAGE ON SCHEMA control, access, commerce TO control_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO finance_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON access.request, access.email_token, access.application_session, access.rate_limit TO finance_api;
GRANT INSERT ON access.outbox TO finance_api;
GRANT SELECT ON access.tariff TO finance_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.isolation_canary TO finance_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA control TO control_api;
GRANT SELECT ON access.request, access.tariff TO control_api;
-- Explicitly no identity, finance, protected keys or mail payload access for control_api.
