#!/usr/bin/env bash
set -euo pipefail
repo=${1:?checkout required}
sha=${2:?commit required}
extra=()
resume_ai=false
full_staging=false
shift 2
while (($#)); do
  case "$1" in
    --full-staging) full_staging=true; extra+=("$1"); shift ;;
    --resume-ai) resume_ai=true; extra+=("$1"); shift ;;
    --monthly-ai-budget=100) extra+=("$1"); shift ;;
    --enable-classification|--keep-ai-paused|--preserve-active-ai) extra+=("$1"); shift ;;
    --classification-evidence|--tested-runtime-sha) test "$#" -ge 2; extra+=("$1" "$2"); shift 2 ;;
    *) exit 2 ;;
  esac
done
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo" rev-parse "$sha^{commit}")" = "$sha"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
test "$(pnpm --version)" = 11.25.0
build=$(mktemp -d /tmp/cashneuro-connected-build-XXXXXXXX)
trap 'rm -rf -- "$build"' EXIT
git -C "$repo" archive "$sha" | tar --no-same-owner -x -C "$build"
api_origin=$(sudo /usr/bin/python3 -B "$build/scripts/update-staging-release.py" --inspect-api-origin)
(cd "$build" && pnpm install --frozen-lockfile --ignore-scripts && VITE_API_ORIGIN="$api_origin" node scripts/build-connected-web.mjs finance "$sha")
if "$full_staging"; then
  control_origin=$(sudo /usr/bin/python3 -B "$build/scripts/update-staging-release.py" --inspect-control-origin)
  (cd "$build" && VITE_API_ORIGIN="$control_origin" node scripts/build-connected-web.mjs control "$sha")
fi
sudo /usr/bin/python3 -B "$build/scripts/update-staging-release.py" --source "$build" --sha "$sha" "${extra[@]}"
if "$resume_ai"; then
  echo 'Проверяем итоговый статус ИИ и незавершённые квитанции; платных запросов: 0.'
  if ! sudo timeout 35s /usr/bin/python3 -u -B "$build/scripts/diagnose-classification-staging.py"; then
    echo "Обновление завершено; дополнительная диагностика ИИ не завершилась за отведённое время."
  fi
fi
