CREATE FUNCTION commerce.extend_customer_allowance(p_user text,p_at timestamptz,p_end timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('customer-ai-budget:'||p_user,0));
 UPDATE commerce.customer_allowance_override SET ends_at=p_end
 WHERE user_id=p_user AND starts_at<=p_at AND ends_at>p_at;
 IF FOUND THEN RETURN true; END IF;
 -- Preserve scheduled monthly allowances inside an existing multi-month purchase.
 IF EXISTS (
  SELECT 1 FROM commerce.access_paid_window w
  CROSS JOIN LATERAL commerce.billing_period(w.starts_at,w.ends_at,w.kind,p_at) slot
  WHERE w.user_id=p_user AND w.starts_at<=p_at AND w.ends_at>p_at
   AND w.kind='calendar_months' AND slot.ends_at<w.ends_at
 ) THEN RETURN true; END IF;
 SELECT * INTO b FROM commerce.customer_allowance_usage(p_user,p_at);
 RETURN commerce.set_customer_allowance(p_user,p_at,p_end,b.quota);
END $$;
REVOKE ALL ON FUNCTION commerce.extend_customer_allowance(text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.extend_customer_allowance(text,timestamptz,timestamptz) TO control_api;

-- Repair current cycles whose latest recorded revision was a manual extension.
DO $$
DECLARE c record; at_time timestamptz:=clock_timestamp();
BEGIN
 FOR c IN SELECT ac.user_id,ac.access_end FROM commerce.access_cycle ac
 WHERE ac.access_end>at_time AND EXISTS (
  SELECT 1 FROM commerce.manual_access_audit a
  WHERE a.user_id=ac.user_id AND a.data->'after'->>'revision'=ac.revision::text
   AND a.data->>'mode' IN ('extend','set_end')
   AND (a.data->'before'->>'accessEnd')::timestamptz<ac.access_end
 )
 LOOP
  PERFORM commerce.extend_customer_allowance(c.user_id,at_time,c.access_end);
 END LOOP;
END $$;
