-- Keep the package identity separate from editable units and historical order snapshots.
ALTER TABLE commerce.ai_topup_order DROP CONSTRAINT ai_topup_order_units_fkey;
ALTER TABLE commerce.ai_pack DROP CONSTRAINT ai_pack_units_check;
ALTER TABLE commerce.ai_pack ADD CONSTRAINT ai_pack_units_check CHECK(units BETWEEN 1 AND 1000000);
ALTER TABLE commerce.ai_pack ADD COLUMN catalog_id text NOT NULL DEFAULT gen_random_uuid()::text UNIQUE;
GRANT INSERT ON access.tariff TO control_api;
GRANT INSERT ON commerce.ai_pack TO control_api;
GRANT UPDATE(units) ON commerce.ai_pack TO control_api;

CREATE TABLE control.display_preferences (
 user_id text PRIMARY KEY REFERENCES control.auth_user(id) ON DELETE CASCADE,
 timezone text NOT NULL
);
REVOKE ALL ON control.display_preferences FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON control.display_preferences TO control_api;

CREATE FUNCTION commerce.control_user_access_status(p_user text,p_previous text,p_next text,p_revoke boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_previous NOT IN ('active','suspended') OR p_next NOT IN ('active','suspended') OR p_previous=p_next THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-cycle:'||p_user,0));
 UPDATE identity.security_state SET status=p_next WHERE user_id=p_user AND status=p_previous;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_next='suspended' AND p_revoke THEN
  DELETE FROM identity.auth_session WHERE user_id=p_user;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION commerce.control_user_access_status(text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_user_access_status(text,text,text,boolean) TO control_api;

-- Audit rows are removed with their actions during account erasure.
ALTER TABLE commerce.manual_access_audit DROP CONSTRAINT manual_access_audit_action_id_fkey;
ALTER TABLE commerce.manual_access_audit ADD FOREIGN KEY(action_id) REFERENCES commerce.action(id) ON DELETE CASCADE;

ALTER TABLE commerce.access_checkout ADD COLUMN provider_paid_at timestamptz,
 ADD COLUMN provider_expires_at timestamptz, ADD COLUMN cancellation_reason text,
 ADD COLUMN previous_end timestamptz, ADD COLUMN access_end timestamptz, ADD COLUMN reconcile_reason text;
ALTER TABLE commerce.purchase DROP CONSTRAINT purchase_state_check;
ALTER TABLE commerce.purchase ADD CONSTRAINT purchase_state_check CHECK(state IN ('paid_not_activated','active','refunded'));

CREATE TABLE commerce.checkout_reconciliation (
 checkout_id uuid PRIMARY KEY REFERENCES commerce.access_checkout(id) ON DELETE CASCADE,
 provider_id uuid, state text NOT NULL CHECK(state IN ('checking','verified','unknown','applying','resolved')),
 provider_state text CHECK(provider_state IN ('succeeded','canceled','pending','waiting_for_capture')),
 message text, actor_id text NOT NULL, action_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE commerce.checkout_refund (
 id uuid PRIMARY KEY, checkout_id uuid REFERENCES commerce.access_checkout(id) ON DELETE SET NULL,
 payment_provider_id uuid NOT NULL, amount_minor integer NOT NULL CHECK(amount_minor>0),
 state text NOT NULL CHECK(state IN ('pending','succeeded','canceled')),
 created_at timestamptz NOT NULL
);
CREATE INDEX ON commerce.checkout_refund(checkout_id,created_at);
REVOKE ALL ON commerce.checkout_reconciliation,commerce.checkout_refund FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON commerce.checkout_reconciliation TO control_api,finance_api;
GRANT SELECT ON commerce.checkout_refund TO control_api;

CREATE FUNCTION commerce.flag_stale_checkouts() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
 UPDATE commerce.access_checkout SET state='reconcile',reconcile_reason='provider_reference_missing'
 WHERE state='created' AND provider_id IS NULL AND created_at<clock_timestamp()-interval '23 hours';
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION commerce.flag_stale_checkouts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.flag_stale_checkouts() TO finance_api;

CREATE FUNCTION commerce.reconciliation_target(p_id uuid)
 RETURNS TABLE(application_id text,user_id text,email text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.application_id,o.user_id,COALESCE(u.email,r.email)
 FROM commerce.access_checkout o LEFT JOIN identity.auth_user u ON u.id=o.user_id
 LEFT JOIN access.request r ON r.id=o.application_id WHERE o.id=p_id AND o.state='reconcile'
$$;
REVOKE ALL ON FUNCTION commerce.reconciliation_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.reconciliation_target(uuid) TO finance_api;

CREATE FUNCTION commerce.record_checkout_refund(p_id uuid,p_payment uuid,p_amount integer,p_state text,p_at timestamptz)
 RETURNS TABLE(checkout_id uuid,notify_email text,fully_refunded boolean,changed boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE o commerce.access_checkout; p commerce.purchase; prior text; total bigint; address text;
 BEGIN
  IF p_amount<=0 OR p_state NOT IN ('pending','succeeded','canceled') THEN RETURN; END IF;
  SELECT * INTO o FROM commerce.access_checkout WHERE provider_id=p_payment AND state='paid' FOR UPDATE;
  IF NOT FOUND OR p_amount>(o.tariff->>'priceMinor')::bigint THEN RETURN; END IF;
  SELECT state INTO prior FROM commerce.checkout_refund WHERE id=p_id AND payment_provider_id=p_payment AND amount_minor=p_amount;
  IF prior=p_state OR prior IN ('succeeded','canceled') THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM commerce.checkout_refund f WHERE f.id=p_id AND (f.payment_provider_id<>p_payment OR f.amount_minor<>p_amount)) THEN RETURN; END IF;
  IF p_state='succeeded' AND (SELECT COALESCE(sum(f.amount_minor),0) FROM commerce.checkout_refund f WHERE f.checkout_id=o.id AND f.state='succeeded')+p_amount>(o.tariff->>'priceMinor')::bigint THEN RETURN; END IF;
  INSERT INTO commerce.checkout_refund(id,checkout_id,payment_provider_id,amount_minor,state,created_at)
  VALUES(p_id,o.id,p_payment,p_amount,p_state,p_at)
  ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state;
  SELECT COALESCE(sum(amount_minor),0) INTO total FROM commerce.checkout_refund f WHERE f.checkout_id=o.id AND f.state='succeeded';
  fully_refunded:=total>=(o.tariff->>'priceMinor')::bigint;
  IF o.application_id IS NOT NULL THEN
   SELECT * INTO p FROM commerce.purchase WHERE request_id=o.application_id FOR UPDATE;
   SELECT email INTO address FROM identity.auth_user WHERE id=p.user_id;
   IF address IS NULL THEN SELECT email INTO address FROM access.request WHERE id=o.application_id; END IF;
   IF fully_refunded AND p.state='paid_not_activated' THEN
    UPDATE commerce.invitation SET state='cancelled' WHERE purchase_id=p.id AND state IN ('active','expired');
    UPDATE commerce.purchase SET state='refunded' WHERE id=p.id;
    UPDATE access.request SET data=data||jsonb_build_object('status','rejected','refundStatus','refunded','revision',COALESCE((data->>'revision')::int,0)+1) WHERE id=o.application_id;
   END IF;
  ELSE
   SELECT email INTO address FROM identity.auth_user WHERE id=o.user_id;
  END IF;
  IF p_state='succeeded' THEN
   INSERT INTO commerce.action(id,actor_id,payload) VALUES('refund:'||p_id::text,'',jsonb_build_object(
    'kind','billing_refund','target',o.tariff->>'name','checkoutId',o.id,'changes',jsonb_build_array(jsonb_build_object('label','Возвращено, ₽','before',0,'after',p_amount::numeric/100))))
   ON CONFLICT DO NOTHING;
  END IF;
  checkout_id:=o.id; notify_email:=CASE WHEN p_state='succeeded' THEN address END; changed:=true;
  RETURN NEXT;
 END $$;
REVOKE ALL ON FUNCTION commerce.record_checkout_refund(uuid,uuid,integer,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.record_checkout_refund(uuid,uuid,integer,text,timestamptz) TO finance_api;

DROP FUNCTION commerce.control_checkout_queue();
CREATE FUNCTION commerce.control_checkout_queue(p_id uuid DEFAULT NULL) RETURNS TABLE(
 id uuid,channel text,status text,mode text,tariff text,price_minor text,provider_id uuid,created_at timestamptz,paid_at timestamptz,
 application_id text,user_id text,email text,provider_paid_at timestamptz,provider_expires_at timestamptz,cancellation_reason text,
 previous_end timestamptz,access_end timestamptz,reconcile_reason text,reconciliation jsonb,refunds jsonb,registered boolean
) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id,CASE WHEN o.application_id IS NULL THEN 'renewal' ELSE 'first' END,
  o.state,o.mode,o.tariff->>'name',o.tariff->>'priceMinor',o.provider_id,o.created_at,o.paid_at,o.application_id,COALESCE(o.user_id,p.user_id),
  COALESCE(u.email,r.email),o.provider_paid_at,o.provider_expires_at,o.cancellation_reason,o.previous_end,COALESCE(o.access_end,p.access_end),o.reconcile_reason,
  CASE WHEN q.checkout_id IS NOT NULL THEN jsonb_build_object('state',q.state,'providerStatus',q.provider_state,'message',q.message,'providerId',q.provider_id) END,
  COALESCE(f.rows,'[]'::jsonb),o.user_id IS NOT NULL OR p.state='active'
 FROM commerce.access_checkout o
 LEFT JOIN access.request r ON r.id=o.application_id LEFT JOIN commerce.purchase p ON p.request_id=o.application_id
 LEFT JOIN commerce.account_directory u ON u.user_id=COALESCE(o.user_id,p.user_id)
 LEFT JOIN commerce.checkout_reconciliation q ON q.checkout_id=o.id
 LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',f.id,'state',f.state,'amountMinor',f.amount_minor,'at',f.created_at) ORDER BY f.created_at DESC,f.id) AS rows FROM commerce.checkout_refund f WHERE f.checkout_id=o.id) f ON true
 ORDER BY (o.id IS NOT DISTINCT FROM p_id) DESC,(o.state='reconcile') DESC,o.created_at DESC,o.id LIMIT 500
$$;
REVOKE ALL ON FUNCTION commerce.control_checkout_queue(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_checkout_queue(uuid) TO control_api;

CREATE FUNCTION commerce.record_deletion_withdrawal(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO commerce.action(id,actor_id,payload)
 SELECT 'withdrawal:'||d.id::text,'',jsonb_build_object('kind','account_deletion_withdrawn','changes',jsonb_build_array(
  jsonb_build_object('label','Статус заявки','before','Ожидает решения','after','Заявка отозвана')))
 FROM identity.account_deletion d WHERE d.id=p_id AND d.status='pending' AND d.user_id=current_setting('app.user_id',true)
 ON CONFLICT DO NOTHING
$$;
REVOKE ALL ON FUNCTION commerce.record_deletion_withdrawal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.record_deletion_withdrawal(uuid) TO finance_api;

DROP FUNCTION commerce.control_analyzer_limits();
CREATE FUNCTION commerce.control_analyzer_limits()
 RETURNS TABLE(user_id text,units integer,spent_atoms text,budget_minor text,reset_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.user_id,CASE WHEN w.manual THEN w.quota WHEN a.period_start<=now() THEN 10000 ELSE coalesce(w.quota,10000) END,
 coalesce(b.spent,0)::text,c.quota_policy->>'budgetMinor',
 CASE WHEN c.indefinite OR c.access_end>now() THEN (SELECT slot.ends_at FROM commerce.billing_period(COALESCE(w.starts_at,c.anchor_at),least(w.ends_at,c.access_end),COALESCE(w.kind,'calendar_months'),now()) slot) END
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

CREATE FUNCTION commerce.control_paid_allowance_end(p_user text) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT max(w.ends_at) FROM commerce.access_paid_window w WHERE w.user_id=p_user AND w.starts_at<=now() AND w.ends_at>now()
$$;
REVOKE ALL ON FUNCTION commerce.control_paid_allowance_end(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_paid_allowance_end(text) TO control_api;

CREATE FUNCTION commerce.record_checkout_completion(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO commerce.action(id,actor_id,payload)
 SELECT 'checkout:'||o.id::text,'',jsonb_build_object('kind',CASE WHEN o.application_id IS NULL THEN 'checkout_renewed' ELSE 'checkout_paid' END,
  'checkoutId',o.id,'requestId',o.application_id,'userId',o.user_id,'email',COALESCE(u.email,r.email),'before',o.previous_end,'after',o.access_end,
  'changes',jsonb_build_array(jsonb_build_object('label','Оплата','before','Ожидает оплаты','after','Оплачен')))
 FROM commerce.access_checkout o LEFT JOIN identity.auth_user u ON u.id=o.user_id LEFT JOIN access.request r ON r.id=o.application_id
 WHERE o.id=p_id AND o.state='paid' AND (o.user_id=current_setting('app.user_id',true) OR o.application_id=current_setting('app.checkout_application',true))
 ON CONFLICT DO NOTHING
$$;
REVOKE ALL ON FUNCTION commerce.record_checkout_completion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.record_checkout_completion(uuid) TO finance_api;
