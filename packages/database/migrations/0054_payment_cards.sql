-- Multiple reusable cards; recurring authorization is independent.
CREATE TABLE commerce.payment_card(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 method_id text NOT NULL,last4 text,brand text,active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE commerce.payment_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.payment_card FORCE ROW LEVEL SECURITY;
CREATE POLICY own_card ON commerce.payment_card TO finance_api USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY migration_owner ON commerce.payment_card TO CURRENT_USER USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON commerce.payment_card TO finance_api;
REVOKE ALL ON commerce.payment_card FROM PUBLIC;
CREATE INDEX ON commerce.payment_card(user_id,active);
INSERT INTO commerce.payment_card(user_id,method_id,last4,updated_at) SELECT user_id,method_id,last4,updated_at FROM commerce.saved_card;
INSERT INTO commerce.payment_card(user_id,method_id) SELECT r.user_id,r.method_id FROM commerce.autorenewal r WHERE r.method_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce.payment_card c WHERE c.user_id=r.user_id AND c.method_id=r.method_id);
ALTER TABLE commerce.autorenewal ADD COLUMN card_id uuid REFERENCES commerce.payment_card(id) ON DELETE SET NULL;
UPDATE commerce.autorenewal r SET card_id=c.id FROM commerce.payment_card c WHERE c.user_id=r.user_id AND c.method_id=r.method_id;
ALTER TABLE commerce.access_checkout ADD COLUMN card_id uuid REFERENCES commerce.payment_card(id) ON DELETE SET NULL;
ALTER TABLE commerce.ai_topup_order ADD COLUMN card_id uuid REFERENCES commerce.payment_card(id) ON DELETE SET NULL;
GRANT UPDATE(card_id) ON commerce.ai_topup_order TO finance_api;
ALTER TABLE commerce.trial_checkout ADD COLUMN result_reason text;
CREATE OR REPLACE FUNCTION commerce.control_trial_status(p_user text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM commerce.trial_checkout t JOIN commerce.access_checkout o ON o.id=t.checkout_id WHERE t.user_id=p_user AND t.kind='trial' AND t.result='granted' AND o.access_end>clock_timestamp()) THEN 'active'
 WHEN n.trial_state='denied' THEN 'failed' WHEN n.trial_state IN ('new','pending') THEN n.trial_state ELSE 'used' END
 FROM (SELECT 1) x LEFT JOIN commerce.onboarding_account n ON n.user_id=p_user
$$;
CREATE FUNCTION commerce.finance_purchased_used() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT b.slot_bought_used FROM commerce.customer_allowance_usage(nullif(current_setting('app.user_id',true),''),statement_timestamp()) b WHERE nullif(current_setting('app.user_id',true),'') IS NOT NULL
$$;
REVOKE ALL ON FUNCTION commerce.finance_purchased_used() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.finance_purchased_used() TO finance_api;
