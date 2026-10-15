#!/usr/bin/env bash
set -euo pipefail
repo=/home/finance-admin/cashneuro-staging-src
deps=/home/finance-admin/cashneuro-model-bench-d7bc07dc
build=/home/finance-admin/cashneuro-intent-trial-50cd3caf
sha=50cd3caf392ce29bbc746dfe6b98fdc5ca7780e4

test -d "$deps/apps/api/node_modules"
git -C "$repo" fetch --no-tags origin "$sha"
test "$(git -C "$repo" rev-parse FETCH_HEAD)" = "$sha"
mkdir -p -m 0700 "$build"
git -C "$repo" archive "$sha" | tar -x -C "$build"
for part in . apps/api apps/web apps/admin packages/imports packages/database; do
  if test -d "$deps/$part/node_modules" && ! test -e "$build/$part/node_modules"; then
    ln -s "$deps/$part/node_modules" "$build/$part/node_modules"
  fi
done
cd "$build/apps/api"
/usr/bin/node node_modules/typescript/bin/tsc --noEmit
/usr/bin/node --import tsx --input-type=module -e 'import {intentTrialBinding} from "./src/task-intent-trial.ts"; const a=await intentTrialBinding(); if(a.sha256!=="0167d21fd279fa1df5cac60df29fa86f6966a164f270dff5e636cf6cb0e1e4fa") throw Error("SOURCE_BINDING_MISMATCH"); console.log("SOURCE_VERIFIED");'
sudo /usr/bin/node --import tsx src/task-intent-trial-main.ts --live
