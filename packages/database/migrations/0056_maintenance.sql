-- Shared public operational state; only authenticated Control handlers may mutate it.
CREATE TABLE commerce.maintenance(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),revision integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'none' CHECK(state IN ('none','scheduled','completed','cancelled')),
 title text NOT NULL DEFAULT 'Обновляем CashNeuro' CHECK(length(title)<=100),
 message text NOT NULL DEFAULT '' CHECK(length(message)<=1000),starts_at timestamptz,ends_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state<>'scheduled' OR starts_at IS NOT NULL AND ends_at>starts_at)
);
INSERT INTO commerce.maintenance(id) VALUES(true);
CREATE TABLE commerce.maintenance_event(
 id uuid PRIMARY KEY,revision integer NOT NULL UNIQUE,actor_id text NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE commerce.maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.maintenance FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_read ON commerce.maintenance FOR SELECT TO finance_api,control_api USING(true);
CREATE POLICY maintenance_control ON commerce.maintenance FOR UPDATE TO control_api USING(true) WITH CHECK(true);
CREATE POLICY maintenance_owner ON commerce.maintenance TO CURRENT_USER USING(true) WITH CHECK(true);
REVOKE ALL ON commerce.maintenance,commerce.maintenance_event FROM PUBLIC;
GRANT SELECT ON commerce.maintenance TO finance_api,control_api;
GRANT UPDATE ON commerce.maintenance TO control_api;
GRANT SELECT,INSERT ON commerce.maintenance_event TO control_api;
