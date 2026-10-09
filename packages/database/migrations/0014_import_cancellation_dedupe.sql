-- Cancellation deletes provenance; the FK cascade deletes its immutable source facts.
-- Runtime still has no direct UPDATE/DELETE grant on source_observation.
ALTER TABLE finance.ingestion_batch DROP CONSTRAINT ingestion_batch_status_check;
ALTER TABLE finance.ingestion_batch ADD CHECK(status IN ('accepted','processing','completed','partial','invalidated','cancelled'));
ALTER TABLE finance.ingestion_batch ADD cancelled_at timestamptz;
ALTER TABLE finance.ingestion_file ADD cancelled_at timestamptz;
ALTER TABLE finance.ingestion_file ALTER file_hmac DROP NOT NULL;
ALTER TABLE finance.ingestion_file ADD CHECK((cancelled_at IS NULL AND file_hmac IS NOT NULL) OR (cancelled_at IS NOT NULL AND file_hmac IS NULL));
ALTER TABLE finance.ingestion_row ADD source_evidence jsonb;
ALTER TABLE finance.ingestion_row ADD evidence_recorded boolean NOT NULL DEFAULT false;
ALTER TABLE finance.ingestion_row ADD strict_fingerprint text CHECK(strict_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE finance.ingestion_row ADD CHECK(source_evidence IS NULL OR (
 jsonb_typeof(source_evidence)='object' AND source_evidence ? 'event' AND source_evidence ? 'merchant'
 AND source_evidence-ARRAY['event','merchant']='{}'::jsonb
 AND source_evidence->>'event' IN ('purchase','refund','fee')
 AND (source_evidence->'merchant'='null'::jsonb OR source_evidence->>'merchant' IN ('ozon','wildberries','pyaterochka','magnit','perekrestok','lenta'))
 AND (source_evidence->>'event'<>'fee' OR source_evidence->'merchant'='null'::jsonb)));
ALTER TABLE finance.ingestion_row ADD CHECK(status='imported' OR (source_evidence IS NULL AND strict_fingerprint IS NULL AND NOT evidence_recorded));
CREATE INDEX ON finance.ingestion_row(user_id,alias_kind,alias_hmac,strict_fingerprint) WHERE strict_fingerprint IS NOT NULL;
ALTER TABLE finance.source_observation ADD import_row_id uuid;
CREATE INDEX ON finance.source_observation(user_id,import_row_id);
ALTER TABLE finance.source_observation ADD FOREIGN KEY(user_id,import_row_id) REFERENCES finance.ingestion_row(user_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
-- Operator migration only. Legacy evidence is explicitly unknown, never invented.
ALTER TABLE finance.source_observation NO FORCE ROW LEVEL SECURITY;
ALTER TABLE finance.ingestion_row NO FORCE ROW LEVEL SECURITY;
UPDATE finance.source_observation o SET import_row_id=r.id FROM finance.ingestion_row r WHERE (r.user_id,r.observation_id)=(o.user_id,o.id);
ALTER TABLE finance.source_observation FORCE ROW LEVEL SECURITY;
ALTER TABLE finance.ingestion_row FORCE ROW LEVEL SECURITY;
ALTER TABLE finance.duplicate_candidate ADD status text NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','different'));
ALTER TABLE finance.duplicate_candidate ADD revision bigint NOT NULL DEFAULT 0;
