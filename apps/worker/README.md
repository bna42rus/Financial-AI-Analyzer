Development mail workers are implemented in `apps/api/src/mail-main.ts` / `mail-worker.ts` to reuse the encrypted access outbox without granting finance access. Separate `mail_finance`/`mail_control` roles and queue schemas; pg-boss 12.37.0, leased attempts, retry/backoff, current-token checks, and idempotent encrypted synthetic inbox. No external messages are sent. [Runbook and limits](../../docs/architecture/mail-notifications.md).

Development import execution is implemented in `apps/api/src/import-main.ts` /
`import-ingestion.ts`: bounded checkpoints, one active batch, access/generation/key
checks, retries, provenance and cancellation. It uses the scoped `finance_api`
role and currently requires the Development profile. See
[import ingestion](../../docs/architecture/import-ingestion.md) and
[local formats and OCR](../../docs/architecture/local-tabular-ocr.md).

AI workers and a deployable Staging/Production worker profile remain unimplemented.
