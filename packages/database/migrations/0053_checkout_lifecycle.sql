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
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',COALESCE(j.refund_id,j.refund_key),'state',j.refund_state,'amountMinor',j.amount_minor,'at',COALESCE(j.refund_attempt_at,j.created_at))) FROM commerce.card_refund_job j WHERE j.checkout_id=o.id),'[]'::jsonb)
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
CREATE FUNCTION commerce.activate_checkout_counter(p_order uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 UPDATE commerce.access_cycle c SET quota_policy=jsonb_build_object('source','tariff','tariffId',o.tariff->>'id','limit',(o.tariff->>'aiQuota')::int)
 FROM commerce.access_checkout o WHERE o.id=p_order AND o.state='paid' AND o.user_id=c.user_id
 AND c.user_id=current_setting('app.user_id',true) AND c.quota_policy->>'source'='override' AND c.quota_policy->>'limit'='0'
 AND EXISTS(SELECT 1 FROM commerce.onboarding_account n WHERE n.user_id=c.user_id)
$$;
REVOKE ALL ON FUNCTION commerce.activate_checkout_counter(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.activate_checkout_counter(uuid) TO finance_api;
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

-- An externally pending cancellation cannot be erased before its final financial outcome.
CREATE OR REPLACE FUNCTION commerce.finish_account_deletion(p_id uuid,p_actor text,p_email text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE candidate identity.account_deletion; owner_email text; ids text[]; applications text[]; invitation_ids text[]; grants text[]; old_mail uuid[];
 BEGIN
  PERFORM pg_advisory_xact_lock(92042);
  PERFORM pg_advisory_xact_lock(92044);
  SELECT * INTO candidate FROM identity.account_deletion WHERE id=p_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN
   IF EXISTS(SELECT 1 FROM identity.erasure_evidence e WHERE e.id=p_id AND e.actor_id=p_actor) THEN RETURN 'already_completed'; END IF;
   RETURN 'DELETION_NOT_PENDING';
  END IF;
  SELECT u.email INTO owner_email FROM identity.auth_user u JOIN identity.security_state s ON s.user_id=u.id
   WHERE u.id=candidate.user_id AND u.email_verified AND s.epoch=candidate.epoch FOR UPDATE OF u,s;
  IF owner_email IS DISTINCT FROM p_email THEN RETURN 'DELETION_EMAIL_CHANGED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-ai-budget:'||candidate.user_id,0));
  PERFORM set_config('app.erasure_user',candidate.user_id,true);
  SELECT coalesce(array_agg(r.id),'{}') INTO applications FROM access.request r
   WHERE r.email=p_email OR EXISTS(SELECT 1 FROM commerce.purchase p WHERE p.request_id=r.id AND p.user_id=candidate.user_id);
  PERFORM set_config('app.erasure_requests',array_to_string(applications,','),true);
  IF EXISTS(SELECT 1 FROM commerce.access_checkout o WHERE (o.user_id=candidate.user_id OR o.application_id=ANY(applications)) AND (o.state IN ('created','pending','reconcile') OR o.cancel_requested AND o.provider_id IS NOT NULL AND COALESCE(o.provider_status,'pending') NOT IN ('succeeded','canceled')))
   OR EXISTS(SELECT 1 FROM commerce.ai_topup_order o WHERE o.user_id=candidate.user_id AND o.status IN ('created','pending'))
   OR EXISTS(SELECT 1 FROM commerce.renewal_request r WHERE r.user_id=candidate.user_id AND r.data->>'status' IN ('under_review','needs_topup'))
   OR EXISTS(SELECT 1 FROM access.request r WHERE r.id=ANY(applications) AND r.data->>'status' IN ('under_review','needs_topup'))
  THEN RETURN 'DELETION_PAYMENT_PENDING'; END IF;
  IF EXISTS(SELECT 1 FROM commerce.ai_cost_reservation c WHERE c.user_id=candidate.user_id AND c.state IN ('reserved','unknown'))
  THEN RETURN 'DELETION_ANALYZER_PENDING'; END IF;
  SELECT coalesce(array_agg(g.id),'{}') INTO grants FROM commerce.manual_grant g WHERE g.user_id=candidate.user_id OR g.email=p_email;
  SELECT coalesce(array_agg(i.id),'{}') INTO invitation_ids FROM commerce.invitation i
   WHERE i.email=p_email OR i.manual_grant_id=ANY(grants) OR EXISTS(SELECT 1 FROM commerce.purchase p WHERE p.id=i.purchase_id AND p.request_id=ANY(applications));
  SELECT ARRAY[candidate.user_id,p_id::text]||applications||invitation_ids||grants
   ||ARRAY(SELECT r.id FROM commerce.renewal_request r WHERE r.user_id=candidate.user_id)
   INTO ids;
  -- Lock rows before checking their leases. A mail worker cannot claim a matching row once locked.
  PERFORM 1 FROM identity.outbox o WHERE o.subject_id=ANY(ids) OR o.recipient=p_email FOR UPDATE;
  PERFORM 1 FROM access.outbox o WHERE o.subject_id=ANY(ids) OR o.recipient=p_email FOR UPDATE;
  IF EXISTS(SELECT 1 FROM identity.outbox o WHERE (o.subject_id=ANY(ids) OR o.recipient=p_email) AND o.lease_until>clock_timestamp())
   OR EXISTS(SELECT 1 FROM access.outbox o WHERE (o.subject_id=ANY(ids) OR o.recipient=p_email) AND o.lease_until>clock_timestamp())
  THEN RETURN 'DELETION_MAIL_PENDING'; END IF;

  INSERT INTO commerce.erased_account_payment(id,kind,paid_at,amount_minor,provider_reference,contract_version)
   SELECT o.id::text,'access',o.paid_at,o.tariff->>'priceMinor',o.provider_id::text,o.offer_version
    FROM commerce.access_checkout o WHERE (o.user_id=candidate.user_id OR o.application_id=ANY(applications)) AND o.state='paid'
   UNION ALL SELECT o.id::text,'analyzer',o.paid_at,o.price_minor::text,o.provider_id::text,NULL
    FROM commerce.ai_topup_order o WHERE o.user_id=candidate.user_id AND o.status='paid'
   UNION ALL SELECT p->>'id','manual_payment',(p->>'receivedAt')::timestamptz,p->>'actualMinor',NULL,NULL
    FROM commerce.review_state r CROSS JOIN LATERAL jsonb_array_elements(r.data->'payments') p WHERE r.request_id=ANY(applications)
   UNION ALL SELECT p->>'id','manual_renewal',(p->>'receivedAt')::timestamptz,p->>'actualMinor',NULL,NULL
    FROM commerce.renewal_request r CROSS JOIN LATERAL jsonb_array_elements(r.review_state->'payments') p WHERE r.user_id=candidate.user_id
   ON CONFLICT(id) DO NOTHING;

  SELECT ARRAY(SELECT d.id FROM mail.delivery d WHERE d.subject_id=ANY(ids) OR d.recipient=p_email) INTO old_mail;
  DELETE FROM mail.resend_audit a WHERE a.delivery_id=ANY(old_mail);
  DELETE FROM identity.outbox o WHERE o.id=ANY(old_mail) OR o.subject_id=ANY(ids) OR o.recipient=p_email;
  DELETE FROM access.outbox o WHERE o.id=ANY(old_mail) OR o.subject_id=ANY(ids) OR o.recipient=p_email;
  DELETE FROM mail.delivery d WHERE d.id=ANY(old_mail);
  DELETE FROM commerce.autorenewal a WHERE a.user_id=candidate.user_id;
  DELETE FROM commerce.access_extension e WHERE e.user_id=candidate.user_id;
  DELETE FROM commerce.access_cycle c WHERE c.user_id=candidate.user_id;
  DELETE FROM commerce.action a WHERE a.payload->>'userId'=candidate.user_id OR lower(a.payload->>'email')=p_email
   OR a.payload->>'requestId'=ANY(ids) OR a.payload->>'invitationId'=ANY(ids)
   OR a.payload->>'delivery'=ANY(old_mail::text[]);
  DELETE FROM commerce.manual_access_audit a WHERE lower(a.data->>'email')=p_email OR a.data->>'userId'=candidate.user_id;
  DELETE FROM commerce.invitation i WHERE i.id=ANY(invitation_ids);
  DELETE FROM commerce.manual_grant g WHERE g.id=ANY(grants);
  DELETE FROM access.request r WHERE r.id=ANY(applications);
  DELETE FROM identity.auth_verification v WHERE v.identifier=p_email OR v.id='profile-email:'||candidate.user_id;
  DELETE FROM identity.security_event e WHERE e.user_id=candidate.user_id;
  DELETE FROM identity.auth_user u WHERE u.id=candidate.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'account erasure did not remove identity'; END IF;
  INSERT INTO identity.erasure_evidence(id,former_user_id,requested_at,erased_at,actor_id,evidence_until)
   VALUES(p_id,candidate.user_id,candidate.requested_at,clock_timestamp(),p_actor,clock_timestamp()+interval '3 years');
  INSERT INTO commerce.action(id,actor_id,payload) VALUES(p_id::text,p_actor,jsonb_build_object('kind','account_deletion_completed'));
  RETURN 'completed';
 END $$;
