CREATE TABLE commerce.access_checkout (
 id uuid PRIMARY KEY,
 user_id text REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 application_id text REFERENCES access.request(id) ON DELETE CASCADE,
 tariff jsonb NOT NULL, offer_version text NOT NULL, renewal_version text,
 mode text NOT NULL CHECK(mode IN ('once','enroll','automatic')),
 cycle_revision integer, planned_end timestamptz,
 provider_id uuid UNIQUE, redirect_url text, payment_method_id text,
 state text NOT NULL DEFAULT 'created' CHECK(state IN ('created','pending','paid','cancelled','reconcile')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), paid_at timestamptz,
 CHECK((user_id IS NULL)<>(application_id IS NULL)),
 CHECK(application_id IS NULL OR mode='once')
);
CREATE UNIQUE INDEX checkout_one_pending_account ON commerce.access_checkout(user_id) WHERE state IN ('created','pending','reconcile');
CREATE UNIQUE INDEX checkout_one_pending_application ON commerce.access_checkout(application_id) WHERE state IN ('created','pending','reconcile');
CREATE TABLE commerce.autorenewal (
 user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 checkout_id uuid NOT NULL REFERENCES commerce.access_checkout(id),
 tariff jsonb NOT NULL, offer_version text NOT NULL, renewal_version text NOT NULL,
 method_id text, state text NOT NULL CHECK(state IN ('active','off','changed','failed')),
 next_at timestamptz NOT NULL, notice_id uuid, accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state <> 'active' OR method_id IS NOT NULL)
);
CREATE TABLE commerce.autorenewal_event (
 user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL CHECK(action IN ('enable','disable','changed','failed')),
 checkout_id uuid, tariff jsonb, offer_version text, renewal_version text,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE commerce.access_paid_window (
 user_id text NOT NULL REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 kind text NOT NULL CHECK(kind IN ('days','calendar_months')), quota integer NOT NULL CHECK(quota>=0),
 PRIMARY KEY(user_id,starts_at),CHECK(ends_at>starts_at)
);

ALTER TABLE commerce.access_checkout ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.autorenewal ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.autorenewal_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.access_paid_window ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_checkout ON commerce.access_checkout TO finance_api
 USING (user_id=current_setting('app.user_id',true) OR application_id=current_setting('app.checkout_application',true))
 WITH CHECK (user_id=current_setting('app.user_id',true) OR application_id=current_setting('app.checkout_application',true));
CREATE POLICY own_autorenewal ON commerce.autorenewal TO finance_api
 USING (user_id=current_setting('app.user_id',true)) WITH CHECK (user_id=current_setting('app.user_id',true));
CREATE POLICY own_autorenewal_event ON commerce.autorenewal_event TO finance_api
 USING (user_id=current_setting('app.user_id',true)) WITH CHECK (user_id=current_setting('app.user_id',true));
CREATE POLICY own_paid_window ON commerce.access_paid_window TO finance_api
 USING (user_id=current_setting('app.user_id',true)) WITH CHECK (user_id=current_setting('app.user_id',true));
GRANT SELECT,INSERT,UPDATE ON commerce.access_checkout,commerce.autorenewal TO finance_api;
GRANT SELECT,INSERT ON commerce.autorenewal_event TO finance_api;
GRANT SELECT,INSERT ON commerce.access_paid_window TO finance_api;
GRANT SELECT,INSERT ON commerce.access_paid_window TO control_api;
CREATE POLICY control_paid_window ON commerce.access_paid_window TO control_api USING(true) WITH CHECK(true);
INSERT INTO commerce.access_paid_window(user_id,starts_at,ends_at,kind,quota)
 SELECT p.user_id,p.activated_at,p.access_end,p.data->'duration'->>'kind',(p.data->'tariff'->>'aiQuota')::int
 FROM commerce.purchase p WHERE p.state='active' AND p.data->'duration'->>'kind' IN ('days','calendar_months')
 AND (p.data->'tariff'->>'aiQuota')::int>=0 AND p.access_end>p.activated_at
 ON CONFLICT DO NOTHING;
GRANT UPDATE (anchor_at,access_end,calendar_months,extra_days,revision,end_offset_ms) ON commerce.access_cycle TO finance_api;
REVOKE ALL ON commerce.access_checkout,commerce.autorenewal,commerce.autorenewal_event,commerce.access_paid_window FROM PUBLIC;

CREATE FUNCTION commerce.billing_due() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT user_id FROM (
  SELECT user_id,MIN(created_at) AS priority FROM commerce.access_checkout
   WHERE user_id IS NOT NULL AND state IN ('created','pending') GROUP BY user_id
  UNION ALL
  SELECT user_id,next_at FROM commerce.autorenewal WHERE state='active' AND next_at<=clock_timestamp()+interval '5 days'
 ) candidates GROUP BY user_id ORDER BY MIN(priority) LIMIT 30
$$;
CREATE FUNCTION commerce.billing_first_due() RETURNS TABLE(id uuid,application_id text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id,o.application_id FROM commerce.access_checkout o
 WHERE o.application_id IS NOT NULL AND o.state='pending' AND o.provider_id IS NOT NULL
 ORDER BY o.created_at LIMIT 25
$$;
CREATE FUNCTION commerce.billing_notice_sent(p_notice uuid) RETURNS timestamptz LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.sent_at FROM identity.outbox o JOIN commerce.autorenewal a ON a.notice_id=o.id
 WHERE o.id=p_notice AND o.kind='billing_notice' AND o.state='sent' AND a.user_id=current_setting('app.user_id',true)
$$;
CREATE FUNCTION commerce.finish_first_checkout(p_id uuid,p_invitation_id text,p_verifier text,p_sealed_token text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE o commerce.access_checkout; r access.request; v_purchase text; expires timestamptz; snapshot jsonb; invitation_snapshot jsonb;
 BEGIN
 SELECT * INTO o FROM commerce.access_checkout WHERE id=p_id AND application_id=current_setting('app.checkout_application',true) AND state='paid';
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO r FROM access.request WHERE id=o.application_id FOR UPDATE;
 IF NOT FOUND OR r.data->>'verifiedAt' IS NULL OR r.data->>'status'<>'awaiting_payment'
   OR r.data->'tariff'->>'id'<>o.tariff->>'id' OR r.data->'tariff'->>'priceMinor'<>o.tariff->>'priceMinor'
   OR EXISTS(SELECT 1 FROM commerce.purchase p WHERE p.request_id=r.id) THEN RETURN false; END IF;
 v_purchase:='purchase:'||o.id; expires:=clock_timestamp()+interval '72 hours';
 snapshot:=jsonb_build_object('id',v_purchase,'requestId',r.id,'tariff',r.data->'tariff','duration',o.tariff->'duration',
    'actualMinor',o.tariff->>'priceMinor','paidAt',to_char(o.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state','paid_not_activated');
 invitation_snapshot:=jsonb_build_object('id',p_invitation_id,'purchaseId',v_purchase,'requestId',r.id,'email',r.email,
    'createdAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state','active','delivery','not_connected');
 INSERT INTO commerce.purchase(id,request_id,data) VALUES(v_purchase,r.id,snapshot);
 INSERT INTO commerce.invitation(id,purchase_id,email,verifier,sealed_token,expires_at,state,created_at)
 VALUES(p_invitation_id,v_purchase,r.email,p_verifier,p_sealed_token,expires,'active',clock_timestamp());
 r.data:=r.data||jsonb_build_object('status','paid_not_activated','revision',(r.data->>'revision')::int+1);
 UPDATE access.request SET data=r.data WHERE id=r.id;
 INSERT INTO commerce.review_state(request_id,data) VALUES(r.id,jsonb_build_object('requests',jsonb_build_array(r.data),
  'purchases',jsonb_build_array(snapshot),'invitations',jsonb_build_array(invitation_snapshot),'payments','[]'::jsonb,'audit','[]'::jsonb,'replay','{}'::jsonb))
 ON CONFLICT(request_id) DO UPDATE SET data=excluded.data;
 RETURN true;
 END $$;
REVOKE ALL ON FUNCTION commerce.billing_due(),commerce.billing_first_due(),commerce.billing_notice_sent(uuid),commerce.finish_first_checkout(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.billing_due(),commerce.billing_first_due(),commerce.billing_notice_sent(uuid),commerce.finish_first_checkout(uuid,text,text,text) TO finance_api;

-- A paid interval is split into monthly slots from its own anchor. Day plans use
-- the complete paid interval as a single slot. Calendar clamping never changes the anchor.
CREATE FUNCTION commerce.billing_period(p_start timestamptz,p_end timestamptz,p_kind text,p_at timestamptz)
 RETURNS TABLE(starts_at timestamptz,ends_at timestamptz) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH local_dates AS (SELECT p_start AT TIME ZONE 'Europe/Moscow' AS s,p_at AT TIME ZONE 'Europe/Moscow' AS a),
 index_month AS (SELECT s,a,(extract(year FROM a)::int-extract(year FROM s)::int)*12+
   extract(month FROM a)::int-extract(month FROM s)::int AS n FROM local_dates),
 slot AS (SELECT s,n-CASE WHEN s+make_interval(months=>n)>a THEN 1 ELSE 0 END AS k FROM index_month)
 SELECT CASE WHEN p_kind='days' THEN p_start ELSE (s+make_interval(months=>k)) AT TIME ZONE 'Europe/Moscow' END,
 CASE WHEN p_kind='days' THEN p_end ELSE least(p_end,(s+make_interval(months=>k+1)) AT TIME ZONE 'Europe/Moscow') END FROM slot
$$;
REVOKE ALL ON FUNCTION commerce.billing_period(timestamptz,timestamptz,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.billing_period(timestamptz,timestamptz,text,timestamptz) TO finance_api;
