CREATE TABLE access.legal_consent (
 request_id text NOT NULL REFERENCES access.request(id) ON DELETE CASCADE,
 version text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (request_id,version)
);
GRANT INSERT ON access.legal_consent TO finance_api;
REVOKE ALL ON access.legal_consent FROM PUBLIC;

CREATE TABLE identity.legal_event (
 user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 document text NOT NULL CHECK (document IN ('terms','privacy_notice')),
 version text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (user_id,document,version)
);
ALTER TABLE identity.legal_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.legal_event FORCE ROW LEVEL SECURITY;
CREATE POLICY own_legal_event ON identity.legal_event TO finance_api
 USING (user_id=current_setting('app.user_id',true)) WITH CHECK (user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT ON identity.legal_event TO finance_api;
REVOKE ALL ON identity.legal_event FROM PUBLIC;

INSERT INTO access.tariff(id,snapshot) VALUES
 ('cashneuro-1w','{"id":"cashneuro-1w","name":"1 неделя","duration":{"kind":"days","count":7},"priceMinor":"11900","aiQuota":2500,"active":true,"publicVisible":true,"availableForNew":true,"availableForRenewal":true}'),
 ('cashneuro-2w','{"id":"cashneuro-2w","name":"2 недели","duration":{"kind":"days","count":14},"priceMinor":"21900","aiQuota":5000,"active":true,"publicVisible":true,"availableForNew":true,"availableForRenewal":true}')
ON CONFLICT DO NOTHING;

-- Publish only unchanged defaults. Preserve any previously edited catalog entry.
UPDATE access.tariff SET snapshot=snapshot||'{"active":true,"publicVisible":true}'::jsonb
 WHERE (id,snapshot->>'priceMinor',snapshot->'duration'->>'count') IN
 (('cashneuro-1m','39900','1'),('cashneuro-3m','104900','3'),('cashneuro-6m','189900','6'))
 AND snapshot->>'active'='false' AND snapshot->>'publicVisible'='false'
 AND snapshot->'duration'->>'kind'='calendar_months' AND snapshot->>'aiQuota'='10000'
 AND snapshot->>'name'=CASE id WHEN 'cashneuro-1m' THEN '1 месяц' WHEN 'cashneuro-3m' THEN '3 месяца' ELSE '6 месяцев' END;
