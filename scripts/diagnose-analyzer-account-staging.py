"""Read-only per-account Staging diagnosis. No prompts, email or secrets in output.

Run on the server with sudo; does not call models or release cost reservations.
"""
import argparse
import json
import os
import re
import subprocess


def run(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=20, check=False)
    if result.returncode:
        raise RuntimeError('DIAGNOSTIC_COMMAND_FAILED')
    return result.stdout


def database():
    ids = run(['docker', 'ps', '--format', '{{.ID}}']).splitlines()
    if not ids or len(ids) > 30 or any(not re.fullmatch('[a-f0-9]{12,64}', i) for i in ids):
        raise RuntimeError('CONTAINER_LAYOUT_UNEXPECTED')
    ports = run(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', *ids]).splitlines()
    found = [i for i, value in zip(ids, ports) if any(p.get('HostIp') == '127.0.0.1' and p.get('HostPort') == '5411'
             for p in (json.loads(value) or {}).get('5432/tcp') or [])]
    if len(ids) != len(ports) or len(found) != 1:
        raise RuntimeError('STAGING_DATABASE_NOT_UNIQUE')
    return found[0]


def query(email):
    # Hex encoding prevents SQL/control-character injection; no personal value
    # is included in the report or committed source. This transaction cannot write.
    if not isinstance(email, str) or not re.fullmatch(r'[^\s@\x00-\x1f]{1,250}@[^\s@\x00-\x1f]{1,65}', email) or len(email) > 320:
        raise ValueError('EMAIL_INVALID')
    encoded = email.lower().encode('utf-8').hex()
    return """BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='3s';
WITH owner AS (SELECT user_id FROM commerce.account_directory
 WHERE lower(email)=convert_from(decode('""" + encoded + """','hex'),'UTF8')),
quota AS (SELECT q.* FROM owner o CROSS JOIN LATERAL commerce.customer_allowance_usage(o.user_id,clock_timestamp()) q),
holds AS (SELECT c.* FROM commerce.ai_cost_reservation c JOIN owner o USING(user_id) WHERE c.state IN ('reserved','unknown')),
recent AS (SELECT r.*,t.reply->>'code' AS result_code,a.receipt
 FROM commerce.analyzer_request r JOIN owner o USING(user_id)
 LEFT JOIN finance.analyzer_task_request t ON t.user_id=r.user_id AND t.id=r.request_id
 LEFT JOIN finance.assistant_run a ON a.user_id=r.user_id AND a.request_id=r.request_id
 ORDER BY r.created_at DESC LIMIT 12)
SELECT json_build_object('version','analyzer-account-diagnostic/1','paidCalls',0,
 'accountFound',EXISTS(SELECT 1 FROM owner),
 'allowance',(SELECT json_build_object('quota',quota,'remainingAtoms',base_remaining::text,
   'purchasedRemainingAtoms',purchased_remaining::text,'periodEnd',period_end,
   'insufficientAvailableLimit',base_remaining+purchased_remaining<=0) FROM quota),
 'pendingCosts',COALESCE((SELECT json_agg(json_build_object('requestId',request_id,'step',step,
   'state',state,'createdAt',created_at,'reservedAtoms',reserved_atoms::text)) FROM holds),'[]'::json),
 'recentRequests',COALESCE((SELECT json_agg(json_build_object('requestId',request_id,'step',step,
   'state',state,'usageState',usage_state,'dispatchedAt',dispatched_at,
   'resultCode',CASE WHEN result_code ~ '^[A-Z][A-Z0-9_]{1,80}$' THEN result_code END,
   'calls',(SELECT json_agg(json_build_object('phase',j->>'phase','state',j->>'state',
     'code',CASE WHEN j->>'code' ~ '^[A-Z][A-Z0-9_]{1,80}$' THEN j->>'code' END,
     'networkCode',CASE WHEN j->'transport'->>'networkCode' ~ '^[A-Z][A-Z0-9_]{1,80}$' THEN j->'transport'->>'networkCode' END))
     FROM jsonb_array_elements(COALESCE(receipt->'calls','[]'::jsonb)) j))) FROM recent),'[]'::json));
ROLLBACK;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--email', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('ROOT_REQUIRED')
    output = run(['docker', 'exec', '-i', database(), 'sh', '-c',
                  'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d finance_staging -Atq'], query(args.email))
    result = json.loads(output)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{1,80}', str(error)) else 'DIAGNOSTIC_FAILED'
        print(json.dumps({'status': 'STOP', 'code': code, 'paidCalls': 0}))
        raise SystemExit(1)
