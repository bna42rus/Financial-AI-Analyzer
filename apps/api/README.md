# API — Development foundation

NestJS/Fastify + Better Auth 1.7.7 + Drizzle/PostgreSQL 18. Two processes use independent database credentials, auth secrets, wrapping keys, origins and cookie prefixes. Public registration and alternate authentication endpoints are closed. This block is an API foundation; the review UI of PR #7 still runs its explicit independent example.

See [behavior, evidence and remaining work](../../docs/architecture/server-access-security.md).

## Prepared import acceptance

After migrations 0001–0011, apply `operator migrate-import-ingestion` once with the Development migration-owner connection, then `operator migrate-bank-contract-alias` for 0013 and `operator migrate-import-cancellation-dedupe` for 0014 and `operator migrate-duplicate-merge` for 0015. Start the API and a separate `pnpm --filter @finance/api dev:imports` worker with `APP_ENV=development`, `API_PROFILE=finance`, and scoped `finance_api` credentials. Worker startup rejects owner/superuser/BYPASSRLS. No external service is required. [Contract and counters](../../docs/architecture/import-ingestion.md); [local PDF adapters and limits](../../docs/architecture/local-bank-parsers.md). The [authenticated import UI](../../docs/architecture/live-import-ui.md) now connects local preparation, acceptance and durable metadata history. Rich source text, other formats, full review/editing remain incomplete. Accepted batch/file cancellation and finite-profile strict dedupe are described in [the next block](../../docs/architecture/import-cancellation-dedupe.md).

## Run locally

Node 24 LTS, pnpm 11.25.0 and a dedicated PostgreSQL 18 Development cluster. Use the operator connection only for migration: set `APP_ENV=development`, `MIGRATION_DATABASE_URL` in a local untracked environment, then `pnpm --filter @finance/api operator migrate`. The migration creates NOLOGIN `finance_api`/`control_api`; the database operator assigns distinct random passwords and LOGIN out of band. Never use the migration owner as an API credential.

Copy `.env.example` to a local ignored file and populate it with independently generated secrets. Run separate shells/profiles with `pnpm dev:api`: `API_PROFILE=finance`/port 3000 and `API_PROFILE=control`/port 3001. Environment files are not loaded implicitly: load your own local file before launching. The server listens on loopback. HTTP Development cookies are explicitly non-Secure; HTTPS uses Secure cookies. Only the exact configured frontend Origin can send JSON writes. Logging of auth bodies/errors is disabled.

The optional `operator seed-admin-example` command creates **only** `owner@example.test` on local Development and reads a self-chosen password from a muted interactive terminal. It is not real owner onboarding/email verification; real provisioning will use a verified-email bootstrap procedure. No HTTP admin-creation endpoint exists. After password login the example account has enrollment authority only, then it must verify its authenticator and save the one-time displayed recovery-code set separately from the phone.

No real tariff is seeded. Synthetic tariff fixtures exist only in tests. No paid service or cloud deployment is needed for these checks.

## Checks

- `pnpm check`: original sources, existing model/projection/interface checks, strict API types and two cryptography checks.
- `pnpm test:security`: integration scenarios, requires `SECURITY_TEST_DATABASE_URL` for a **fresh dedicated** PostgreSQL 18 cluster on loopback. Creates/disposes a random test database and scoped roles. Refuses a cluster with existing runtime roles; do not point it at Development/Staging/Production with data.
- GitHub CI supplies official `postgres:18.4`. Real connections, GRANT/RLS and concurrent requests are tested; no in-memory SQL substitute.

Production startup is blocked: the Development environment KEK adapter is not an audited KMS provider. Email delivery, real owner onboarding, complete security screens, retention/cleanup, observability and release acceptance remain required.


## Invitations / registration extension

Apply forward migration `0002_invitation_registration.sql` using `operator migrate-invitations` once after `migrate`. `operator seed-tariff-example` adds only a synthetic tariff. Optional frontend API origins and the full HTTP/PostgreSQL browser fixture are described in [invitation-registration.md](../../docs/architecture/invitation-registration.md). Run `pnpm test:access-browser` against an isolated local PostgreSQL 18 cluster after installing Chromium. Mail remains encrypted queued; real delivery/owner onboarding and Production are not enabled.


Apply `operator migrate-renewal` once after the first two migrations. [Renewal API, calendar rules, grants and limits](../../docs/architecture/access-renewal.md). Paid cycle is canonical in commerce, identity suspension stays separate. Two full HTTP/browser journeys now include renewal. No permanent/cloud server or email delivery was connected.

[Duplicate merge, source aliases, dependency preview and checked Undo](../../docs/architecture/duplicate-merge.md) require migration 0015.
