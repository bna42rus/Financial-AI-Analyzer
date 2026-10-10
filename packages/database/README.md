# PostgreSQL 18 / Drizzle

`migrations/0001_access_security.sql` installs separate identity/control auth realms, application ownership, hashed verification/reset/recovery verifiers, session proofs, encrypted outboxes, security events and durable limits. Drizzle auth schema includes the exact fields required by pinned Better Auth/TOTP.

Run the migration transactionally via the Development operator command, never via an API account. Runtime `finance_api`/`control_api` are NOLOGIN by default; operator assigns independent LOGIN credentials outside Git. Startup rejects owner/superuser/BYPASSRLS credentials. The control role cannot query user password hashes, finance, protected keys or application email payloads.

Financial RLS in this migration is an **isolation canary**, not implemented financial storage. Tests exercise explicit FORCE RLS, denied cross-tenant writes and transaction-local context reset; every future financial table needs its own user-scoped keys/policy and API ownership checks. Protected-key canary grants no runtime access.

Migration is forward-only initial installation. Application has no Production runner. Before a release: review artifacts, rehearse migration/restore, define rollback/forward-fix, configure KMS and actual worker grants, validate every future table/role and obtain owner Staging acceptance.


`0002_invitation_registration.sql` adds manual purchase/invitation/registration proof. `0003_access_renewal.sql` adds canonical paid cycle, separate renewal requests/extension ledger and scoped FORCE RLS with transaction-local owner context. It backfills active purchases without granting control any identity privileges. Both forward migrations run only through the Development operator; [renewal behavior](../../docs/architecture/access-renewal.md).

`0016_review_sessions.sql` adds tenant-scoped fixed-ID Review progress and idempotent progress receipts after 0001–0015. Apply once through `operator migrate-review-sessions` with the Development migration-owner connection. FORCE RLS denies cross-user/runtime control/mail access. Operation deletion removes its progress references/receipts; workspace generation change clears sessions. This migration is additive: an application rollback can leave the tables/triggers installed and disable the Review UI; avoid destructive down migration. Rehearse migration and forward-fix on Staging before release. [Behavior and evidence](../../docs/architecture/review-bulk-actions.md).

`0018_local_bank_classification.sql` follows 0017 and extends the closed source-evidence event registry. Apply with `operator migrate-local-bank-classification`. After new imports, retain compatible readers/workers or use forward-fix; no destructive down migration. See [local tables and OCR](../../docs/architecture/local-tabular-ocr.md).
