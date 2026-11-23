-- Draft public tariffs; historical applications retain their original snapshots.
INSERT INTO access.tariff(id,snapshot) VALUES
 ('cashneuro-1m','{"id":"cashneuro-1m","name":"1 месяц","duration":{"kind":"calendar_months","count":1},"priceMinor":"39900","aiQuota":10000,"active":false,"publicVisible":false,"availableForNew":true,"availableForRenewal":true}'),
 ('cashneuro-3m','{"id":"cashneuro-3m","name":"3 месяца","duration":{"kind":"calendar_months","count":3},"priceMinor":"104900","aiQuota":10000,"active":false,"publicVisible":false,"availableForNew":true,"availableForRenewal":true}'),
 ('cashneuro-6m','{"id":"cashneuro-6m","name":"6 месяцев","duration":{"kind":"calendar_months","count":6},"priceMinor":"189900","aiQuota":10000,"active":false,"publicVisible":false,"availableForNew":true,"availableForRenewal":true}')
ON CONFLICT DO NOTHING;
GRANT UPDATE (snapshot) ON access.tariff TO control_api;

CREATE TABLE commerce.ai_pack (
 units integer PRIMARY KEY CHECK(units IN (1000,2000,5000,10000)),
 price_minor integer NOT NULL CHECK(price_minor BETWEEN 100 AND 1000000),
 enabled boolean NOT NULL DEFAULT true
);
INSERT INTO commerce.ai_pack(units,price_minor) VALUES (1000,3900),(2000,6900),(5000,14900),(10000,26900);
GRANT SELECT ON commerce.ai_pack TO finance_api,control_api;
GRANT UPDATE (price_minor,enabled) ON commerce.ai_pack TO control_api;

CREATE TABLE commerce.ai_topup_order (
 user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 id uuid NOT NULL,units integer NOT NULL REFERENCES commerce.ai_pack(units),price_minor integer NOT NULL CHECK(price_minor>0),
 provider_id uuid UNIQUE,redirect_url text,status text NOT NULL DEFAULT 'created' CHECK(status IN ('created','pending','paid','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),paid_at timestamptz,
 PRIMARY KEY(user_id,id),CHECK((status='paid')=(paid_at IS NOT NULL))
);
ALTER TABLE commerce.ai_topup_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.ai_topup_order FORCE ROW LEVEL SECURITY;
CREATE POLICY own_order ON commerce.ai_topup_order TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT ON commerce.ai_topup_order TO finance_api;
GRANT UPDATE (provider_id,redirect_url,status,paid_at) ON commerce.ai_topup_order TO finance_api;
REVOKE ALL ON commerce.ai_topup_order,commerce.ai_pack FROM PUBLIC;
