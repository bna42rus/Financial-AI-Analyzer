#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sys


def main():
    if os.geteuid() != 0:
        raise SystemExit('Запустите скрипт через sudo.')
    try:
        email = input('Почта пользователя Staging: ').strip().lower()
    except EOFError:
        raise SystemExit('Почта не введена.') from None
    if not re.fullmatch(r'[^\s@]{1,128}@[^\s@]{1,123}', email):
        raise SystemExit('Проверьте адрес почты.')
    installer = runpy.run_path(str(Path(__file__).with_name('install-assistant-staging.py')))
    try:
        _, _, sql = installer['docker_database']()
        account = hashlib.sha256(email.encode()).hexdigest()
        try:
            result = json.loads(sql(f"SELECT commerce.restore_legacy_analyzer_allowance('{account}')"))
        except installer['InstallationError']:
            # Re-run only the read-only lookup to identify the failed precondition.
            diagnostic = json.loads(sql(f"""
                WITH target AS (
                  SELECT id,email_verified FROM identity.auth_user
                  WHERE encode(sha256(convert_to(email,'UTF8')),'hex')='{account}'
                )
                SELECT jsonb_build_object('status','RESTORE_STOPPED',
                  'verifiedAccount',EXISTS(SELECT 1 FROM target WHERE email_verified),
                  'accessActive',EXISTS(SELECT 1 FROM target t
                    JOIN identity.security_state s ON s.user_id=t.id
                    JOIN commerce.access_cycle c ON c.user_id=t.id
                    WHERE s.status='active' AND (c.indefinite OR c.access_end>clock_timestamp())),
                  'windowLimit',(SELECT quota FROM commerce.access_paid_window w JOIN target t ON w.user_id=t.id
                    WHERE w.starts_at<=clock_timestamp() AND w.ends_at>clock_timestamp()
                    ORDER BY w.starts_at DESC LIMIT 1))
            """))
            print(json.dumps(diagnostic, ensure_ascii=False), file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except installer['InstallationError'] as error:
        print('Восстановление остановлено: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
