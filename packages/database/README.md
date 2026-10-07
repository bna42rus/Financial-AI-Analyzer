# PostgreSQL 18 / Drizzle

`migrations/0001_access_security.sql` installs separate identity/control auth realms, application ownership, hashed verification/reset/recovery verifiers, session proofs, encrypted outboxes, security events and durable limits. Drizzle auth schema includes the exact fields required by pinned Better Auth/TOTP.

Run the migration transactionally via the Development operator command, never via an API account. Runtime `finance_api`/`control_api` are NOLOGIN by default; operator assigns independent LOGIN credentials outside Git. Startup rejects owner/superuser/BYPASSRLS credentials. The control role cannot query user password hashes, finance, protected keys or application email payloads.

Financial RLS in this migration is an **isolation canary**, not implemented financial storage. Tests exercise explicit FORCE RLS, denied cross-tenant writes and transaction-local context reset; every future financial table needs its own user-scoped keys/policy and API ownership checks. Protected-key canary grants no runtime access.

Migration is forward-only initial installation. Application has no Production runner. Before a release: review artifacts, rehearse migration/restore, define rollback/forward-fix, configure KMS and actual worker grants, validate every future table/role and obtain owner Staging acceptance.
