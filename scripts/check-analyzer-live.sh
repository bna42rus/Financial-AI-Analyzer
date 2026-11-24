#!/usr/bin/env bash
set +x
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# The active backend owns all reservations and spend. Do not create another cap.
sudo python3 - <<'PY'
import json
from pathlib import Path
v=json.loads(Path('/etc/cashneuro/ai/assistant-staging.json').read_text())
assert v.get('realm')=='staging/finance' and v.get('monthly',{}).get('limitRub')=='100', 'Expected the existing 100 RUB monthly Staging cap'
print('Using the existing 100 RUB server cap; no reset or top-up.')
PY
read -r -p 'Email аккаунта CashNeuro: ' smoke_email
read -r -s -p 'Пароль аккаунта: ' smoke_password
printf '\n'
cd -- "$repo"
status=0
CASHNEURO_SMOKE_EMAIL="$smoke_email" CASHNEURO_SMOKE_PASSWORD="$smoke_password" pnpm --filter @finance/api exec node --import tsx ../../scripts/check-analyzer-live.ts --live --within-server-cap-rub=100 || status=$?
if ((status)); then sudo python3 scripts/diagnose-analyzer-account-staging.py --email "$smoke_email" || true; fi
unset smoke_password smoke_email
exit "$status"
