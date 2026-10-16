#!/usr/bin/env bash
set -euo pipefail
repo=${1:?checkout required}
sha=${2:?commit required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo" rev-parse "$sha^{commit}")" = "$sha"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
test "$(pnpm --version)" = 11.25.0
build=$(mktemp -d /tmp/cashneuro-connected-build-XXXXXXXX)
trap 'rm -rf -- "$build"' EXIT
git -C "$repo" archive "$sha" | tar --no-same-owner -x -C "$build"
api_origin=$(sudo /usr/bin/python3 -B "$build/scripts/update-staging-release.py" --inspect-api-origin)
(cd "$build" && pnpm install --frozen-lockfile --ignore-scripts && VITE_API_ORIGIN="$api_origin" node scripts/build-connected-web.mjs finance "$sha")
sudo /usr/bin/python3 -B "$build/scripts/update-staging-release.py" --source "$build" --sha "$sha"
