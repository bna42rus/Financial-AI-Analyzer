# Первый доступ через API: оплата, приглашение, регистрация

Development continuation of PR №8. Sources: PDF 38.2–38.8, 39.7/39.10, 40.10/40.16, 41.11 and approved B-06/B-10. PDF/Word/baseline remain unchanged. No hosting, purchases, real transfers, real emails or Production release.

## Result

With `VITE_API_ORIGIN` configured, web/admin use their separate APIs and HttpOnly sessions. Without it the previously accepted opt-in interface examples remain available. Public tariffs come from the database, not browser prices. A visitor creates an application, verifies the email link, claims a synthetic transfer, and waits for review. The control UI requires password plus verified TOTP; limited enrollment/recovery sessions cannot review applications. TOTP setup uses a manual authenticator key; local QR rendering remains future work. Eight recovery codes are shown only once after verified enrollment.

Control review has a read-only server preview and an explicit commit. Actor/time/price/state come from the server. Every commit rechecks revision/status and globally unique action ID. Same actor/payload retries are no-ops; altered retries conflict. Mismatch requires an explicit full-period/top-up/reject/custom-days decision and reason. Top-up claims retain the first claim timestamp and record a latest claim timestamp, expose the remaining amount, and retain each actual transfer separately. Internal reasons stay in control history and are excluded from public application/payment-decision mail projections. Actual payment records remain separate from purchase/invitation records. No proportional duration, wallet, automatic refund or second grant is inferred.

All purchase/invitation/application/audit/outbox changes commit together. Confirmed payment creates a `paid_not_activated` purchase, without dates or account. Link lifetime is independently configurable from 1 to 720 hours, default 72. Cancel/reissue retains the purchase and old invitation records. Used links cannot be reissued. A privileged copy-link endpoint decrypts only a currently active link and records a security event; queue responses expose no verifier, encrypted secret or plaintext link.

Invitation tokens use 256-bit randomness and SHA-256 verifiers. Plaintext for privileged copy is stored only in an encrypted envelope. To register, an active invite first requests a separately random, hashed, 15-minute proof to its expected email. That proof is never returned through the public endpoint. A copied invite cannot change the address or substitute itself for the independent proof. Proofs are bound to the exact invitation; cancel/reissue/expiry invalidates the old flow. New proof requests do not revoke older valid proofs, preventing a copied link from blocking its owner. Durable per-invite limits survive IP/session changes.

Registration locks purchase then invitation, validates both and the proof, creates a verified native credential account with Argon2id password, consumes the link/all its proofs, terminates application sessions and starts entitlement in one transaction. Existing accounts are rejected into ordinary login rather than overwritten. Registration does not create a login session; the user signs in with their chosen password.

The first Development cycle snapshots `Europe/Moscow`. Calendar months use PostgreSQL local-calendar addition, preserving wall time and clamping month-end; the original activation timestamp/timezone/duration remain available as the future cycle anchor. Day periods use exact 24-hour units. Profile timezone selection, DST-zone policy, quota enforcement, manual fixed-end/indefinite/free grants and payment corrections/refunds are later blocks and are not claimed complete.

Control receives no identity credentials, financial tables or protected-key access. Finance receives only named invitation metadata/verifier columns and activation updates, never encrypted copy-link secrets or control review/audit state. Both runtimes remain non-owners without BYPASSRLS. Authority deadlines use database wall-clock time after lock acquisition, not the earlier transaction-start timestamp. An integration fixture expires a proof while registration waits for the mutation lock and checks that no identity/entitlement is created. Cross-profile operations use the same purchase-before-invitation lock order; mutation transactions retain the temporary profile-wide lock from PR №8.

## Endpoints

| Profile | Endpoint | Purpose |
| --- | --- | --- |
| finance | GET `/access/tariffs` | Available database tariffs |
| finance | POST `/access/registration-proof` | Independently queue proof to invitation email |
| finance | POST `/access/register` | Consume invite/proof and activate exactly once |
| control | GET `/control/requests` | Queue plus payment/purchase/invitation/audit projections |
| control | POST `/control/review-preview` | Validate and show consequences without writes |
| control | POST `/control/review` | Transactional review with action ID/revision |
| control | POST `/control/invitation-action` | Reasoned cancellation/reissue |
| control | POST `/control/invitation-link` | Privileged active-link copy with security event |

The existing PR №8 auth, recovery/reset, application and own-session endpoints remain. Client-supplied actor/email/price authority is rejected. API bodies are strict JSON; failures contain safe codes, not database errors or input secrets. Links use URL fragments, which are removed from the address before rendering/requests. Secrets remain in memory, not localStorage. Verification requires an explicit click, avoiding effect retries/automatic link consumption.

## Development launch and test boundary

Apply `0001_access_security.sql` once, then `0002_invitation_registration.sql` once using the operator owner. On an already migrated PR №8 database run `pnpm --filter @finance/api operator migrate-invitations`; on a fresh database first use `migrate`. Both commands require local `MIGRATION_DATABASE_URL` and `APP_ENV=development`. `seed-tariff-example` inserts only the unapproved synthetic 1,190 ₽ monthly tariff. It is not a selling offer. Existing `seed-admin-example` is a synthetic-only bootstrap, not real owner onboarding.

Use independent control/finance runtime settings from API `.env.example`; these settings must be provided to processes explicitly. Vite frontend `.env.example` files show optional origins; frontend variables contain no secrets. Default loopback ports: user UI 5173/API 3000, control UI 5174/API 3001. No external server is provisioned.

Email remains encrypted `queued` outbox only. No delivery adapter or public inbox endpoint is installed. Intended future mail link formats: `/#verify?token=…`, `/#invite?token=…`, `/#reset?token=…`. The temporary registration UI accepts the independent proof from its separate email; actual delivery and a complete mail-link UX must be finished before real users. Development uses synthetic identities only; no real payments should be made.

Real PostgreSQL 18 integration tests cover retry/conflict, ownership/proof scope, concurrent activation, cancel/reissue/expiry, mismatch/top-up, credentials/role isolation, month-end/leap-year calculation and transactional rollback when outbox insertion fails. The separate full-browser fixture launches both real HTTP APIs plus Vite against disposable PostgreSQL, decrypts only synthetic outbox messages using the test operator, and follows the UI through application, TOTP, preview, commit, independent email proof, registration and fresh login on desktop/mobile Chromium. No browser API mocks or public verification bypass are used. GitHub CI runs these fixtures because the local execution environment cannot launch an unprivileged PostgreSQL daemon. Mobile Chromium is not real Safari/iPhone acceptance.

Reference implementations: [PostgreSQL calendar intervals](https://www.postgresql.org/docs/18/functions-datetime.html), [PostgreSQL privileges](https://www.postgresql.org/docs/18/ddl-priv.html), [Better Auth signup/session options](https://better-auth.com/docs/reference/options). Deployment/KMS, real owner email bootstrap, delivery worker/retention/resend observability, dangerous-action fresh reauthentication, actual finance persistence and full release acceptance remain open. Registry statuses remain partial.


The next Development block implements [renewal/canonical paid cycle](access-renewal.md), preserving the original registration anchor and identity suspension. Real delivery/manual grants/refunds/AI quota remain open.
