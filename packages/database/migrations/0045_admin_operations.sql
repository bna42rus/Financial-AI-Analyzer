ALTER TABLE mail.delivery ADD COLUMN recipient text;
CREATE POLICY delivery_projection_recipient ON mail.delivery TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE FUNCTION mail.project_recipient() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE mail.delivery SET recipient=NEW.recipient WHERE id=NEW.id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mail.project_recipient() FROM PUBLIC;
DO $$ DECLARE s text; BEGIN
 FOREACH s IN ARRAY ARRAY['identity','control','access'] LOOP
  EXECUTE format('ALTER TABLE %I.outbox ADD COLUMN recipient text CHECK(length(recipient)<=254)',s);
  EXECUTE format('CREATE TRIGGER delivery_recipient AFTER INSERT OR UPDATE OF recipient ON %I.outbox FOR EACH ROW EXECUTE FUNCTION mail.project_recipient()',s);
 END LOOP;
END $$;

CREATE TABLE commerce.manual_allowance (
 user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 starts_at timestamptz NOT NULL,
 units integer CHECK(units BETWEEN 0 AND 1000000000),
 period_days integer CHECK(period_days BETWEEN 1 AND 366),
 PRIMARY KEY(user_id,starts_at)
);
ALTER TABLE commerce.manual_allowance ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.manual_allowance FORCE ROW LEVEL SECURITY;
CREATE POLICY own_manual_allowance ON commerce.manual_allowance TO finance_api
 USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY control_manual_allowance ON commerce.manual_allowance TO control_api USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON commerce.manual_allowance TO finance_api,control_api;

CREATE FUNCTION commerce.analyzer_allowance_window(p_user text,p_at timestamptz)
 RETURNS TABLE(starts_at timestamptz,ends_at timestamptz,kind text,quota integer,manual boolean)
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH picked AS (
  SELECT a.*, (SELECT min(b.starts_at) FROM commerce.manual_allowance b WHERE b.user_id=p_user AND b.starts_at>a.starts_at) AS next_change
   FROM commerce.manual_allowance a WHERE a.user_id=p_user AND a.starts_at<=p_at ORDER BY a.starts_at DESC LIMIT 1
 ), paid AS (
  SELECT w.starts_at,w.ends_at,w.kind,w.quota,false AS manual FROM commerce.access_paid_window w
  WHERE w.user_id=p_user AND w.starts_at<=p_at AND w.ends_at>p_at ORDER BY w.starts_at DESC LIMIT 1
 ), anchored AS (
  SELECT a.*,greatest(a.starts_at,(SELECT max(w.ends_at) FROM commerce.access_paid_window w
   WHERE w.user_id=p_user AND w.ends_at<=p_at)) AS anchor
  FROM picked a WHERE a.units IS NOT NULL
 ), bounds AS (
  SELECT a.*,a.anchor+floor(extract(epoch FROM p_at-a.anchor)/(a.period_days*86400))::bigint*a.period_days*interval '24 hours' AS day_start
  FROM anchored a
 )
 SELECT b.day_start,least(b.next_change,b.day_start+b.period_days*interval '24 hours'),'days',b.units,true
 FROM bounds b WHERE b.period_days IS NOT NULL AND NOT EXISTS(SELECT 1 FROM paid)
 UNION ALL
 SELECT b.anchor,b.next_change,'calendar_months',b.units,true FROM bounds b WHERE b.period_days IS NULL AND NOT EXISTS(SELECT 1 FROM paid)
 UNION ALL
 SELECT p.starts_at,p.ends_at,p.kind,p.quota,p.manual FROM paid p
$$;
REVOKE ALL ON FUNCTION commerce.analyzer_allowance_window(text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.analyzer_allowance_window(text,timestamptz) TO finance_api;

CREATE POLICY admin_cost_cycle ON commerce.access_cycle TO CURRENT_USER USING(true);
CREATE POLICY admin_cost_totals ON commerce.ai_user_budget TO CURRENT_USER USING(true);
CREATE POLICY admin_cost_paid_window ON commerce.access_paid_window TO CURRENT_USER USING(true);
CREATE POLICY admin_cost_allowance ON commerce.manual_allowance TO CURRENT_USER USING(true);
CREATE FUNCTION commerce.control_analyzer_limits()
 RETURNS TABLE(user_id text,units integer,spent_atoms text,budget_minor text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.user_id,CASE WHEN w.manual THEN w.quota WHEN a.period_start<=now() THEN 10000 ELSE coalesce(w.quota,10000) END,
 coalesce(b.spent,0)::text,c.quota_policy->>'budgetMinor'
 FROM commerce.access_cycle c
 LEFT JOIN LATERAL commerce.analyzer_allowance_window(c.user_id,now()) w ON true
 LEFT JOIN commerce.ai_allowance_restoration a ON a.user_id=c.user_id AND a.window_start=w.starts_at AND NOT w.manual
 LEFT JOIN LATERAL (
  SELECT sum(q.spent_atoms) AS spent FROM commerce.ai_user_budget q
  WHERE q.user_id=c.user_id AND q.anchor_at=c.anchor_at AND q.period_start<=now()
   AND q.period_start=(SELECT max(q2.period_start) FROM commerce.ai_user_budget q2 WHERE q2.user_id=c.user_id AND q2.anchor_at=c.anchor_at AND q2.period_start<=now())
   AND q.period_start >= (SELECT date_trunc('milliseconds',slot.starts_at) FROM commerce.billing_period(c.anchor_at,NULL,'calendar_months',now()) slot)
 ) b ON true
$$;
REVOKE ALL ON FUNCTION commerce.control_analyzer_limits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_analyzer_limits() TO control_api;
