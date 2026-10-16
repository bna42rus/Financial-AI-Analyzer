#!/usr/bin/env bash
# Read-only model diagnostics. Argument: the reviewed commit containing this tool.
set -euo pipefail
sha=${1:?Pass the pinned diagnostics commit}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]]
repo=/home/finance-admin/cashneuro-staging-src
deps=/home/finance-admin/cashneuro-model-bench-d7bc07dc
test -d "$deps/apps/api/node_modules"
git -C "$repo" fetch --no-tags origin "$sha"
test "$(git -C "$repo" rev-parse FETCH_HEAD)" = "$sha"
build=$(mktemp -d /home/finance-admin/cashneuro-ai-diagnostics-XXXXXXXX)
git -C "$repo" archive "$sha" | tar -x -C "$build"
for part in . apps/api; do
  if test -d "$deps/$part/node_modules"; then
    ln -s "$deps/$part/node_modules" "$build/$part/node_modules"
  fi
done
cd "$build/apps/api"
/usr/bin/node --import tsx --test test/task-intent-cache-audit.test.ts
sudo /usr/bin/node --import tsx src/task-intent-diagnostics-main.ts --report "$build/ai-diagnostics-full.txt"
sudo chown "$(id -u):$(id -g)" "$build/ai-diagnostics-full.txt"
