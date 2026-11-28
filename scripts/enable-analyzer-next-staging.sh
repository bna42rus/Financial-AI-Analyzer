#!/usr/bin/env bash
# Owner-approved Staging-wide rollout followed by a bounded synthetic model run.
set -euo pipefail
repo=${1:?checkout required}
sha=${2:?commit required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo" rev-parse "$sha^{commit}")" = "$sha"
log=$(mktemp /tmp/cashneuro-analyzer-check-XXXXXXXX.log)
exec > >(tee "$log") 2>&1
echo "Полный журнал: $log"
temporary=$(mktemp -d /tmp/cashneuro-next-rollout-XXXXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
git -C "$repo" archive "$sha" scripts | tar --no-same-owner -x -C "$temporary"
echo 'STAGING: обновляем сайт и API; новый анализатор для всех аккаунтов. Месячный лимит 100 ₽ и прежний расход сохраняются.'
if sudo /usr/bin/python3 -B "$temporary/scripts/update-staging-release.py" --inspect-next-release "$sha"; then
  echo "STAGING: эта сборка сайта и API уже включена; повторного обновления нет."
else
  status=$?
  test "$status" = 3 || exit "$status"
  bash "$temporary/scripts/prepare-staging-release.sh" "$repo" "$sha" --preserve-active-ai --analyzer-next-all
fi
echo 'ACCEPTANCE: 30 синтетических сценариев с настоящим пониманием и review; максимум 10 ₽ внутри прежнего месячного лимита. Повтор команды использует сохранённые квитанции.'
sudo /usr/bin/python3 -B "$temporary/scripts/run-analyzer-next-pilot.py" --source "$repo" --sha "$sha" --suite acceptance --live
