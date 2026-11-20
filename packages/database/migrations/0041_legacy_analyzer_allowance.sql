-- The development tariff predates cost units. Match the original purchase or
-- renewal and its exact paid window, never reinterpret a custom 150-unit plan.
UPDATE commerce.access_paid_window w SET quota=10000
WHERE w.kind='calendar_months' AND w.quota=150 AND (
 EXISTS (
   SELECT 1 FROM commerce.purchase p
   WHERE p.user_id=w.user_id AND p.activated_at=w.starts_at AND p.access_end=w.ends_at
   AND p.data->'tariff'->>'id'='development-month' AND p.data->'tariff'->>'aiQuota'='150'
 ) OR EXISTS (
   SELECT 1 FROM commerce.access_extension e JOIN commerce.renewal_request r
     ON r.id=e.request_id AND r.user_id=e.user_id
   WHERE e.user_id=w.user_id AND (e.data->>'accessEnd')::timestamptz=w.ends_at
   AND (CASE WHEN e.data->>'mode'='continuous' THEN e.data->>'previousEnd' ELSE e.data->>'anchorAt' END)::timestamptz=w.starts_at
   AND r.data->'tariff'->>'id'='development-month' AND r.data->'tariff'->>'aiQuota'='150'
 )
);
UPDATE access.tariff SET snapshot=jsonb_set(snapshot,'{aiQuota}','10000'::jsonb)
WHERE id='development-month' AND snapshot->'duration'->>'kind'='calendar_months'
  AND snapshot->>'aiQuota'='150';
