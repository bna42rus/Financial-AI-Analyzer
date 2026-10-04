# Private remote setup

Candidate: https://gitverse.ru — Free. Owner signs in and creates a private repository named personal-finance-analyzer, without adding an unrelated README/history. Remote creation requires the owner's account/authorized connection; this package has no remote credentials.

Set main protection: disallow direct/force pushes and deletion; merge only with successful named checks and owner-controlled permissions. Verify protection can be enforced on the current Free account. Do not grant ordinary CI a Production deployment credential.

Bootstrap checks: source integrity and money tests. Full build/type/lint/integration/e2e/security checks will be added before automated app Staging. A bootstrap-only green check is not release acceptance.

The official pricing and docs disagree on CI/artifact quotas. Until account settings confirm the actual limits, plan for 500 private CI minutes and 500 MB artifacts. Do not auto-buy more quota or omit checks.
