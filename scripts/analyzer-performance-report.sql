-- Technical totals only. Run with the existing authorized database role/RLS.
-- No prompts, operations, credentials or private identities are selected.
WITH runs AS (
 SELECT receipt->'result'->'timings' AS timing,
        jsonb_array_length(COALESCE(receipt->'calls','[]'::jsonb)) AS calls
 FROM finance.assistant_run WHERE receipt->'result'->'timings' IS NOT NULL
)
SELECT count(*) AS completed_samples,
       round(avg(calls),2) AS mean_model_calls,
       percentile_cont(.50) WITHIN GROUP (ORDER BY (timing->>'preparedMs')::numeric) AS prepared_p50_ms,
       percentile_cont(.95) WITHIN GROUP (ORDER BY (timing->>'preparedMs')::numeric) AS prepared_p95_ms,
       percentile_cont(.95) WITHIN GROUP (ORDER BY (timing->>'modelMs')::numeric) AS models_p95_ms,
       percentile_cont(.95) WITHIN GROUP (ORDER BY (timing->>'calculationMs')::numeric) AS calculation_p95_ms
FROM runs;
-- preparedMs stops before the durable commit; it is not end-to-end UI latency.
-- Missing or unknown model usage remains reserved in the existing cost ledger.
