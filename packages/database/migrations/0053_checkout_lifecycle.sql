-- Trial verification, card binding and tariff orders have independent lifecycles.
ALTER TABLE commerce.access_checkout ADD COLUMN purpose text NOT NULL DEFAULT 'access' CHECK(purpose IN ('access','trial','card'));
ALTER TABLE commerce.access_checkout ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE commerce.access_checkout ADD COLUMN provider_status text;
ALTER TABLE commerce.access_checkout ADD COLUMN capture_required boolean NOT NULL DEFAULT false;
ALTER TABLE commerce.access_checkout ADD COLUMN desired_auto boolean;
UPDATE commerce.access_checkout o SET purpose='trial' WHERE EXISTS(SELECT 1 FROM commerce.trial_checkout t WHERE t.checkout_id=o.id);
DROP INDEX commerce.checkout_one_pending_account;
CREATE UNIQUE INDEX checkout_one_pending_purpose ON commerce.access_checkout(user_id,purpose) WHERE state IN ('created','pending','reconcile');
GRANT UPDATE(purpose,cancel_requested,provider_status,capture_required,desired_auto) ON commerce.access_checkout TO finance_api;
ALTER TABLE commerce.trial_checkout ADD COLUMN kind text NOT NULL DEFAULT 'trial' CHECK(kind IN ('trial','card'));
ALTER TABLE commerce.card_refund_job ADD COLUMN amount_minor integer NOT NULL DEFAULT 1000 CHECK(amount_minor>0);
CREATE FUNCTION commerce.interactive_checkouts_due() RETURNS TABLE(id uuid,user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id,o.user_id FROM commerce.access_checkout o WHERE o.user_id IS NOT NULL AND o.mode<>'automatic'
 AND (o.state IN ('created','pending') OR o.cancel_requested AND o.provider_id IS NOT NULL AND COALESCE(o.provider_status,'pending') NOT IN ('succeeded','canceled'))
 ORDER BY o.created_at LIMIT 50
$$;
REVOKE ALL ON FUNCTION commerce.interactive_checkouts_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.interactive_checkouts_due() TO finance_api;
CREATE OR REPLACE FUNCTION commerce.yookassa_payment_target(p_payment uuid)
RETURNS TABLE(id uuid,user_id text,application_id text,kind text,state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id,o.user_id,o.application_id,'access',CASE WHEN o.cancel_requested AND COALESCE(o.provider_status,'pending') NOT IN ('succeeded','canceled') THEN 'pending' ELSE o.state END
 FROM commerce.access_checkout o WHERE o.provider_id=p_payment
 UNION ALL SELECT o.id,o.user_id,NULL,'topup',o.status FROM commerce.ai_topup_order o WHERE o.provider_id=p_payment
$$;
-- Explicitly retain balances while suspended. Financial authorization still denies use.
DELETE FROM commerce.allowance_stop z USING commerce.access_cycle c
WHERE c.user_id=z.user_id AND (c.indefinite OR c.access_end>z.stopped_at)
AND NOT EXISTS(SELECT 1 FROM commerce.manual_access_audit a WHERE a.user_id=z.user_id AND a.created_at=z.stopped_at
 AND (a.data->>'mode'='end_now' OR (a.data->'before'->>'accessEnd')::timestamptz<=a.created_at));
CREATE POLICY allowance_security_owner ON identity.security_state FOR SELECT TO CURRENT_USER USING(true);
-- Narrow, redacted admin projection; no saved payment token is exposed.
CREATE FUNCTION commerce.control_billing_facts() RETURNS TABLE(id uuid,purpose text,first_purchase boolean,refunds jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id,o.purpose,NOT EXISTS(SELECT 1 FROM commerce.access_checkout p WHERE p.user_id=o.user_id AND p.purpose='access' AND p.state='paid' AND p.created_at<o.created_at),
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',j.refund_id,'state',j.refund_state,'amountMinor',j.amount_minor,'at',COALESCE(j.refund_attempt_at,j.created_at))) FROM commerce.card_refund_job j WHERE j.checkout_id=o.id AND j.refund_id IS NOT NULL),'[]'::jsonb)
 FROM commerce.access_checkout o
$$;
REVOKE ALL ON FUNCTION commerce.control_billing_facts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_billing_facts() TO control_api;
INSERT INTO commerce.autorenewal(user_id,checkout_id,tariff,offer_version,renewal_version,state,next_at)
SELECT DISTINCT ON(o.user_id) o.user_id,o.id,o.tariff,o.offer_version,'2026-11-11.1','off',c.access_end
FROM commerce.access_checkout o JOIN commerce.access_cycle c ON c.user_id=o.user_id
WHERE o.purpose='access' AND o.state='paid' AND c.access_end IS NOT NULL
AND NOT EXISTS(SELECT 1 FROM commerce.autorenewal r WHERE r.user_id=o.user_id)
ORDER BY o.user_id,o.created_at DESC;
CREATE OR REPLACE FUNCTION commerce.customer_allowance_usage(p_user text,p_at timestamptz)
RETURNS TABLE(period_start timestamptz,period_end timestamptz,quota integer,base_used numeric,base_remaining numeric,purchased_remaining numeric,slot_bought_used numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH context AS (
  SELECT c.anchor_at,c.access_end,s.status,z.stopped_at FROM (SELECT 1) x LEFT JOIN commerce.access_cycle c ON c.user_id=p_user LEFT JOIN identity.security_state s ON s.user_id=p_user LEFT JOIN commerce.allowance_stop z ON z.user_id=p_user
 ), current_slot AS (
  SELECT COALESCE(o.starts_at,b.starts_at) AS starts_at,COALESCE(o.ends_at,b.ends_at) AS ends_at,
   CASE WHEN c.access_end<=p_at OR c.stopped_at>COALESCE(o.changed_at,(SELECT max(p.starts_at) FROM commerce.access_paid_window p WHERE p.user_id=p_user AND p.starts_at<=p_at AND p.ends_at>p_at),(SELECT max(m.starts_at) FROM commerce.manual_allowance m WHERE m.user_id=p_user AND m.starts_at<=p_at),c.anchor_at) THEN 0 ELSE COALESCE(o.units,CASE WHEN b.starts_at>=a.period_start THEN 10000 ELSE w.quota END,0) END AS units,
   COALESCE(o.base_before,0) AS base_before
  FROM context c
  LEFT JOIN LATERAL commerce.analyzer_allowance_window(p_user,p_at) w ON true
  CROSS JOIN LATERAL commerce.billing_period(COALESCE(w.starts_at,CASE WHEN c.anchor_at<=p_at THEN c.anchor_at END,date_trunc('month',p_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'),
   least(w.ends_at,CASE WHEN c.access_end>p_at THEN c.access_end END),COALESCE(w.kind,'calendar_months'),p_at) b
  LEFT JOIN commerce.ai_allowance_restoration a ON a.user_id=p_user AND a.window_start=w.starts_at AND NOT w.manual
  LEFT JOIN commerce.customer_allowance_override o ON o.user_id=p_user AND o.starts_at<=p_at AND o.ends_at>p_at
 ), charges AS (
  SELECT COALESCE(o.starts_at,b.starts_at) AS slot,
   COALESCE(o.units,CASE WHEN b.starts_at>=a.period_start THEN 10000 ELSE w.quota END,10000) AS units,
   SUM(CASE WHEN o.changed_at IS NOT NULL AND r.created_at<o.changed_at THEN 0
     WHEN o.changed_at IS NULL AND b.starts_at=a.period_start AND r.created_at<a.restored_at THEN 0
     WHEN r.state IN ('settled','released') THEN r.settled_atoms ELSE r.reserved_atoms END) AS used
  FROM commerce.ai_cost_reservation r CROSS JOIN context c
  LEFT JOIN LATERAL commerce.analyzer_allowance_window(p_user,r.created_at) w ON true
  CROSS JOIN LATERAL commerce.billing_period(COALESCE(w.starts_at,CASE WHEN c.anchor_at<=r.created_at THEN c.anchor_at END,date_trunc('month',r.created_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'),
   w.ends_at,COALESCE(w.kind,'calendar_months'),r.created_at) b
  LEFT JOIN commerce.ai_allowance_restoration a ON a.user_id=p_user AND a.window_start=w.starts_at AND NOT w.manual
  LEFT JOIN commerce.customer_allowance_override o ON o.user_id=p_user AND o.starts_at<=r.created_at AND o.ends_at>r.created_at
  WHERE r.user_id=p_user AND r.step<>'classification' AND r.created_at<=p_at
  GROUP BY 1,2
 ), usage_by_slot AS (
  SELECT ch.slot,SUM(ch.used) AS occupied,
   COALESCE(o.bought_before,0)+GREATEST(0,SUM(ch.used)-GREATEST(0,COALESCE(o.units,min(ch.units))::numeric*10000000-COALESCE(o.base_before,0))) AS bought_used
  FROM charges ch LEFT JOIN commerce.customer_allowance_override o ON o.user_id=p_user AND o.starts_at=ch.slot
  GROUP BY ch.slot,o.bought_before,o.units,o.base_before
 ), credits AS (
  SELECT COALESCE(SUM(units),0)::numeric*10000000+(SELECT COALESCE(sum(atoms),0) FROM commerce.purchased_adjustment WHERE user_id=p_user) AS total
  FROM commerce.ai_topup_order WHERE user_id=p_user AND status='paid'
 )
 SELECT s.starts_at,s.ends_at,s.units,
   s.base_before+least(GREATEST(0,s.units::numeric*10000000-s.base_before),COALESCE(u.occupied,0)),
   GREATEST(0,s.units::numeric*10000000-s.base_before-COALESCE(u.occupied,0)),
   GREATEST(0,c.total-COALESCE((SELECT SUM(bought_used) FROM usage_by_slot),0)),
   COALESCE(u.bought_used,0)
 FROM current_slot s CROSS JOIN credits c LEFT JOIN usage_by_slot u ON u.slot=s.starts_at
$$;
REVOKE ALL ON FUNCTION commerce.customer_allowance_usage(text,timestamptz) FROM PUBLIC;


CREATE FUNCTION commerce.control_topup_payments() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',o.id,'purpose','topup','channel','renewal','status',o.status,'mode','once','tariff',o.units||' единиц Анализатора','price_minor',o.price_minor::text,'provider_id',o.provider_id,'created_at',o.created_at,'email',u.email,'user_id',o.user_id,'refunds',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'state',r.state,'amountMinor',r.amount_minor,'at',r.created_at)) FROM commerce.checkout_refund r WHERE r.payment_provider_id=o.provider_id),'[]'::jsonb))
 FROM commerce.ai_topup_order o LEFT JOIN identity.auth_user u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 500
$$;
REVOKE ALL ON FUNCTION commerce.control_topup_payments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_topup_payments() TO control_api;

-- Request-counter compatibility for accounts activated through registration before payment.
GRANT UPDATE(quota_policy) ON commerce.access_cycle TO finance_api;
UPDATE commerce.access_cycle c SET quota_policy=jsonb_build_object('source','tariff','tariffId','onboarding','limit',2500)
WHERE c.quota_policy->>'source'='override' AND c.quota_policy->>'limit'='0'
AND c.access_end>clock_timestamp() AND EXISTS(SELECT 1 FROM commerce.onboarding_account n WHERE n.user_id=c.user_id)
AND EXISTS(SELECT 1 FROM commerce.access_checkout o WHERE o.user_id=c.user_id AND o.state='paid');

CREATE FUNCTION commerce.control_trial_status(p_user text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM commerce.trial_checkout t JOIN commerce.access_checkout o ON o.id=t.checkout_id WHERE t.user_id=p_user AND t.kind='trial' AND t.result='granted' AND o.access_end>clock_timestamp()) THEN 'active'
 WHEN n.trial_state IN ('new','pending') THEN n.trial_state ELSE 'used' END
 FROM (SELECT 1) x LEFT JOIN commerce.onboarding_account n ON n.user_id=p_user
$$;
REVOKE ALL ON FUNCTION commerce.control_trial_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_trial_status(text) TO control_api;
