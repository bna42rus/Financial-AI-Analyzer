-- Owner-approved 2026-11-12: account-scoped trial, bounded overrides, ordered periods.
ALTER TABLE commerce.payment_card ADD COLUMN fingerprint text, ADD COLUMN fingerprint_checked_at timestamptz;
CREATE INDEX ON commerce.payment_card(user_id,fingerprint) WHERE active;
ALTER TABLE commerce.ai_topup_order ADD COLUMN cancellation_reason text;
GRANT UPDATE(cancellation_reason) ON commerce.ai_topup_order TO finance_api;
-- One PSP receipt can credit exactly one package. Keep duplicate rows as cancelled audit evidence.
WITH ranked AS (SELECT user_id,id,row_number() OVER(PARTITION BY provider_id ORDER BY (status='paid') DESC,created_at,id) AS n FROM commerce.ai_topup_order WHERE provider_id IS NOT NULL)
UPDATE commerce.ai_topup_order o SET status='cancelled',cancellation_reason='duplicate_provider_payment',provider_id=NULL,redirect_url=NULL FROM ranked r WHERE o.user_id=r.user_id AND o.id=r.id AND r.n>1;
CREATE UNIQUE INDEX ai_topup_provider_once ON commerce.ai_topup_order(provider_id) WHERE provider_id IS NOT NULL;
CREATE TABLE commerce.account_trial_activation(user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,checkout_id uuid UNIQUE NOT NULL);
REVOKE ALL ON commerce.account_trial_activation FROM PUBLIC;
INSERT INTO commerce.account_trial_activation SELECT DISTINCT ON(user_id) user_id,checkout_id FROM commerce.trial_checkout WHERE kind='trial' AND result='granted' ORDER BY user_id,created_at;
CREATE FUNCTION commerce.claim_account_trial(p_order uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u text; BEGIN
 SELECT t.user_id INTO u FROM commerce.trial_checkout t JOIN commerce.access_checkout o ON o.id=t.checkout_id WHERE t.checkout_id=p_order AND t.kind='trial' AND t.result IS NULL AND o.state='paid' AND t.user_id=current_setting('app.user_id',true);
 IF u IS NULL OR EXISTS(SELECT 1 FROM commerce.access_checkout WHERE user_id=u AND purpose='access' AND state='paid' UNION ALL SELECT 1 FROM commerce.purchase WHERE user_id=u) THEN RETURN false; END IF;
 INSERT INTO commerce.account_trial_activation VALUES(u,p_order) ON CONFLICT DO NOTHING;RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION commerce.claim_account_trial(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.claim_account_trial(uuid) TO finance_api;
CREATE OR REPLACE FUNCTION commerce.claim_trial(p_order uuid,p_email text,p_device text,p_card text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT commerce.claim_account_trial(p_order) $$;
ALTER TABLE commerce.access_paid_window ADD COLUMN manual boolean NOT NULL DEFAULT false, ADD COLUMN allowance_anchor timestamptz;
UPDATE commerce.access_paid_window w SET allowance_anchor=c.anchor_at FROM commerce.access_cycle c WHERE c.user_id=w.user_id AND w.kind='calendar_months' AND c.extra_days=0 AND c.end_offset_ms=0;
CREATE OR REPLACE FUNCTION commerce.analyzer_allowance_window(p_user text,p_at timestamptz)
 RETURNS TABLE(starts_at timestamptz,ends_at timestamptz,kind text,quota integer,manual boolean)
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH picked AS (
  SELECT a.*, (SELECT min(b.starts_at) FROM commerce.manual_allowance b WHERE b.user_id=p_user AND b.starts_at>a.starts_at) AS next_change
   FROM commerce.manual_allowance a WHERE a.user_id=p_user AND a.starts_at<=p_at ORDER BY a.starts_at DESC LIMIT 1
 ), paid AS (
  SELECT w.starts_at,w.ends_at,w.kind,w.quota,w.manual AS manual FROM commerce.access_paid_window w
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
CREATE OR REPLACE FUNCTION commerce.customer_allowance_usage(p_user text,p_at timestamptz)
RETURNS TABLE(period_start timestamptz,period_end timestamptz,quota integer,base_used numeric,base_remaining numeric,purchased_remaining numeric,slot_bought_used numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH context AS (
  SELECT c.anchor_at,c.access_end,s.status,z.stopped_at FROM (SELECT 1) x LEFT JOIN commerce.access_cycle c ON c.user_id=p_user LEFT JOIN identity.security_state s ON s.user_id=p_user LEFT JOIN commerce.allowance_stop z ON z.user_id=p_user
 ), current_slot AS (
  SELECT COALESCE(o.starts_at,b.starts_at) AS starts_at,least(o.ends_at,b.ends_at,c.access_end) AS ends_at,
   CASE WHEN c.access_end<=p_at OR c.stopped_at>COALESCE(o.changed_at,(SELECT max(p.starts_at) FROM commerce.access_paid_window p WHERE p.user_id=p_user AND p.starts_at<=p_at AND p.ends_at>p_at),(SELECT max(m.starts_at) FROM commerce.manual_allowance m WHERE m.user_id=p_user AND m.starts_at<=p_at),c.anchor_at) THEN 0 ELSE COALESCE(o.units,CASE WHEN b.starts_at>=a.period_start THEN 10000 ELSE w.quota END,0) END AS units,
   COALESCE(o.base_before,0) AS base_before
  FROM context c
  LEFT JOIN LATERAL commerce.analyzer_allowance_window(p_user,p_at) w ON true
  CROSS JOIN LATERAL commerce.billing_period(COALESCE((SELECT p.allowance_anchor FROM commerce.access_paid_window p WHERE p.user_id=p_user AND p.starts_at=w.starts_at AND p.ends_at>p_at),w.starts_at,CASE WHEN c.anchor_at<=p_at THEN c.anchor_at END,date_trunc('month',p_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'),
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
  CROSS JOIN LATERAL commerce.billing_period(COALESCE((SELECT p.allowance_anchor FROM commerce.access_paid_window p WHERE p.user_id=p_user AND p.starts_at=w.starts_at AND p.ends_at>r.created_at),w.starts_at,CASE WHEN c.anchor_at<=r.created_at THEN c.anchor_at END,date_trunc('month',r.created_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'),
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
CREATE OR REPLACE FUNCTION commerce.set_customer_allowance(p_user text,p_at timestamptz,p_end timestamptz,p_units integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record; cap_end timestamptz;
BEGIN
 IF p_units<0 OR p_end<=p_at THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('customer-ai-budget:'||p_user,0));
 SELECT * INTO b FROM commerce.customer_allowance_usage(p_user,p_at);
 IF EXISTS(SELECT 1 FROM commerce.ai_cost_reservation WHERE user_id=p_user AND step<>'classification' AND created_at>=b.period_start AND state IN ('reserved','unknown')) THEN
  RETURN false;
 END IF;
 SELECT least(p_end,b.period_end) INTO cap_end;
 IF NOT EXISTS(SELECT 1 FROM commerce.access_paid_window WHERE user_id=p_user AND starts_at<=p_at AND ends_at>p_at) AND NOT EXISTS(SELECT 1 FROM commerce.customer_allowance_override WHERE user_id=p_user AND starts_at<=p_at AND ends_at>p_at) THEN cap_end:=p_end;END IF;
 INSERT INTO commerce.customer_allowance_override(user_id,starts_at,ends_at,changed_at,units,base_before,bought_before)
 VALUES(p_user,b.period_start,cap_end,p_at,p_units,b.base_used,b.slot_bought_used)
 ON CONFLICT(user_id,starts_at) DO UPDATE SET ends_at=EXCLUDED.ends_at,changed_at=EXCLUDED.changed_at,
  units=EXCLUDED.units,base_before=EXCLUDED.base_before,bought_before=EXCLUDED.bought_before;
 RETURN true;
END $$;

CREATE FUNCTION commerce.edit_access_periods(p_user text,p_at timestamptz,p_old_end timestamptz,p_end timestamptz,p_tail_units integer,p_period_days integer DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tail_start timestamptz;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('customer-ai-budget:'||p_user,0));
 IF EXISTS(SELECT 1 FROM commerce.ai_cost_reservation WHERE user_id=p_user AND state IN ('reserved','unknown')) THEN RETURN false;END IF;
 IF p_end IS NOT NULL THEN
  DELETE FROM commerce.access_paid_window WHERE user_id=p_user AND starts_at>=p_end;
  UPDATE commerce.access_paid_window SET ends_at=p_end WHERE user_id=p_user AND ends_at>p_end AND starts_at<p_end;
  UPDATE commerce.customer_allowance_override SET ends_at=greatest(changed_at,least(ends_at,p_end)) WHERE user_id=p_user AND ends_at>p_end;
  UPDATE commerce.access_checkout o SET access_end=p_end FROM commerce.trial_checkout t WHERE t.checkout_id=o.id AND t.user_id=p_user AND t.kind='trial' AND t.result='granted' AND o.access_end>p_end;
 END IF;
 IF p_old_end IS NOT NULL AND (p_end IS NULL OR p_end>p_old_end) THEN
  tail_start:=greatest(p_old_end,p_at);
  IF p_end IS NULL OR p_end>tail_start THEN
   IF p_period_days>0 THEN
   INSERT INTO commerce.access_paid_window(user_id,starts_at,ends_at,kind,quota,manual) SELECT p_user,s,least(p_end,s+make_interval(days=>p_period_days)),'days',p_tail_units,true FROM generate_series(tail_start,p_end-interval '1 microsecond',make_interval(days=>p_period_days)) s;
   ELSE
    INSERT INTO commerce.access_paid_window(user_id,starts_at,ends_at,kind,quota,manual) VALUES(p_user,tail_start,coalesce(p_end,'infinity'::timestamptz),CASE WHEN p_end IS NULL OR p_period_days=0 THEN 'calendar_months' ELSE 'days' END,p_tail_units,true);
   END IF;
  END IF;
 END IF;
 UPDATE commerce.autorenewal SET state='off',method_id=NULL,notice_id=NULL,next_at=coalesce(p_end,p_at) WHERE user_id=p_user;
 INSERT INTO commerce.autorenewal_event(user_id,action) VALUES(p_user,'disable');
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION commerce.edit_access_periods(text,timestamptz,timestamptz,timestamptz,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.edit_access_periods(text,timestamptz,timestamptz,timestamptz,integer,integer) TO control_api;
-- Repair overlong historical overrides at the next paid/monthly boundary, never extend them.
UPDATE commerce.customer_allowance_override o SET ends_at=greatest(o.changed_at,least(o.ends_at,
 (SELECT slot.ends_at FROM commerce.analyzer_allowance_window(o.user_id,o.changed_at) w CROSS JOIN LATERAL commerce.billing_period(w.starts_at,w.ends_at,w.kind,o.changed_at) slot),
 (SELECT min(w.starts_at) FROM commerce.access_paid_window w WHERE w.user_id=o.user_id AND w.starts_at>o.changed_at)));
-- A previously changed access clock cannot keep a stale automatic charge.
UPDATE commerce.autorenewal r SET state='off',method_id=NULL,notice_id=NULL,next_at=c.access_end FROM commerce.access_cycle c WHERE c.user_id=r.user_id AND r.state='active' AND c.access_end IS NOT NULL AND r.next_at<>c.access_end;
CREATE OR REPLACE FUNCTION commerce.control_trial_status(p_user text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM commerce.trial_checkout t JOIN commerce.access_checkout o ON o.id=t.checkout_id JOIN commerce.access_cycle c ON c.user_id=t.user_id WHERE t.user_id=p_user AND t.kind='trial' AND t.result='granted' AND least(o.access_end,c.access_end)>clock_timestamp()) THEN 'active'
 WHEN EXISTS(SELECT 1 FROM commerce.account_trial_activation WHERE user_id=p_user) OR EXISTS(SELECT 1 FROM commerce.access_checkout WHERE user_id=p_user AND purpose='access' AND state='paid' UNION ALL SELECT 1 FROM commerce.purchase WHERE user_id=p_user) THEN 'used'
 WHEN n.trial_state='denied' THEN 'failed' ELSE 'new' END FROM (SELECT 1) x LEFT JOIN commerce.onboarding_account n ON n.user_id=p_user
$$;
CREATE OR REPLACE FUNCTION commerce.control_customer_allowances(p_users text[])
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
