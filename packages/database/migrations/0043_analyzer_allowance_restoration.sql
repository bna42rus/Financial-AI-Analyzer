CREATE TABLE commerce.ai_allowance_restoration (
 user_id text PRIMARY KEY REFERENCES identity.auth_user(id) ON DELETE CASCADE,
 window_start timestamptz NOT NULL,
 period_start timestamptz NOT NULL,
 restored_at timestamptz NOT NULL,
 previous_quota integer NOT NULL CHECK(previous_quota IN (150,10000)),
 CHECK(window_start<=period_start AND period_start<=restored_at)
);
ALTER TABLE commerce.ai_allowance_restoration ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_allowance_restoration ON commerce.ai_allowance_restoration TO finance_api
 USING(user_id=current_setting('app.user_id',true));
REVOKE ALL ON commerce.ai_allowance_restoration FROM PUBLIC;
GRANT SELECT ON commerce.ai_allowance_restoration TO finance_api;

-- A one-time support correction for a specifically selected verified account.
-- It changes customer allowance only. Cost records and project admission are separate.
CREATE FUNCTION commerce.restore_legacy_analyzer_allowance(p_email_hash text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
 owner_id text;
 paid commerce.access_paid_window%ROWTYPE;
 slot_start timestamptz;
 slot_end timestamptz;
 now_at timestamptz;
BEGIN
 IF p_email_hash IS NULL OR p_email_hash !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'INVALID_ACCOUNT_REFERENCE';
 END IF;
 SELECT id INTO owner_id FROM identity.auth_user
 WHERE email_verified AND encode(sha256(convert_to(email,'UTF8')),'hex')=p_email_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'VERIFIED_ACCOUNT_NOT_FOUND'; END IF;

 PERFORM pg_advisory_xact_lock(hashtextextended('access-cycle:'||owner_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('customer-ai-budget:'||owner_id,0));
 IF EXISTS(SELECT 1 FROM commerce.ai_allowance_restoration WHERE user_id=owner_id) THEN
  RETURN jsonb_build_object('status','ALREADY_RESTORED');
 END IF;

 now_at := clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM identity.security_state s JOIN commerce.access_cycle c USING(user_id)
  WHERE s.user_id=owner_id AND s.status='active' AND (c.indefinite OR c.access_end>now_at)) THEN
  RAISE EXCEPTION 'ACCOUNT_ACCESS_INACTIVE';
 END IF;
 SELECT * INTO paid FROM commerce.access_paid_window
 WHERE user_id=owner_id AND starts_at<=now_at AND ends_at>now_at
 ORDER BY starts_at DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_PAID_WINDOW_NOT_FOUND'; END IF;
 IF paid.quota NOT IN (150,10000) THEN RAISE EXCEPTION 'UNEXPECTED_ALLOWANCE'; END IF;

 SELECT starts_at,ends_at INTO slot_start,slot_end
 FROM commerce.billing_period(paid.starts_at,paid.ends_at,paid.kind,now_at);
 INSERT INTO commerce.ai_allowance_restoration VALUES(owner_id,paid.starts_at,slot_start,now_at,paid.quota);
 RETURN jsonb_build_object('status','RESTORED','previousLimit',paid.quota,'limit',10000,'remaining',10000,'resetAt',slot_end);
END $$;
REVOKE ALL ON FUNCTION commerce.restore_legacy_analyzer_allowance(text) FROM PUBLIC;
