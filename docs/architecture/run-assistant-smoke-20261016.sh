#!/usr/bin/env bash
# Reviewed commit + explicit mode. Default performs NO model calls or HTTP.
set -euo pipefail
sha=${1:?Pass the reviewed commit}
action=${2:---prepare}
cap=${3:-}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]]
case "$action" in
  --prepare|--inspect|--report) test -z "$cap" ;;
  --live) test "$cap" = --approve-cap-rub=10 ;;
  *) exit 2 ;;
esac
repo=/home/finance-admin/cashneuro-staging-src
test "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" = 24
git -C "$repo" fetch --no-tags origin "$sha"
test "$(git -C "$repo" rev-parse FETCH_HEAD)" = "$sha"
# Root owns the reviewed source before the process can read the provider key.
# No user-owned dependency symlinks; Node 24 runs these TS modules directly.
build=$(sudo mktemp -d "/var/lib/cashneuro/assistant-code-${sha:0:8}-XXXXXXXX")
git -C "$repo" archive "$sha" | sudo tar --no-same-owner -x -C "$build"
sudo /usr/bin/node --experimental-transform-types --test \
  "$build/apps/api/test/assistant-workflow.test.ts" \
  "$build/apps/api/test/assistant-durability.test.ts" \
  "$build/apps/api/test/assistant-trial.test.ts" \
  "$build/apps/api/test/task-intent-cache-audit.test.ts"
if test -n "$cap"; then
  sudo /usr/bin/node --experimental-transform-types "$build/apps/api/src/assistant-trial-main.ts" "$action" "$cap"
else
  sudo /usr/bin/node --experimental-transform-types "$build/apps/api/src/assistant-trial-main.ts" "$action"
fi
