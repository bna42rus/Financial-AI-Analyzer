-- Additive, tenant-scoped description identity. Only a device-generated keyed digest
-- is persisted; the normalized source description and identifiers never cross the wire.
ALTER TABLE finance.ingestion_row ADD description_hmac text CHECK(description_hmac ~ '^[0-9a-f]{64}$');
ALTER TABLE finance.ingestion_row ADD CONSTRAINT imported_description_identity CHECK(status='imported' OR description_hmac IS NULL);
DO $$
DECLARE constraint_name text;
BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='finance.ingestion_row'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%source_evidence%' AND pg_get_constraintdef(oid) LIKE '%merchant%';
 EXECUTE format('ALTER TABLE finance.ingestion_row DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE finance.ingestion_row ADD CONSTRAINT finite_source_evidence CHECK(source_evidence IS NULL OR (
 jsonb_typeof(source_evidence)='object' AND source_evidence ? 'event' AND source_evidence ? 'merchant'
 AND source_evidence-ARRAY['event','merchant']='{}'::jsonb
 AND jsonb_typeof(source_evidence->'event')='string'
 AND source_evidence->>'event' IN ('purchase','refund','fee')
 AND (source_evidence->'merchant'='null'::jsonb OR source_evidence->>'merchant' IN ('ozon','wildberries','pyaterochka','magnit','perekrestok','lenta','vkusvill','auchan','metro','dixy','fixprice','samokat','lamoda','dns','mvideo','sportmaster','hoff','leroymerlin','yandexmarket','yandextaxi'))
 AND (source_evidence->>'event'<>'fee' OR source_evidence->'merchant'='null'::jsonb)));
