-- Canonical paid clock is independent of identity suspension; control gets no identity grants.
CREATE TABLE commerce.access_cycle (
 user_id text PRIMARY KEY, anchor_at timestamptz NOT NULL, access_end timestamptz NOT NULL,
 timezone text NOT NULL CHECK(timezone='Europe/Moscow'), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 calendar_months integer NOT NULL CHECK(calendar_months BETWEEN 0 AND 36500),
 extra_days integer NOT NULL CHECK(extra_days BETWEEN 0 AND 36500), CHECK(access_end>anchor_at)
);
INSERT INTO commerce.access_cycle(user_id,anchor_at,access_end,timezone,calendar_months,extra_days)
 SELECT user_id,activated_at,access_end,timezone,
 CASE WHEN data->'duration'->>'kind'='calendar_months' THEN (data->'duration'->>'count')::integer ELSE 0 END,
 CASE WHEN data->'duration'->>'kind'='days' THEN (data->'duration'->>'count')::integer ELSE 0 END
 FROM commerce.purchase WHERE state='active';
CREATE TABLE commerce.renewal_request (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES commerce.access_cycle ON DELETE CASCADE,
 data jsonb NOT NULL, review_state jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('open','completed','cancelled','rejected')),
 created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX one_open_renewal ON commerce.renewal_request(user_id) WHERE state='open';
CREATE TABLE commerce.access_extension (
 action_id text PRIMARY KEY REFERENCES commerce.action,
 request_id text NOT NULL UNIQUE REFERENCES commerce.renewal_request, user_id text NOT NULL REFERENCES commerce.access_cycle,
 data jsonb NOT NULL
);
GRANT SELECT,INSERT ON commerce.access_cycle TO finance_api;
GRANT SELECT,UPDATE ON commerce.access_cycle TO control_api;
GRANT SELECT,INSERT,UPDATE ON commerce.renewal_request TO finance_api;
GRANT SELECT,UPDATE ON commerce.renewal_request TO control_api;
GRANT SELECT,INSERT ON commerce.access_extension TO control_api;
ALTER TABLE commerce.access_cycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.access_cycle FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce.renewal_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.renewal_request FORCE ROW LEVEL SECURITY;
CREATE POLICY own_cycle ON commerce.access_cycle TO finance_api
 USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY own_renewal ON commerce.renewal_request TO finance_api
 USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY control_cycle ON commerce.access_cycle TO control_api USING(true) WITH CHECK(true);
CREATE POLICY control_renewal ON commerce.renewal_request TO control_api USING(true) WITH CHECK(true);
