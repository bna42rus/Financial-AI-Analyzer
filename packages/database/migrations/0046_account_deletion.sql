CREATE TABLE identity.account_deletion (
 id uuid PRIMARY KEY,
 user_id text NOT NULL UNIQUE REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('awaiting_code','pending')),
 epoch integer NOT NULL,
 verifier text,
 expires_at timestamptz,
 requested_at timestamptz,
 CHECK ((status='awaiting_code')=(verifier IS NOT NULL AND expires_at IS NOT NULL)),
 CHECK ((status='pending')=(requested_at IS NOT NULL))
);
ALTER TABLE identity.account_deletion ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.account_deletion FORCE ROW LEVEL SECURITY;
CREATE POLICY own_deletion ON identity.account_deletion TO finance_api
 USING(user_id=current_setting('app.user_id',true)) WITH CHECK(user_id=current_setting('app.user_id',true));
CREATE POLICY erasure_operator ON identity.account_deletion TO CURRENT_USER USING(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON identity.account_deletion TO finance_api;

-- Operator-only evidence for the statutory destruction act, log extract and backup restores.
CREATE TABLE identity.erasure_evidence (
 id uuid PRIMARY KEY, former_user_id text NOT NULL, requested_at timestamptz NOT NULL,
 erased_at timestamptz NOT NULL, actor_id text NOT NULL,
 destruction_method text NOT NULL DEFAULT 'database physical row deletion',
 evidence_until timestamptz NOT NULL
);
CREATE TABLE commerce.erased_account_payment (
 id text PRIMARY KEY, kind text NOT NULL, paid_at timestamptz,
 amount_minor text, provider_reference text, contract_version text
);
REVOKE ALL ON identity.erasure_evidence,commerce.erased_account_payment FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE INDEX erasure_evidence_expiry ON identity.erasure_evidence(evidence_until);

CREATE FUNCTION commerce.control_deletion_queue()
 RETURNS TABLE(id uuid,email text,requested_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT d.id,u.email,d.requested_at FROM identity.account_deletion d
 JOIN identity.auth_user u ON u.id=d.user_id JOIN identity.security_state s ON s.user_id=u.id
 WHERE d.status='pending' AND d.epoch=s.epoch AND u.email_verified
 ORDER BY d.requested_at,d.id
$$;
REVOKE ALL ON FUNCTION commerce.control_deletion_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_deletion_queue() TO control_api;

CREATE FUNCTION commerce.control_deletion_preview(p_id uuid)
 RETURNS TABLE(operations bigint,imports bigint,dialogs bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT (SELECT count(*) FROM finance.transaction t WHERE t.user_id=d.user_id),
  (SELECT count(*) FROM finance.ingestion_batch b WHERE b.user_id=d.user_id),
  (SELECT count(*) FROM finance.analyzer_chat c WHERE c.user_id=d.user_id)
 FROM identity.account_deletion d JOIN identity.security_state s ON s.user_id=d.user_id AND s.epoch=d.epoch
 WHERE d.id=p_id AND d.status='pending'
$$;
REVOKE ALL ON FUNCTION commerce.control_deletion_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_deletion_preview(uuid) TO control_api;

DO $$ DECLARE name regclass; BEGIN
 FOREACH name IN ARRAY ARRAY['commerce.access_checkout'::regclass,'commerce.ai_topup_order'::regclass,
  'commerce.ai_cost_reservation'::regclass,'commerce.analyzer_request'::regclass,'commerce.autorenewal'::regclass,
  'commerce.renewal_request'::regclass,'commerce.access_extension'::regclass] LOOP
  EXECUTE format('CREATE POLICY erase_one_account ON %s TO CURRENT_USER USING(user_id=current_setting(''app.erasure_user'',true))',name);
 END LOOP;
END $$;
CREATE POLICY erase_application_checkout ON commerce.access_checkout TO CURRENT_USER
 USING(application_id=ANY(string_to_array(current_setting('app.erasure_requests',true),',')));
CREATE POLICY erase_mail_deliveries ON mail.delivery TO CURRENT_USER USING(true);

CREATE FUNCTION commerce.finish_account_deletion(p_id uuid,p_actor text,p_email text)
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
  IF EXISTS(SELECT 1 FROM commerce.access_checkout o WHERE (o.user_id=candidate.user_id OR o.application_id=ANY(applications)) AND o.state IN ('created','pending','reconcile'))
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
REVOKE ALL ON FUNCTION commerce.finish_account_deletion(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.finish_account_deletion(uuid,text,text) TO control_api;

CREATE FUNCTION identity.deletion_mail_current(p_id text,p_status text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM identity.account_deletion d WHERE d.id::text=p_id AND status=p_status AND (p_status='pending' OR expires_at>now()))
$$;
REVOKE ALL ON FUNCTION identity.deletion_mail_current(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.deletion_mail_current(text,text) TO mail_finance;
