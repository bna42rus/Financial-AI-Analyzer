-- Extend the closed code registry; raw text and recipients remain forbidden.
ALTER TABLE finance.ingestion_row DROP CONSTRAINT finite_source_evidence;
ALTER TABLE finance.ingestion_row ADD CONSTRAINT finite_source_evidence CHECK(source_evidence IS NULL OR (
 jsonb_typeof(source_evidence)='object' AND source_evidence ? 'event' AND source_evidence ? 'merchant'
 AND source_evidence-ARRAY['event','merchant']='{}'::jsonb
 AND jsonb_typeof(source_evidence->'event')='string'
 AND source_evidence->>'event' IN ('purchase','refund','fee','cash_withdrawal','cash_deposit','cashback','transfer_in','transfer_out')
 AND (source_evidence->'merchant'='null'::jsonb OR source_evidence->>'merchant' IN ('ozon','wildberries','pyaterochka','magnit','perekrestok','lenta','vkusvill','auchan','metro','dixy','fixprice','samokat','lamoda','dns','mvideo','sportmaster','hoff','leroymerlin','yandexmarket','yandextaxi'))
 AND (source_evidence->>'event' IN ('purchase','refund') OR source_evidence->'merchant'='null'::jsonb)));
