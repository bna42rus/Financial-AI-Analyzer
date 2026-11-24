#!/usr/bin/env bash
# Run from an immutable git object. Secrets are requested through /dev/tty only.
set -euo pipefail
test "$(id -u)" = 0
repo=${1:?repository path required}
sha=${2:?exact commit required}
confirmed_holds=0
resume_setup=0
shift 2
for option in "$@"; do
  case "$option" in
    --confirmed-unbilled-existing-holds) confirmed_holds=1 ;;
    --resume-setup) resume_setup=1 ;;
    *) exit 2 ;;
  esac
done
[[ "$repo" = /home/finance-admin/cashneuro-staging-src ]]
[[ "$sha" =~ ^[a-f0-9]{40}$ ]]
test "$(git -c safe.directory="$repo" -C "$repo" rev-parse "$sha^{commit}")" = "$sha"
umask 077
install -d -m 700 /var/lib/cashneuro-ops
build=$(mktemp -d /var/lib/cashneuro-ops/install-XXXXXXXX)
bundle=''
trap 'rm -rf -- "$build"; if test -n "$bundle"; then rm -rf -- "$bundle"; fi' EXIT
git -c safe.directory="$repo" -C "$repo" archive "$sha" \
  scripts/cashneuro_ops scripts/cashneuro-ops.py scripts/diagnose-assistant-post-staging.py \
  scripts/reconcile-assistant-reservation-staging.py \
  apps/api/src/analyzer-cost.ts apps/api/src/customer-ai-budget.ts \
  packages/analyzer/src/cost.ts packages/finance-core/src/model.ts packages/finance-core/src/money.ts \
  package.json | tar --no-same-owner -xf - -C "$build"

exec 9>/run/lock/cashneuro-assistant-install.lock
flock -n 9
destination=/usr/local/lib/cashneuro-ops-releases/$sha
install -d -m 755 /usr/local/lib/cashneuro-ops-releases
if test ! -d "$destination"; then
  bundle=$(mktemp -d /usr/local/lib/cashneuro-ops-releases/.install-XXXXXXXX)
  cp -R "$build/scripts/cashneuro_ops" "$bundle/"
  cp "$build/scripts/cashneuro-ops.py" "$build/scripts/diagnose-assistant-post-staging.py" \
    "$build/scripts/reconcile-assistant-reservation-staging.py" "$bundle/"
  install -d -m 755 "$bundle/source"
  cp -R "$build/apps" "$build/packages" "$build/package.json" "$bundle/source/"
  printf '%s\n' "$sha" > "$bundle/source-commit"
  chown -R root:root "$bundle"
  find "$bundle" -type d -exec chmod 755 {} +
  find "$bundle" -type f -exec chmod 644 {} +
  mv -T "$bundle" "$destination"
  bundle=''
fi
test "$(cat "$destination/source-commit")" = "$sha"
temporary_link=/usr/local/lib/.cashneuro-ops-$$
ln -s "$destination" "$temporary_link"
mv -Tf "$temporary_link" /usr/local/lib/cashneuro-ops
cat > /usr/local/bin/cashneuro-ops <<'WRAPPER'
#!/bin/sh
exec /usr/bin/python3 -B /usr/local/lib/cashneuro-ops/cashneuro-ops.py "$@"
WRAPPER
chmod 755 /usr/local/bin/cashneuro-ops
flock -u 9
exec 9>&-

if test "$resume_setup" = 0; then
  echo '1/6: очищаем только неиспользуемые старые backend-релизы.'
  cashneuro-ops prune --apply
  echo '2/6: проверяем размещение и размеры баз.'
  cashneuro-ops storage
  echo '3/6: сверяем зависшие запросы с уже записанным фактическим usage.'
  cashneuro-ops diagnose --settle-recorded-usage
else
  echo 'Продолжаем после уже выполненной очистки и проверки баз.'
fi
if test "$confirmed_holds" = 1; then
  echo 'Обрабатываем только прежние резервы, отсутствие списания по которым подтвердил владелец.'
  cashneuro-ops resolve-confirmed-holds --confirm-provider-unbilled
  cashneuro-ops diagnose
fi
echo '4/6: проверяем ранее установленный ключ Cloud.ru без генерации.'
cashneuro-ops probe-cloudru
echo '5/6: готовим зашифрованные копии в существующем S3.'
if ! python3 - <<'CHECK_RESTIC'
import re,subprocess
try:
    text=subprocess.check_output(['/usr/bin/restic','version'],text=True)
    match=re.search(r'restic (\d+)\.(\d+)\.(\d+)',text)
    raise SystemExit(0 if match and tuple(map(int,match.groups()))>=(0,17,0) else 1)
except (OSError,subprocess.SubprocessError):
    raise SystemExit(1)
CHECK_RESTIC
then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends restic
fi
cashneuro-ops setup
echo '6/6: проверяем итоговый статус после копирования, восстановления и замера.'
cashneuro-ops status
df -h /
curl --max-time 10 -fsS -w '\n' http://127.0.0.1:3000/health
curl --max-time 10 -fsS -w '\n' http://127.0.0.1:3001/health
