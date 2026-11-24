"""Read only selected smoke receipts and check them offline. No model calls.

Input is a JSON array of {name,id}. Archived values go only to a local child,
never to this script's output, files, a provider or a financial write handler.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def main():
    if os.geteuid() != 0:
        raise RuntimeError('ROOT_REQUIRED')
    raw = sys.stdin.read(8193)
    if len(raw) > 8192:
        raise ValueError('ARCHIVE_INPUT_TOO_LARGE')
    cases = json.loads(raw)
    allowed = {'loan-free-wording', 'loan-prepayment', 'multiple-read-conditions', 'deposit-compound-additions', 'percentage-decimal'}
    if not isinstance(cases, list) or not 1 <= len(cases) <= 5:
        raise ValueError('ARCHIVE_INPUT_INVALID')
    for item in cases:
        if not isinstance(item, dict) or set(item) != {'name', 'id'} or not isinstance(item['name'], str) or item['name'] not in allowed or not isinstance(item['id'], str):
            raise ValueError('ARCHIVE_INPUT_INVALID')
        item['id'] = str(uuid.UUID(item['id']))
    if len({v['id'] for v in cases}) != len(cases) or len({v['name'] for v in cases}) != len(cases):
        raise ValueError('ARCHIVE_DUPLICATE')
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location('archive_db', here / 'diagnose-analyzer-account-staging.py')
    db = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(db)
    encoded = json.dumps(cases).encode().hex()
    query = """BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s';
WITH wanted AS (SELECT * FROM jsonb_to_recordset(convert_from(decode('""" + encoded + """','hex'),'UTF8')::jsonb) AS i(name text,id uuid))
SELECT json_agg(json_build_object('name',w.name,
 'question',r.receipt#>>'{conversation,turns,-1,question}',
 'calls',r.receipt->'calls'))
FROM wanted w LEFT JOIN finance.assistant_run r ON r.request_id=w.id;
ROLLBACK;"""
    saved = db.run(['docker', 'exec', '-i', db.database(), 'sh', '-c',
                    'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d finance_staging -Atq'], query)
    result = subprocess.run(['node', '--import', 'tsx', '../../scripts/check-analyzer-archive.ts'],
                            cwd=here.parent / 'apps/api', input=saved, text=True,
                            capture_output=True, timeout=20, check=False,
                            env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8'})
    # The fixed child prints only case names and validation codes, never values.
    if any(not line.startswith(('PASS archived-', 'FAIL archived-', 'ARCHIVE_RESULT:', 'ARCHIVE_CHECK_FAILED')) for line in result.stdout.splitlines()):
        raise RuntimeError('ARCHIVE_OUTPUT_INVALID')
    if result.returncode not in (0, 1) or not result.stdout.strip():
        raise RuntimeError('ARCHIVE_CHILD_FAILED')
    print(result.stdout, end='')
    return result.returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError):
        print('ARCHIVE_CHECK_FAILED: no model calls')
        raise SystemExit(1)
