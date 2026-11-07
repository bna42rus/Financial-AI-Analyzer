-- Hashed rate keys only. Mail workers do not need access.
CREATE TABLE mail.request_cooldown (
  scope text NOT NULL CHECK (scope IN ('finance','control')),
  key text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  sends smallint NOT NULL CHECK (sends BETWEEN 1 AND 6),
  retry_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at >= retry_at),
  PRIMARY KEY (scope,key)
);
CREATE INDEX request_cooldown_expiry ON mail.request_cooldown(scope,expires_at);
ALTER TABLE mail.request_cooldown ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail.request_cooldown FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_cooldown ON mail.request_cooldown TO finance_api USING (scope='finance') WITH CHECK (scope='finance');
CREATE POLICY control_cooldown ON mail.request_cooldown TO control_api USING (scope='control') WITH CHECK (scope='control');
GRANT SELECT,INSERT,UPDATE,DELETE ON mail.request_cooldown TO finance_api,control_api;
