-- Add the closed /5 text-evidence marker. Old finite and /4 rows remain valid.
-- No source facts, identifiers, amounts or user decisions are rewritten.
ALTER TABLE finance.ingestion_row DROP CONSTRAINT finite_source_evidence;
ALTER TABLE finance.ingestion_row ADD CONSTRAINT finite_source_evidence CHECK(source_evidence IS NULL OR (
 jsonb_typeof(source_evidence)='object' AND source_evidence ?& ARRAY['event','merchant']
 AND source_evidence-ARRAY['event','merchant','details']='{}'::jsonb
 AND source_evidence->>'event' IN ('purchase','refund','fee','cash_withdrawal','cash_deposit','cashback','transfer_in','transfer_out','other')
 AND (source_evidence->'merchant'='null'::jsonb OR source_evidence->>'merchant' IN ('ozon','wildberries','pyaterochka','magnit','perekrestok','lenta','vkusvill','auchan','metro','dixy','fixprice','samokat','lamoda','dns','mvideo','sportmaster','hoff','leroymerlin','yandexmarket','yandextaxi'))
 AND (source_evidence->>'event' IN ('purchase','refund') OR source_evidence->'merchant'='null'::jsonb)
 AND (source_evidence->>'event'<>'other' OR source_evidence ? 'details')
 AND (NOT(source_evidence ? 'details') OR (
  jsonb_typeof(source_evidence->'details')='object'
  AND (source_evidence->'details') ?& ARRAY['description','merchantText','bankCategory','mcc']
  AND (source_evidence->'details')-ARRAY['description','merchantText','bankCategory','mcc','textEvidence']='{}'::jsonb
  AND (NOT ((source_evidence->'details') ? 'textEvidence') OR (jsonb_typeof(source_evidence#>'{details,textEvidence}')='string' AND source_evidence#>>'{details,textEvidence}' IN ('intact','unknown')))
  AND jsonb_typeof(source_evidence#>'{details,description}')='string' AND length(source_evidence#>>'{details,description}')<=1000
  AND jsonb_typeof(source_evidence#>'{details,merchantText}')='string' AND length(source_evidence#>>'{details,merchantText}')<=160
  AND jsonb_typeof(source_evidence#>'{details,bankCategory}')='string' AND length(source_evidence#>>'{details,bankCategory}')<=160
  AND (source_evidence#>'{details,mcc}'='null'::jsonb OR (jsonb_typeof(source_evidence#>'{details,mcc}')='string' AND source_evidence#>>'{details,mcc}' ~ '^[0-9]{4}$' AND source_evidence#>>'{details,mcc}'<>'0000'))
 ))
));
