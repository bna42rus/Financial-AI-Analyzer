Development mail workers are implemented in `apps/api/src/mail-main.ts` / `mail-worker.ts` to reuse the encrypted access outbox without granting finance access. Separate `mail_finance`/`mail_control` roles and queue schemas; pg-boss 12.37.0, leased attempts, retry/backoff, current-token checks, and idempotent encrypted synthetic inbox. No external messages are sent. [Runbook and limits](../../docs/architecture/mail-notifications.md).

Financial/import/AI workers are not implemented yet.
