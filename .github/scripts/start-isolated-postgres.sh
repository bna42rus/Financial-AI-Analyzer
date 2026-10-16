#!/usr/bin/env bash
# Disposable GitHub Actions database only; no Docker registry or hosted service.
set -euo pipefail
: "${RUNNER_TEMP:?GitHub runner temporary directory required}"
npm install --prefix "$RUNNER_TEMP/assistant-postgres" --no-save --ignore-scripts embedded-postgres@18.4.0-beta.17
cd "$RUNNER_TEMP/assistant-postgres/node_modules/@embedded-postgres/linux-x64"
node scripts/hydrate-symlinks.js
pg_bin="$PWD/native/bin"
"$pg_bin/postgres" --version
"$pg_bin/initdb" -D "$RUNNER_TEMP/assistant-pgdata" -U postgres --auth=trust
"$pg_bin/pg_ctl" -D "$RUNNER_TEMP/assistant-pgdata" -l "$RUNNER_TEMP/assistant-postgres.log" -o "-h 127.0.0.1 -p 55432 -k $RUNNER_TEMP" -w start
