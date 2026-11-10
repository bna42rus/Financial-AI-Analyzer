-- An override changes one access window. Historical window spend is kept so
-- revising a limit cannot retroactively consume or restore purchased units.
CREATE TABLE commerce.customer_allowance_override (
 user_id text NOT NULL REFERENCES commerce.access_cycle(user_id) ON DELETE CASCADE,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 changed_at timestamptz NOT NULL,
 units integer NOT NULL CHECK(units>=0),
 base_before numeric NOT NULL CHECK(base_before>=0),
 bought_before numeric NOT NULL CHECK(bought_before>=0),
 PRIMARY KEY(user_id,starts_at),
 CHECK(starts_at<=changed_at AND ends_at>=changed_at)
);
REVOKE ALL ON commerce.customer_allowance_override FROM PUBLIC;
GRANT DELETE ON commerce.ai_pack TO control_api;
-- These tables force row security even for their owner. The scoped aggregate
-- functions below use the migration role, never a public cross-account grant.
CREATE POLICY allowance_reservations_owner ON commerce.ai_cost_reservation FOR SELECT TO CURRENT_USER USING(true);
CREATE POLICY allowance_purchases_owner ON commerce.ai_topup_order FOR SELECT TO CURRENT_USER USING(true);

CREATE FUNCTION commerce.customer_allowance_usage(p_user text,p_at timestamptz)
RETURNS TABLE(period_start timestamptz,period_end timestamptz,quota integer,base_used numeric,base_remaining numeric,purchased_remaining numeric,slot_bought_used numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH context AS (
  SELECT c.anchor_at,c.access_end FROM (SELECT 1) x LEFT JOIN commerce.access_cycle c ON c.user_id=p_user
 ), current_slot AS (
  SELECT COALESCE(o.starts_at,b.starts_at) AS starts_at,COALESCE(o.ends_at,b.ends_at) AS ends_at,
   COALESCE(o.units,CASE WHEN b.starts_at>=a.period_start THEN 10000 ELSE w.quota END,10000) AS units,
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
  SELECT COALESCE(SUM(units),0)::numeric*10000000 AS total
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

CREATE FUNCTION commerce.finance_customer_allowance()
RETURNS TABLE(period_end timestamptz,quota integer,base_remaining numeric,purchased_remaining numeric,manual boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT b.period_end,b.quota,b.base_remaining,b.purchased_remaining,
 EXISTS(SELECT 1 FROM commerce.customer_allowance_override o WHERE o.user_id=current_setting('app.user_id',true) AND o.starts_at<=statement_timestamp() AND o.ends_at>statement_timestamp())
 FROM commerce.customer_allowance_usage(nullif(current_setting('app.user_id',true),''),statement_timestamp()) b
 WHERE nullif(current_setting('app.user_id',true),'') IS NOT NULL
$$;
REVOKE ALL ON FUNCTION commerce.finance_customer_allowance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.finance_customer_allowance() TO finance_api;

CREATE FUNCTION commerce.control_customer_allowances(p_users text[])
RETURNS TABLE(user_id text,units integer,remaining integer,used integer,purchased integer,spent_atoms text,budget_minor text,reset_at timestamptz,manual boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.user_id,b.quota,
  CASE WHEN c.indefinite OR c.access_end>statement_timestamp() THEN floor(b.base_remaining/10000000)::int ELSE 0 END,
  ceil(b.base_used/10000000)::int,
  least(floor(b.purchased_remaining/10000000),2147483647)::int,
  l.spent_atoms,l.budget_minor,
  CASE WHEN c.indefinite OR c.access_end>statement_timestamp() THEN b.period_end END,
  EXISTS(SELECT 1 FROM commerce.customer_allowance_override o WHERE o.user_id=c.user_id AND o.starts_at<=statement_timestamp() AND o.ends_at>statement_timestamp())
 FROM commerce.access_cycle c
 JOIN commerce.control_analyzer_limits() l USING(user_id)
 CROSS JOIN LATERAL commerce.customer_allowance_usage(c.user_id,statement_timestamp()) b
 WHERE c.user_id=ANY(p_users)
$$;
REVOKE ALL ON FUNCTION commerce.control_customer_allowances(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_customer_allowances(text[]) TO control_api;

CREATE FUNCTION commerce.set_customer_allowance(p_user text,p_at timestamptz,p_end timestamptz,p_units integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record;
BEGIN
 IF p_units<0 OR p_end<=p_at THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('customer-ai-budget:'||p_user,0));
 SELECT * INTO b FROM commerce.customer_allowance_usage(p_user,p_at);
 IF EXISTS(SELECT 1 FROM commerce.ai_cost_reservation WHERE user_id=p_user AND step<>'classification' AND created_at>=b.period_start AND state IN ('reserved','unknown')) THEN
  RETURN false;
 END IF;
 INSERT INTO commerce.customer_allowance_override(user_id,starts_at,ends_at,changed_at,units,base_before,bought_before)
 VALUES(p_user,b.period_start,p_end,p_at,p_units,b.base_used,b.slot_bought_used)
 ON CONFLICT(user_id,starts_at) DO UPDATE SET ends_at=EXCLUDED.ends_at,changed_at=EXCLUDED.changed_at,
  units=EXCLUDED.units,base_before=EXCLUDED.base_before,bought_before=EXCLUDED.bought_before;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION commerce.set_customer_allowance(text,timestamptz,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.set_customer_allowance(text,timestamptz,timestamptz,integer) TO control_api;

CREATE FUNCTION commerce.move_customer_allowance_end(p_user text,p_at timestamptz,p_end timestamptz)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 UPDATE commerce.customer_allowance_override SET ends_at=greatest(p_at,coalesce(p_end,p_at))
 WHERE user_id=p_user AND starts_at<=p_at AND ends_at>p_at
$$;
REVOKE ALL ON FUNCTION commerce.move_customer_allowance_end(text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.move_customer_allowance_end(text,timestamptz,timestamptz) TO control_api;

CREATE FUNCTION commerce.start_customer_allowance(p_start timestamptz,p_end timestamptz,p_units integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT commerce.set_customer_allowance(c.user_id,p_start,p_end,p_units)
 FROM commerce.access_cycle c WHERE c.user_id=nullif(current_setting('app.user_id',true),'')
  AND c.revision=0 AND c.anchor_at=p_start AND c.access_end=p_end AND c.quota_policy->>'source'='override'
  AND COALESCE(c.quota_policy->>'budgetMinor',c.quota_policy->>'limit')=p_units::text
  AND NOT EXISTS(SELECT 1 FROM commerce.customer_allowance_override o WHERE o.user_id=c.user_id)
$$;
REVOKE ALL ON FUNCTION commerce.start_customer_allowance(timestamptz,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.start_customer_allowance(timestamptz,timestamptz,integer) TO finance_api;

-- A legacy cap was stored in kopecks, one unit per kopeck of model cost.
DO $$
DECLARE c record; at_time timestamptz:=clock_timestamp();
BEGIN
 FOR c IN SELECT user_id,access_end,(quota_policy->>'budgetMinor')::int AS units FROM commerce.access_cycle
 WHERE access_end>at_time AND quota_policy->>'budgetMinor' ~ '^\d{1,7}$'
 LOOP
  IF commerce.set_customer_allowance(c.user_id,at_time,c.access_end,c.units) THEN
   UPDATE commerce.access_cycle SET quota_policy=jsonb_build_object('source','override','limit',c.units),revision=revision+1 WHERE user_id=c.user_id;
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION commerce.record_checkout_reconciliation_result(p_checkout uuid,p_action text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO commerce.action(id,actor_id,payload)
 SELECT 'reconcile:'||j.action_id::text,j.actor_id,jsonb_build_object(
  'kind','checkout_reconciliation_'||j.state,'checkoutId',j.checkout_id,'email',a.payload->>'email','reason',j.message,
  'changes',jsonb_build_array(jsonb_build_object('label','Результат ЮKassa','before','Проверяется','after',
   CASE WHEN j.state='unknown' THEN 'Не подтверждён' WHEN j.provider_state='succeeded' THEN 'Оплачен'
    WHEN j.provider_state='canceled' THEN 'Отменён' WHEN j.provider_state='waiting_for_capture' THEN 'Ожидает списания' ELSE 'Ожидает оплаты' END)))
 FROM commerce.checkout_reconciliation j JOIN commerce.action a ON a.id=j.action_id::text
 WHERE j.checkout_id=p_checkout AND j.action_id::text=p_action AND j.state IN ('verified','resolved','unknown')
 ON CONFLICT DO NOTHING
$$;
REVOKE ALL ON FUNCTION commerce.record_checkout_reconciliation_result(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.record_checkout_reconciliation_result(uuid,text) TO finance_api;
