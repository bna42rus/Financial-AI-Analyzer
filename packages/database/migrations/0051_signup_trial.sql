-- Owner-approved 2026-11-11: signup before payment, with legacy invitations retained.
ALTER TABLE commerce.access_checkout ADD COLUMN save_card boolean NOT NULL DEFAULT false;
GRANT UPDATE(save_card) ON commerce.access_checkout TO finance_api;
CREATE TABLE identity.signup_pending(
 id uuid PRIMARY KEY,email text NOT NULL,name text NOT NULL,password_hash text NOT NULL,
 code_hash text NOT NULL,terms_version text NOT NULL,consent_version text NOT NULL,
 expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 registered_user_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON identity.signup_pending(expires_at);
REVOKE ALL ON identity.signup_pending FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON identity.signup_pending TO finance_api;
ALTER TABLE identity.signup_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.signup_pending FORCE ROW LEVEL SECURITY;
CREATE POLICY signup_service ON identity.signup_pending TO finance_api USING(true) WITH CHECK(true);
CREATE TABLE commerce.onboarding_account(
 user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 trial_state text NOT NULL DEFAULT 'new' CHECK(trial_state IN ('new','pending','active','used','denied'))
);
CREATE TABLE commerce.trial_checkout(
 checkout_id uuid PRIMARY KEY REFERENCES commerce.access_checkout(id),
 user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 renewal_tariff jsonb NOT NULL,device_key text NOT NULL,email_key text NOT NULL,
 result text CHECK(result IN ('granted','denied')),refund_key uuid NOT NULL UNIQUE,
 refund_id uuid,refund_state text NOT NULL DEFAULT 'required' CHECK(refund_state IN ('required','pending','succeeded','canceled')),
 refund_attempt_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Masked-card signatures are conservative repeat-use signals, not bank fingerprints.
-- No raw email, PAN, CVC or saved-payment token is retained in the claim ledger.
CREATE TABLE commerce.trial_claim(
 checkout_id uuid PRIMARY KEY,email_key text NOT NULL UNIQUE,device_key text NOT NULL UNIQUE,
 card_key text NOT NULL UNIQUE,claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE commerce.saved_card(
 user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 method_id text NOT NULL,last4 text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['onboarding_account','trial_checkout','saved_card'] LOOP
 EXECUTE format('ALTER TABLE commerce.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE commerce.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY own ON commerce.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',t);
 EXECUTE format('CREATE POLICY admin ON commerce.%I TO control_api USING(true)',t);
 EXECUTE format('CREATE POLICY migration_owner ON commerce.%I TO CURRENT_USER USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON commerce.%I TO finance_api',t);
 EXECUTE format('GRANT SELECT ON commerce.%I TO control_api',t);
 END LOOP;
END $$;
INSERT INTO commerce.saved_card(user_id,method_id) SELECT user_id,method_id FROM commerce.autorenewal WHERE method_id IS NOT NULL;
REVOKE ALL ON commerce.trial_claim FROM PUBLIC;
CREATE FUNCTION commerce.claim_trial(p_order uuid,p_email text,p_device text,p_card text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM commerce.trial_checkout t JOIN commerce.access_checkout o ON o.id=t.checkout_id
 WHERE t.checkout_id=p_order AND t.user_id=current_setting('app.user_id',true) AND o.state='paid'
 AND t.email_key=p_email AND t.device_key=p_device AND t.result IS NULL) THEN RETURN false; END IF;
 INSERT INTO commerce.trial_claim(checkout_id,email_key,device_key,card_key) VALUES(p_order,p_email,p_device,p_card)
 ON CONFLICT DO NOTHING;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION commerce.claim_trial(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.claim_trial(uuid,text,text,text) TO finance_api;
CREATE FUNCTION commerce.trial_refunds_due() RETURNS TABLE(user_id text,checkout_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT t.user_id,t.checkout_id FROM commerce.trial_checkout t JOIN commerce.access_checkout o ON o.id=t.checkout_id
 WHERE o.state='paid' AND t.refund_state IN ('required','pending')
 AND (t.refund_attempt_at IS NULL OR t.refund_attempt_at<clock_timestamp()-interval '5 minutes')
 ORDER BY t.created_at LIMIT 50
$$;
REVOKE ALL ON FUNCTION commerce.trial_refunds_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.trial_refunds_due() TO finance_api;
CREATE FUNCTION commerce.control_renewal_status(p_user text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('state',r.state,'nextAt',r.next_at,'priceMinor',r.tariff->>'priceMinor') FROM commerce.autorenewal r WHERE r.user_id=p_user
$$;
REVOKE ALL ON FUNCTION commerce.control_renewal_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_renewal_status(text) TO control_api;
CREATE OR REPLACE FUNCTION commerce.record_checkout_refund(p_id uuid,p_payment uuid,p_amount integer,p_state text,p_at timestamptz)
 RETURNS TABLE(checkout_id uuid,notify_email text,fully_refunded boolean,changed boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE o commerce.access_checkout; p commerce.purchase; prior text; total bigint; address text;
 BEGIN
  IF EXISTS(SELECT 1 FROM commerce.trial_checkout t JOIN commerce.access_checkout c ON c.id=t.checkout_id WHERE c.provider_id=p_payment) THEN RETURN; END IF;
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
