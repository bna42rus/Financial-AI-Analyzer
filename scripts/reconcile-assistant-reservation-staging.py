"""Release one Staging hold only after an operator confirms it was not billed.

No model calls, limit changes, fabricated usage or resending the old request.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid


def run(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=25, check=False)
    if result.returncode:
        codes = re.findall(r'\b(?:RECONCILIATION_[A-Z_]+|REQUEST_STILL_RUNNING|RESERVATION_CHANGED|ACCOUNTING_CHANGED)\b', result.stderr)
        raise RuntimeError(codes[0] if codes else 'RECONCILIATION_COMMAND_FAILED')
    return result.stdout


def database():
    ids = run(['docker', 'ps', '--format', '{{.ID}}']).splitlines()
    if not ids or len(ids) > 30 or any(not re.fullmatch('[a-f0-9]{12,64}', i) for i in ids):
        raise RuntimeError('CONTAINER_LAYOUT_UNEXPECTED')
    ports = run(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', *ids]).splitlines()
    matches = [i for i, p in zip(ids, ports) if any(v.get('HostIp') == '127.0.0.1' and v.get('HostPort') == '5411'
               for v in (json.loads(p) or {}).get('5432/tcp') or [])]
    if len(ports) != len(ids) or len(matches) != 1:
        raise RuntimeError('STAGING_DATABASE_NOT_UNIQUE')
    return matches[0]


def query(email, request, atoms, apply=False):
    if not isinstance(email, str) or len(email) > 320 or not re.fullmatch(r'[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+', email):
        raise ValueError('EMAIL_INVALID')
    if str(uuid.UUID(request)) != request or not re.fullmatch(r'[1-9][0-9]{0,12}', atoms):
        raise ValueError('REQUEST_INVALID')
    encoded = email.lower().encode('utf-8').hex()
    mutation = f"""
 UPDATE commerce.ai_project_budget SET reserved_atoms=reserved_atoms-{atoms}
 WHERE project_id=x.project_id AND period_start=x.project_period_start;
 UPDATE commerce.ai_user_budget SET reserved_atoms=reserved_atoms-{atoms}
 WHERE user_id=x.user_id AND anchor_at=x.anchor_at AND period_start=x.period_start;
 UPDATE commerce.ai_cost_reservation SET state='released',settled_atoms=0
 WHERE user_id=x.user_id AND request_id='{request}' AND step='assistant_0';
 UPDATE commerce.analyzer_request SET state='failed',updated_at=clock_timestamp()
 WHERE user_id=x.user_id AND request_id='{request}' AND step='assistant_0';
""" if apply else ''
    return f"""BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='3s';
DO $reconcile$
DECLARE x record; p record; u record; owner_id text; n integer;
BEGIN
 IF current_database()<>'finance_staging' THEN RAISE EXCEPTION 'RECONCILIATION_DATABASE_DENIED'; END IF;
 SELECT user_id INTO STRICT owner_id FROM commerce.account_directory
 WHERE lower(email)=convert_from(decode('{encoded}','hex'),'UTF8');
 IF NOT pg_try_advisory_xact_lock(hashtextextended('assistant-run:'||owner_id||':{request}',0))
 THEN RAISE EXCEPTION 'REQUEST_STILL_RUNNING'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cloud-task-dispatch:'||owner_id,0));
 SELECT * INTO STRICT x FROM commerce.ai_cost_reservation
 WHERE user_id=owner_id AND request_id='{request}' AND step='assistant_0';
 SELECT * INTO STRICT p FROM commerce.ai_project_budget WHERE project_id=x.project_id AND period_start=x.project_period_start FOR UPDATE;
 SELECT * INTO STRICT u FROM commerce.ai_user_budget WHERE user_id=owner_id AND anchor_at=x.anchor_at AND period_start=x.period_start FOR UPDATE;
 SELECT c.*,r.state AS request_state,r.usage_state,r.provider,r.dispatched_at,r.input_tokens,r.output_tokens,r.model_version
 INTO STRICT x FROM commerce.ai_cost_reservation c JOIN commerce.analyzer_request r USING(user_id,request_id,step)
 WHERE c.user_id=owner_id AND c.request_id='{request}' AND c.step='assistant_0' FOR UPDATE OF c,r;
 IF x.provider<>'cashneuro-assistant/1' OR x.usage_state<>'unknown' OR x.reserved_atoms<>{atoms}
 OR x.dispatched_at IS NULL OR x.input_tokens IS NOT NULL OR x.output_tokens IS NOT NULL OR x.model_version IS NOT NULL
 OR x.reported_input_tokens IS NOT NULL OR x.reported_output_tokens IS NOT NULL OR x.reported_model_version IS NOT NULL
 THEN RAISE EXCEPTION 'RESERVATION_CHANGED'; END IF;
 IF x.state='released' AND x.settled_atoms=0 AND x.request_state='failed' THEN RETURN; END IF;
 IF x.state<>'unknown' OR x.request_state<>'unknown' OR x.settled_atoms IS NOT NULL OR x.created_at>clock_timestamp()-interval '10 minutes'
 THEN RAISE EXCEPTION 'RECONCILIATION_PRECONDITIONS_FAILED'; END IF;
 SELECT count(*) INTO n FROM finance.assistant_run a JOIN finance.analyzer_task_request t ON a.user_id=t.user_id AND a.request_id=t.id
 WHERE a.user_id=owner_id AND a.request_id='{request}' AND t.state='completed' AND t.reply->>'code'='ASSISTANT_DELIVERY_UNKNOWN'
 AND jsonb_array_length(a.receipt->'calls')=1 AND a.receipt->'calls'->0->>'state'='unknown'
 AND a.receipt->'calls'->0->>'usage' IS NULL;
 IF n<>1 THEN RAISE EXCEPTION 'RECONCILIATION_RESULT_CHANGED'; END IF;
 IF p.reserved_atoms<{atoms} OR u.reserved_atoms<{atoms}
 OR p.reserved_atoms<>(SELECT COALESCE(sum(reserved_atoms),0) FROM commerce.ai_cost_reservation WHERE project_id=x.project_id AND project_period_start=x.project_period_start AND state IN ('reserved','unknown'))
 OR u.reserved_atoms<>(SELECT COALESCE(sum(reserved_atoms),0) FROM commerce.ai_cost_reservation WHERE user_id=owner_id AND anchor_at=x.anchor_at AND period_start=x.period_start AND step<>'classification' AND state IN ('reserved','unknown'))
 THEN RAISE EXCEPTION 'ACCOUNTING_CHANGED'; END IF;
 {mutation}
END $reconcile$;
SELECT json_build_object('status',CASE WHEN state='released' THEN 'RELEASED' ELSE 'READY' END,
 'requestId',request_id,'providerUsage','unknown','reservedAtoms',reserved_atoms::text,'settledAtoms',settled_atoms::text)
FROM commerce.ai_cost_reservation WHERE request_id='{request}' AND step='assistant_0'
AND user_id=(SELECT user_id FROM commerce.account_directory WHERE lower(email)=convert_from(decode('{encoded}','hex'),'UTF8'));
COMMIT;
"""


def attest(request, atoms, root=Path('/var/lib/cashneuro')):
    s = root.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022 or root.resolve() != root:
        raise RuntimeError('AUDIT_DIRECTORY_INVALID')
    path = root / ('ai-unbilled-reconciliation-' + request + '.json')
    record = {'requestId': request, 'status': 'OPERATOR_ATTESTATION', 'scope': 'staging only',
              'reservedAtoms': atoms, 'providerUsage': 'unknown',
              'source': 'Owner declaration: Cloud.ru did not bill this request',
              'note': 'Operator-authorized release; not a provider-issued zero-usage receipt.'}
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as f:
            s = os.fstat(f.fileno())
            if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o077 or s.st_nlink != 1 or s.st_size > 16384:
                raise RuntimeError('AUDIT_FILE_INVALID')
            if json.load(f) != record:
                raise RuntimeError('AUDIT_FILE_CHANGED')
    else:
        with os.fdopen(fd, 'w') as f:
            json.dump(record, f); f.write('\n'); f.flush(); os.fsync(f.fileno())
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return str(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--email', required=True)
    parser.add_argument('--request-id', required=True)
    parser.add_argument('--reserved-atoms', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--attest-unbilled', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('ROOT_REQUIRED')
    if args.apply and not args.attest_unbilled:
        raise RuntimeError('OPERATOR_ATTESTATION_REQUIRED')
    sql = query(args.email, args.request_id, args.reserved_atoms)
    command = ['docker', 'exec', '-i', database(), 'sh', '-c',
               'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d finance_staging -Atq']
    result = json.loads(run(command, sql))
    if args.apply:
        attest(args.request_id, args.reserved_atoms)
        result = json.loads(run(command, query(args.email, args.request_id, args.reserved_atoms, True)))
    print(json.dumps({'paidCalls': 0, **result}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{1,80}', str(error)) else 'RECONCILIATION_FAILED'
        print(json.dumps({'status': 'STOP', 'code': code, 'paidCalls': 0}))
        raise SystemExit(1)
