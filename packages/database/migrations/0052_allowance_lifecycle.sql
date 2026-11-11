-- End/suspend erases only included units. Purchased units use their own adjustment ledger.
CREATE TABLE commerce.allowance_stop(user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,stopped_at timestamptz NOT NULL);
CREATE TABLE commerce.purchased_adjustment(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,atoms numeric NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON commerce.allowance_stop,commerce.purchased_adjustment FROM PUBLIC;
CREATE OR REPLACE FUNCTION commerce.customer_allowance_usage(p_user text,p_at timestamptz)
RETURNS TABLE(period_start timestamptz,period_end timestamptz,quota integer,base_used numeric,base_remaining numeric,purchased_remaining numeric,slot_bought_used numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH context AS (
  SELECT c.anchor_at,c.access_end,s.status,z.stopped_at FROM (SELECT 1) x LEFT JOIN commerce.access_cycle c ON c.user_id=p_user LEFT JOIN identity.security_state s ON s.user_id=p_user LEFT JOIN commerce.allowance_stop z ON z.user_id=p_user
 ), current_slot AS (
  SELECT COALESCE(o.starts_at,b.starts_at) AS starts_at,COALESCE(o.ends_at,b.ends_at) AS ends_at,
   CASE WHEN c.status='suspended' OR c.access_end<=p_at OR c.stopped_at>=COALESCE(o.changed_at,w.starts_at,c.anchor_at) THEN 0 ELSE COALESCE(o.units,CASE WHEN b.starts_at>=a.period_start THEN 10000 ELSE w.quota END,0) END AS units,
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


CREATE OR REPLACE FUNCTION commerce.extend_customer_allowance(p_user text,p_at timestamptz,p_end timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('customer-ai-budget:'||p_user,0));
 SELECT * INTO b FROM commerce.customer_allowance_usage(p_user,p_at);
 RETURN commerce.set_customer_allowance(p_user,p_at,p_end,b.quota);
END $$;
CREATE FUNCTION commerce.stop_customer_allowance(p_user text,p_at timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO commerce.allowance_stop(user_id,stopped_at) VALUES(p_user,p_at)
 ON CONFLICT(user_id) DO UPDATE SET stopped_at=GREATEST(commerce.allowance_stop.stopped_at,EXCLUDED.stopped_at)
$$;
REVOKE ALL ON FUNCTION commerce.stop_customer_allowance(text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.stop_customer_allowance(text,timestamptz) TO control_api;
CREATE FUNCTION commerce.set_customer_purchased_units(p_user text,p_units bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record;BEGIN
 IF p_units<0 OR p_units>1000000000 THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('customer-ai-budget:'||p_user,0));
 IF EXISTS(SELECT 1 FROM commerce.ai_cost_reservation WHERE user_id=p_user AND state IN ('reserved','unknown')) THEN RETURN false;END IF;
 SELECT * INTO b FROM commerce.customer_allowance_usage(p_user,clock_timestamp());
 INSERT INTO commerce.purchased_adjustment(user_id,atoms) VALUES(p_user,p_units::numeric*10000000-b.purchased_remaining);RETURN true;
END $$;
REVOKE ALL ON FUNCTION commerce.set_customer_purchased_units(text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.set_customer_purchased_units(text,bigint) TO control_api;
CREATE OR REPLACE FUNCTION commerce.control_customer_allowances(p_users text[])
RETURNS TABLE(user_id text,units integer,remaining integer,used integer,purchased integer,spent_atoms text,budget_minor text,reset_at timestamptz,manual boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.user_id,b.quota,
  CASE WHEN c.indefinite OR c.access_end>statement_timestamp() THEN floor(b.base_remaining/10000000)::int ELSE 0 END,
  ceil(b.base_used/10000000)::int,
  least(floor(b.purchased_remaining/10000000),2147483647)::int,
  l.spent_atoms,l.budget_minor,
  CASE WHEN c.indefinite OR c.access_end>statement_timestamp() THEN c.access_end END,
  EXISTS(SELECT 1 FROM commerce.customer_allowance_override o WHERE o.user_id=c.user_id AND o.starts_at<=statement_timestamp() AND o.ends_at>statement_timestamp())
 FROM commerce.access_cycle c
 JOIN commerce.control_analyzer_limits() l USING(user_id)
 CROSS JOIN LATERAL commerce.customer_allowance_usage(c.user_id,statement_timestamp()) b
 WHERE c.user_id=ANY(p_users)
$$;
REVOKE ALL ON FUNCTION commerce.control_customer_allowances(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_customer_allowances(text[]) TO control_api;


INSERT INTO commerce.allowance_stop(user_id,stopped_at)
SELECT c.user_id,clock_timestamp() FROM commerce.access_cycle c JOIN identity.security_state s USING(user_id)
WHERE s.status='suspended' OR NOT c.indefinite AND c.access_end<=clock_timestamp()
 OR EXISTS(SELECT 1 FROM commerce.manual_access_audit a WHERE a.user_id=c.user_id
 AND a.data->'after'->>'revision'=c.revision::text AND a.data->>'mode' IN ('extend','set_end')
 AND (a.data->'before'->>'accessEnd')::timestamptz<=a.created_at AND a.data->'quota'=a.data->'before'->'quotaPolicy')
ON CONFLICT(user_id) DO NOTHING;
DO $$DECLARE c record;BEGIN
 FOR c IN SELECT ac.user_id,ac.access_end FROM commerce.access_cycle ac
 WHERE ac.access_end>clock_timestamp() AND EXISTS(SELECT 1 FROM commerce.manual_access_audit a
 WHERE a.user_id=ac.user_id AND a.data->'after'->>'revision'=ac.revision::text AND a.data->>'mode' IN ('extend','set_end')
 AND (a.data->'before'->>'accessEnd')::timestamptz>a.created_at AND a.data->'quota'=a.data->'before'->'quotaPolicy')
 LOOP PERFORM commerce.extend_customer_allowance(c.user_id,clock_timestamp(),c.access_end);END LOOP;
END $$;
