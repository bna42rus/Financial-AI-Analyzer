-- Look up only a provider-bound payment. Browser identifiers do not grant access.
CREATE FUNCTION commerce.yookassa_payment_target(p_payment uuid)
 RETURNS TABLE(id uuid,user_id text,application_id text,kind text,state text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id,o.user_id,o.application_id,'access',o.state
 FROM commerce.access_checkout o WHERE o.provider_id=p_payment
 UNION ALL
 SELECT o.id,o.user_id,NULL,'topup',o.status
 FROM commerce.ai_topup_order o WHERE o.provider_id=p_payment
$$;
REVOKE ALL ON FUNCTION commerce.yookassa_payment_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.yookassa_payment_target(uuid) TO finance_api;

CREATE INDEX ON commerce.checkout_refund(payment_provider_id);

CREATE FUNCTION commerce.record_topup_refund(p_id uuid,p_payment uuid,p_amount integer,p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o commerce.ai_topup_order;
BEGIN
 IF p_amount<=0 THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('topup-refund:'||p_payment::text,0));
 SELECT * INTO o FROM commerce.ai_topup_order WHERE provider_id=p_payment AND status='paid';
 IF NOT FOUND OR p_amount+(
  SELECT COALESCE(sum(amount_minor),0) FROM commerce.checkout_refund
  WHERE payment_provider_id=p_payment AND state='succeeded'
 )>o.price_minor THEN RETURN; END IF;
 INSERT INTO commerce.checkout_refund(id,payment_provider_id,amount_minor,state,created_at)
 VALUES(p_id,p_payment,p_amount,'succeeded',p_at) ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RETURN; END IF;
 INSERT INTO commerce.action(id,actor_id,payload) VALUES('refund:'||p_id::text,'',jsonb_build_object(
  'kind','billing_refund','target','Пакет Анализатора','changes',jsonb_build_array(
   jsonb_build_object('label','Возвращено, ₽','before',0,'after',p_amount::numeric/100),
   jsonb_build_object('label','Единиц в пакете','before',NULL,'after',o.units))))
 ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION commerce.record_topup_refund(uuid,uuid,integer,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.record_topup_refund(uuid,uuid,integer,timestamptz) TO finance_api;
