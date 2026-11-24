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
smoke_email=${CASHNEURO_SMOKE_EMAIL:-}
smoke_password=${CASHNEURO_SMOKE_PASSWORD:-}
unset CASHNEURO_SMOKE_EMAIL CASHNEURO_SMOKE_PASSWORD
if [[ -z "$smoke_email" ]]; then read -r -p 'Email аккаунта CashNeuro: ' smoke_email; fi
if [[ -z "$smoke_password" ]]; then read -r -s -p 'Пароль аккаунта: ' smoke_password; printf '\n'; fi
suite=${CASHNEURO_SMOKE_SUITE:-extended}
extra=()
case "$suite" in focused) extra+=(--focused);; extended) extra+=(--extended);; basic) ;; *) echo 'Unknown test suite'; exit 2;; esac
cd -- "$repo/apps/api"
status=0
CASHNEURO_SMOKE_EMAIL="$smoke_email" CASHNEURO_SMOKE_PASSWORD="$smoke_password" node --import tsx ../../scripts/check-analyzer-live.ts --live --within-server-cap-rub=100 "${extra[@]}" || status=$?
if ((status)); then sudo python3 "$repo/scripts/diagnose-analyzer-account-staging.py" --email "$smoke_email" || true; fi
unset smoke_password smoke_email
exit "$status"
