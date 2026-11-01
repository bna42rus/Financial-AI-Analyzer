#!/usr/bin/env python3
"""One-off, staging-only accounting reconciliation. No model calls.

Operator must have checked provider billing and supply a SHA-256 of the evidence.
The record explicitly remains a SENT request with UNKNOWN provider usage.
This does not claim that the HTTP request was never sent.
"""
import argparse
import json
import os
import re
import stat
import subprocess
from pathlib import Path

REQUEST = '115403a1-e063-4b2e-9876-f7e6123b26b1'
RESERVE = '2328657920'
PROJECT = 'staging/assistant-5859b601e6fd1b2c01bed1d'
PERIOD = '2026-10-29T15:25:53.587Z'

def fail(code):
    print(json.dumps({'status':'STOP','code':code,'paidCalls':0}))
    raise SystemExit(1)

def call(args, data=None, timeout=12):
    try:
        p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        fail('COMMAND_UNAVAILABLE')
    if p.returncode:
        fail('DATABASE_RECONCILIATION_REJECTED')
    return p.stdout

def database():
    ids=call(['docker','ps','--format','{{.ID}}']).splitlines()
    if not ids or len(ids)>30 or any(not re.fullmatch('[a-f0-9]{12,64}',v) for v in ids):
        fail('CONTAINER_LAYOUT_UNEXPECTED')
    ports=call(['docker','inspect','--format','{{json .NetworkSettings.Ports}}',*ids]).splitlines()
    if len(ports)!=len(ids):
        fail('CONTAINER_LAYOUT_UNEXPECTED')
    matches=[]
    for identifier, raw in zip(ids,ports):
        if any(p.get('HostIp')=='127.0.0.1' and p.get('HostPort')=='5411'
               for p in (json.loads(raw) or {}).get('5432/tcp') or []):
            matches.append(identifier)
    if len(matches)!=1:
        fail('STAGING_DATABASE_NOT_UNIQUE')
    return matches[0]

def sql(container, script):
    return call(['docker','exec','-i',container,'sh','-c',
                 'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d finance_staging -Atq'],
                data=script,timeout=20)

# The preview has no writes. Never print customer, password or credential data.
PREVIEW = """
BEGIN READ ONLY;
SELECT json_build_object(
 'requestFound',(SELECT count(*)=1 FROM commerce.analyzer_request WHERE request_id='{request}' AND step='classification' AND provider='cashneuro-categories/1'),
 'unknownRequest',(SELECT count(*)=1 FROM commerce.analyzer_request WHERE request_id='{request}' AND step='classification' AND state='unknown' AND usage_state='unknown' AND dispatched_at IS NOT NULL AND input_tokens IS NULL AND output_tokens IS NULL),
 'unknownCost',(SELECT count(*)=1 FROM commerce.ai_cost_reservation WHERE request_id='{request}' AND step='classification' AND state='unknown' AND reserved_atoms={reserve} AND settled_atoms IS NULL AND reported_input_tokens IS NULL AND reported_output_tokens IS NULL AND project_id='{project}' AND project_period_start='{period}'),
 'projectReserveMatches',(SELECT count(*)=1 FROM commerce.ai_project_budget WHERE project_id='{project}' AND period_start='{period}' AND reserved_atoms={reserve} AND blocked=false),
 'runUnknown',(SELECT count(*)=1 FROM finance.classification_run WHERE id='{request}' AND state='unknown'),
 'otherUnknownRequests',(SELECT count(*) FROM commerce.analyzer_request WHERE (state='sent' OR usage_state='unknown') AND request_id<>'{request}')
);
ROLLBACK;
""".format(request=REQUEST,reserve=RESERVE,project=PROJECT,period=PERIOD)

# Locks + exact identity/amount/state constraints prevent releasing the wrong row.
# Operator attestation is not a provider-issued per-request receipt.
APPLY = """
BEGIN;
SET LOCAL statement_timeout='10s';
DO $reconcile$
DECLARE x record; b record; n integer;
BEGIN
 SELECT r.user_id,r.state,r.usage_state,r.provider,r.dispatched_at,r.input_tokens,r.output_tokens,
        c.project_id,c.project_period_start,c.state AS cost_state,c.reserved_atoms,c.settled_atoms,
        c.reported_input_tokens,c.reported_output_tokens
 INTO x FROM commerce.analyzer_request r
 JOIN commerce.ai_cost_reservation c USING(user_id,request_id,step)
 WHERE r.request_id='{request}' AND r.step='classification'
 FOR UPDATE OF r,c;
 IF NOT FOUND OR x.state<>'unknown' OR x.usage_state<>'unknown'
 OR x.provider<>'cashneuro-categories/1' OR x.dispatched_at IS NULL
 OR x.input_tokens IS NOT NULL OR x.output_tokens IS NOT NULL
 OR x.cost_state<>'unknown' OR x.reserved_atoms<>{reserve}
 OR x.settled_atoms IS NOT NULL OR x.reported_input_tokens IS NOT NULL
 OR x.reported_output_tokens IS NOT NULL OR x.project_id<>'{project}'
 OR x.project_period_start<>'{period}'::timestamptz THEN
  RAISE EXCEPTION 'RECONCILIATION_PRECONDITIONS_FAILED';
 END IF;
 SELECT reserved_atoms,blocked INTO b FROM commerce.ai_project_budget
 WHERE project_id='{project}' AND period_start='{period}' FOR UPDATE;
 IF NOT FOUND OR b.reserved_atoms<>{reserve} OR b.blocked THEN
  RAISE EXCEPTION 'PROJECT_BUDGET_CHANGED';
 END IF;
 SELECT count(*) INTO n FROM commerce.analyzer_request
 WHERE user_id=x.user_id AND (state='sent' OR usage_state='unknown');
 IF n<>1 THEN RAISE EXCEPTION 'OTHER_UNKNOWN_REQUESTS'; END IF;
 SELECT count(*) INTO n FROM commerce.ai_cost_reservation
 WHERE project_id='{project}' AND state IN ('reserved','unknown');
 IF n<>1 THEN RAISE EXCEPTION 'OTHER_UNKNOWN_RESERVATIONS'; END IF;
 SELECT count(*) INTO n FROM finance.classification_run
 WHERE user_id=x.user_id AND id='{request}' AND state='unknown';
 IF n<>1 THEN RAISE EXCEPTION 'CLASSIFICATION_RUN_CHANGED'; END IF;
 UPDATE commerce.ai_cost_reservation SET state='released',settled_atoms=0
 WHERE user_id=x.user_id AND request_id='{request}' AND step='classification';
 UPDATE commerce.ai_project_budget SET reserved_atoms=reserved_atoms-{reserve}
 WHERE project_id='{project}' AND period_start='{period}';
 UPDATE commerce.analyzer_request SET state='failed',updated_at=clock_timestamp()
 WHERE user_id=x.user_id AND request_id='{request}' AND step='classification';
 UPDATE finance.classification_run SET state='failed'
 WHERE user_id=x.user_id AND id='{request}';
END $reconcile$;
COMMIT;
""".format(request=REQUEST,reserve=RESERVE,project=PROJECT,period=PERIOD)

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--apply',action='store_true')
    p.add_argument('--evidence-sha256')
    args=p.parse_args()
    if os.geteuid()!=0:
        fail('ROOT_REQUIRED')
    container=database()
    preview=json.loads(sql(container,PREVIEW).strip())
    print(json.dumps({'status':'PREVIEW','paidCalls':0,**preview}))
    expected=('requestFound','unknownRequest','unknownCost','projectReserveMatches','runUnknown')
    if not all(preview.get(k) is True for k in expected) or preview.get('otherUnknownRequests')!=0:
        fail('PRECONDITIONS_FAILED')
    if not args.apply:
        return
    evidence=args.evidence_sha256 or ''
    if not re.fullmatch('[a-f0-9]{64}',evidence):
        fail('EXTERNAL_EVIDENCE_HASH_REQUIRED')
    directory=Path('/var/lib/cashneuro')
    root=directory.lstat()
    if not stat.S_ISDIR(root.st_mode) or root.st_uid!=0 or root.st_mode & 0o022:
        fail('PRIVATE_AUDIT_DIRECTORY_REQUIRED')
    path=directory/('ai-unbilled-reconciliation-'+REQUEST+'.json')
    record={'requestId':REQUEST,'evidenceSha256':evidence,'status':'OPERATOR_ATTESTATION',
            'source':'Cloud.ru aggregate billing screenshots + owner declaration',
            'scope':'staging only','note':'Dispatched request; provider usage unknown; not a provider per-request zero-charge certificate',
            'reservationAtoms':RESERVE}
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as out:
        out.write(json.dumps(record,ensure_ascii=False)+'\n')
        out.flush()
        os.fsync(out.fileno())
    sql(container,APPLY)
    print(json.dumps({'status':'RELEASED_UNBILLED_BY_OPERATOR','requestId':REQUEST,
                      'reservedAtomsReleased':RESERVE,'paidCalls':0,
                      'providerUsage':'unknown','auditFile':str(path)}))
if __name__=='__main__':
    try:
        main()
    except (ValueError,TypeError,KeyError,OSError):
        fail('INSPECTION_DATA_UNAVAILABLE')
