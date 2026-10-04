# Environment preparation

Development and preliminary Staging have different project names, networks, DBs, users, passwords, volumes and localhost-only ports. Supply separately generated secrets through a local .env that is excluded from Git. These templates only prepare DB containers; they do not implement the app, runtime roles, schema, HMAC/KMS or full Staging.

Postgres bootstrap owner is only for initial DB/migration setup; future APIs/workers must use separate least-privilege roles. No Production data may be seeded here. Image tags are preliminary Development tags; Production release requires pinned tested digests.

Docker is not installed in the current workspace, so these configurations have not been started. Production configuration, cloud resources and paid provider accounts have not been created.
