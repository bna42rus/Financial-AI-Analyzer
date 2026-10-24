#!/usr/bin/env bash
# Standalone synthetic continuation. No API/UI/worker/config switch.
set -euo pipefail
repo=${1:?checkout required}
sha=${2:?commit required}
extra=()
if (($#>2)); then
 test "$#" = 4
 test "$3" = --resume-archive
 [[ "$4" =~ ^/var/lib/cashneuro/classification-check-[A-Za-z0-9]+$ ]]
 extra=("$3" "$4")
fi
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo" rev-parse "$sha^{commit}")" = "$sha"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
test "$(pnpm --version)" = 11.25.0
build=$(mktemp -d /tmp/cashneuro-classification-check-XXXXXXXX)
trap 'rm -rf -- "$build"' EXIT
echo '1/2: подготовка отдельного теста; работающий сайт не переключается.'
git -C "$repo" archive "$sha" | tar --no-same-owner -x -C "$build"
(cd "$build" && pnpm install --frozen-lockfile --ignore-scripts)
echo '2/2: максимум два модельных запроса на синтетике; прежний расход и вызовы учтены.'
sudo -n /usr/bin/flock -n /run/lock/cashneuro-assistant-install.lock \
  /usr/bin/node --experimental-transform-types \
  "$build/apps/api/src/classification-smoke-main.ts" --live --continue-expired-pilot "${extra[@]}"
