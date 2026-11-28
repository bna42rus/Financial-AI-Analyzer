"""Read-only configured-price accounting. No prompts, credentials or model calls."""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('account_diagnostic', Path(__file__).with_name('diagnose-analyzer-account-staging.py'))
account = importlib.util.module_from_spec(spec)
spec.loader.exec_module(account)


def query(settings, request_ids, now=None, account_email=None):
    if settings.get('realm') != 'staging/finance' or settings.get('monthly', {}).get('limitRub') != '100':
        raise ValueError('EXPECTED_MONTHLY_STAGING_CAP')
    if len(request_ids) > 128 or any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', v) for v in request_ids):
        raise ValueError('REQUEST_IDS_INVALID')
    emails, cost = settings.get('allowedEmails'), settings.get('cost', {})
    if not isinstance(emails, list) or len(emails) != 1 or not isinstance(cost.get('projectId'), str):
        raise ValueError('SINGLE_STAGING_ACCOUNT_REQUIRED')
    now = now or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=3)))
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = (start.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
    if account_email is not None:
        if not isinstance(account_email,str) or not re.fullmatch(r'[^\s@\x00-\x1f]{1,250}@[^\s@\x00-\x1f]{1,65}',account_email):
            raise ValueError('EMAIL_INVALID')
        emails=[account_email.lower()]
    config = {'emails': emails, 'project': cost['projectId'], 'from': start.isoformat(), 'through': end.isoformat(), 'ids': request_ids}
    encoded = json.dumps(config).encode().hex()
    return """BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
WITH config AS (SELECT convert_from(decode('%s','hex'),'UTF8')::jsonb AS v),
owners AS (SELECT user_id AS id FROM commerce.account_directory,config WHERE lower(email) IN (SELECT lower(jsonb_array_elements_text(v->'emails')))),
project_costs AS (SELECT c.* FROM commerce.ai_cost_reservation c,config WHERE c.project_id=v->>'project'),
costs AS (SELECT c.* FROM project_costs c,config WHERE c.created_at >= (v->>'from')::timestamptz AND c.created_at < (v->>'through')::timestamptz),
requested AS (SELECT jsonb_array_elements_text(v->'ids')::uuid AS id FROM config),
run_start AS (SELECT max(created_at) AS since FROM finance.analyzer_chat WHERE user_id IN (SELECT id FROM owners) AND title='Автопроверка: расходы и контекст'),
last_chats AS (SELECT id FROM finance.analyzer_chat,run_start WHERE user_id IN (SELECT id FROM owners)
 AND title LIKE 'Автопроверка:%%' AND created_at>=since),
previous AS (SELECT id FROM finance.analyzer_task_request WHERE user_id IN (SELECT id FROM owners) AND chat_id IN (SELECT id FROM last_chats))
SELECT json_build_object('version','analyzer-cost-diagnostic/1','paidCalls',0,'pricing','configured',
 'accountFound',(SELECT count(*)=1 FROM owners),
 'limitAtoms','100000000000',
 'spentAtoms',(SELECT COALESCE(sum(settled_atoms) FILTER(WHERE state IN ('settled','released')),0)::text FROM costs),
 'heldAtoms',(SELECT COALESCE(sum(reserved_atoms) FILTER(WHERE state IN ('reserved','unknown')),0)::text FROM costs),
 'components',COALESCE((SELECT json_agg(t) FROM (SELECT COALESCE(r.provider,'other') AS provider,
   count(*) AS calls,COALESCE(sum(c.settled_atoms),0)::text AS "spentAtoms"
   FROM costs c LEFT JOIN commerce.analyzer_request r USING(user_id,request_id,step) GROUP BY r.provider)t),'[]'::json),
 'previousDiagnostic',json_build_object('requests',(SELECT count(*) FROM previous),
   'calls',(SELECT count(*) FROM project_costs WHERE request_id IN (SELECT id FROM previous)),
   'spentAtoms',(SELECT COALESCE(sum(settled_atoms),0)::text FROM project_costs WHERE request_id IN (SELECT id FROM previous))),
 'requests',COALESCE((SELECT json_agg(json_build_object('id',q.id,
   'requestFound',EXISTS(SELECT 1 FROM finance.analyzer_task_request WHERE id=q.id AND user_id IN (SELECT id FROM owners)),
   'modelCalls',(SELECT (receipt->'result'->>'modelCalls')::int FROM finance.assistant_run WHERE request_id=q.id AND user_id IN (SELECT id FROM owners)),
   'calls',(SELECT count(*) FROM project_costs WHERE request_id=q.id AND user_id IN (SELECT id FROM owners)),
   'spentAtoms',(SELECT COALESCE(sum(settled_atoms),0)::text FROM project_costs WHERE request_id=q.id AND user_id IN (SELECT id FROM owners)),
   'heldAtoms',(SELECT COALESCE(sum(reserved_atoms) FILTER(WHERE state IN ('reserved','unknown')),0)::text FROM project_costs WHERE request_id=q.id AND user_id IN (SELECT id FROM owners)),
   'inputTokens',(SELECT COALESCE(sum(reported_input_tokens),0) FROM project_costs WHERE request_id=q.id AND user_id IN (SELECT id FROM owners)),
   'outputTokens',(SELECT COALESCE(sum(reported_output_tokens),0) FROM project_costs WHERE request_id=q.id AND user_id IN (SELECT id FROM owners)),
   'timings',(SELECT receipt->'result'->'timings' FROM finance.assistant_run WHERE request_id=q.id AND user_id IN (SELECT id FROM owners))
 )) FROM requested q),'[]'::json));
ROLLBACK;
""" % encoded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request-ids-stdin', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('ROOT_REQUIRED')
    path = Path('/etc/cashneuro/ai/assistant-staging.json')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 65536:
        raise ValueError('PRIVATE_CONFIGURATION_REQUIRED')
    payload = json.loads(sys.stdin.read(8192)) if args.request_ids_stdin else []
    request_ids = payload.get('ids') if isinstance(payload,dict) else payload
    account_email = payload.get('email') if isinstance(payload,dict) else os.environ.get('CASHNEURO_SMOKE_EMAIL')
    if not isinstance(request_ids, list):
        raise ValueError('REQUEST_IDS_INVALID')
    settings = json.loads(path.read_text())
    output = account.run(['docker', 'exec', '-i', account.database(), 'sh', '-c',
        'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d finance_staging -Atq'], query(settings, request_ids,account_email=account_email))
    report = json.loads(output)
    if not report.get('accountFound'):
        raise ValueError('COST_ACCOUNT_NOT_FOUND')
    if any(not r.get('requestFound') or r.get('modelCalls') is None or int(r['modelCalls'])!=int(r['calls']) for r in report.get('requests',[])):
        raise ValueError('COST_RECEIPT_INCONSISTENT')
    report['price'] = {k: settings['cost']['price'][k] for k in ['currency', 'inputRubPerMillion', 'outputRubPerMillion']}
    def rub(value):
        n=int(value)
        return str(n//1000000000)+'.'+str(n%1000000000).zfill(9)
    report['summaryRub']={'previousRun':rub(report['previousDiagnostic']['spentAtoms']),
        'monthSpent':rub(report['spentAtoms']),'held':rub(report['heldAtoms']),
        'available':rub(max(0,int(report['limitAtoms'])-int(report['spentAtoms'])-int(report['heldAtoms'])))}
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{1,80}', str(error)) else 'COST_DIAGNOSTIC_FAILED'
        print(json.dumps({'code': code, 'paidCalls': 0}))
        raise SystemExit(1)
