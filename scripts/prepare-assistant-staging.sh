#!/usr/bin/env bash
# Run as the deployment user from a checkout pinned to the passed commit.
set -euo pipefail
repo=${1:?checkout path required}
sha=${2:?commit required}
key_file=${3:?private key file required}
budget_one=${4:?first stage budget required}
budget_two=${5:?next stage budget required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo" rev-parse "$sha^{commit}")" = "$sha"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
test "$(pnpm --version)" = 11.25.0
IFS= read -r -p 'Почта вашего тестового аккаунта Finance: ' test_email </dev/tty
[[ -n "$test_email" ]]
build=$(mktemp -d /tmp/cashneuro-assistant-build-XXXXXXXX)
trap 'rm -rf -- "$build"' EXIT
git -C "$repo" archive "$sha" | tar --no-same-owner -x -C "$build"
printf '%s\n' 'Сборка проверенного релиза. Рабочий API продолжает работать.'
(cd "$build" && pnpm install --frozen-lockfile --ignore-scripts && pnpm run build:web)
printf '%s\n' "$test_email" | sudo /usr/bin/python3 "$build/scripts/install-assistant-staging.py" --email-stdin \
  --source "$build" --sha "$sha" --key-file "$key_file" \
  --budget-file "$budget_one" --budget-file "$budget_two"
