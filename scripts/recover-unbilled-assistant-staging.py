#!/usr/bin/env python3
"""Reconcile only the Nov 2 staging call explicitly declared unbilled by its owner.

GET /models is read-only. No completion, retry, zero-token receipt or budget reset.
The original dispatched_at, unknown usage and failed conversation remain intact.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess

REQUEST = '0b4030ab-775a-4c03-8131-dec463439a5b'
PROJECT = 'staging/assistant-5859b601e6fd1b12c01bed1d'
PERIOD = '2026-10-31T21:00:00Z'
RESERVE = 2152001920

def emit(**value):
    print(json.dumps({'paidCalls': 0, **value}, ensure_ascii=False), flush=True)

def run(args, data=None, timeout=20):
    p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        codes = ('RECONCILIATION_PRECONDITIONS_FAILED', 'OTHER_OPEN_RESERVATIONS',
                 'BUDGET_RESERVE_CHANGED', 'ASSISTANT_RESULT_CHANGED')
        raise RuntimeError(next((c for c in codes if c in p.stderr), 'COMMAND_FAILED'))
    return p.stdout

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

def sql(container, query):
    return run(['docker', 'exec', '-i', container, 'sh', '-c',
                'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d finance_staging -Atq'], query)

# Node, endpoint, key and TLS validation match the application. No secret appears
# in arguments, output or exception messages. A successful GET does not prove POST.
CONNECTION = r"""
import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
const path='/etc/cashneuro/ai/assistant-staging.json';
const started=performance.now();
const codes=['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
try {
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let key;
 try {const s=await fd.stat();if(!s.isFile()||s.uid!==0||(s.mode&0o077)||s.nlink!==1||s.size>65536||await realpath(path)!==path)throw Error();
  const c=JSON.parse(await fd.readFile('utf8'));if(c.realm!=='staging/finance'||typeof c.apiKey!=='string'||!/^[\x21-\x7e]{20,512}$/.test(c.apiKey))throw Error();key=c.apiKey;
 }finally{await fd.close();}
 const r=await fetch('https://foundation-models.api.cloud.ru/v1/models',{headers:{authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(12000)});
 let available=false;
 if(r.ok){const reader=r.body?.getReader();if(!reader)throw Error();let n=0,parts=[];
  try{while(true){const p=await reader.read();if(p.done)break;n+=p.value.length;if(n>524288)throw Error();parts.push(p.value);}}finally{await reader.cancel();}
  const d=JSON.parse(Buffer.concat(parts).toString('utf8'));available=Array.isArray(d.data)&&d.data.some(m=>m.id==='openai/gpt-oss-120b');
 }else{await r.body?.cancel();}
 console.log(JSON.stringify({status:r.ok&&available?'OK':'FAIL',httpStatus:r.status,modelAvailable:available,elapsedMs:Math.round(performance.now()-started)}));
}catch(e){const c=e?.cause?.code??e?.code;console.log(JSON.stringify({status:'FAIL',networkCode:e?.name==='TimeoutError'?'TIMEOUT':codes.includes(c)?c:'OTHER',elapsedMs:Math.round(performance.now()-started)}));}
"""

def reconcile_query(apply=False):
    mutation = f"""
 UPDATE commerce.ai_project_budget SET reserved_atoms=reserved_atoms-{RESERVE}
 WHERE project_id=x.project_id AND period_start=x.project_period_start;
 UPDATE commerce.ai_user_budget SET reserved_atoms=reserved_atoms-{RESERVE}
 WHERE user_id=x.user_id AND anchor_at=x.anchor_at AND period_start=x.period_start;
 UPDATE commerce.ai_cost_reservation SET state='released',settled_atoms=0
 WHERE user_id=x.user_id AND request_id='{REQUEST}' AND step='assistant_0';
 UPDATE commerce.analyzer_request SET state='failed',updated_at=clock_timestamp()
 WHERE user_id=x.user_id AND request_id='{REQUEST}' AND step='assistant_0';
""" if apply else ''
    return f"""
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='5s';
DO $reconcile$
DECLARE x record; p record; u record; owner_id text; n integer;
BEGIN
 SELECT user_id INTO STRICT owner_id FROM commerce.ai_cost_reservation
 WHERE request_id='{REQUEST}' AND step='assistant_0' AND project_id='{PROJECT}';
 PERFORM pg_advisory_xact_lock(hashtextextended('cloud-task-dispatch:'||owner_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('assistant-monthly:{PROJECT}',0));
 SELECT * INTO STRICT p FROM commerce.ai_project_budget WHERE project_id='{PROJECT}' AND period_start='{PERIOD}' FOR UPDATE;
 SELECT b.* INTO STRICT u FROM commerce.ai_user_budget b JOIN commerce.ai_cost_reservation c
 ON b.user_id=c.user_id AND b.anchor_at=c.anchor_at AND b.period_start=c.period_start
 WHERE c.request_id='{REQUEST}' AND c.step='assistant_0' AND c.user_id=owner_id FOR UPDATE OF b;
 SELECT c.*,r.state AS request_state,r.usage_state,r.provider,r.dispatched_at,r.input_tokens,r.output_tokens,r.model_version
 INTO STRICT x FROM commerce.ai_cost_reservation c JOIN commerce.analyzer_request r USING(user_id,request_id,step)
 WHERE c.user_id=owner_id AND c.request_id='{REQUEST}' AND c.step='assistant_0' FOR UPDATE OF c,r;
 IF x.provider<>'cashneuro-assistant/1' OR x.dispatched_at IS NULL OR x.usage_state<>'unknown'
 OR x.input_tokens IS NOT NULL OR x.output_tokens IS NOT NULL OR x.model_version IS NOT NULL
 OR x.reserved_atoms<>{RESERVE} OR x.reported_input_tokens IS NOT NULL OR x.reported_output_tokens IS NOT NULL
 OR x.reported_model_version IS NOT NULL OR x.project_id<>'{PROJECT}' OR x.project_period_start<>'{PERIOD}'::timestamptz
 OR x.quoted_input_tokens<>131072 OR x.quoted_output_tokens<>1200 OR x.quoted_model_version<>'openai/gpt-oss-120b'
 THEN RAISE EXCEPTION 'RECONCILIATION_PRECONDITIONS_FAILED'; END IF;
 IF x.state='released' AND x.settled_atoms=0 AND x.request_state='failed' THEN RETURN; END IF;
 IF x.state<>'unknown' OR x.settled_atoms IS NOT NULL OR x.request_state<>'unknown'
 THEN RAISE EXCEPTION 'RECONCILIATION_PRECONDITIONS_FAILED'; END IF;
 SELECT count(*) INTO n FROM commerce.ai_cost_reservation WHERE project_id='{PROJECT}' AND state IN ('reserved','unknown');
 IF n<>1 THEN RAISE EXCEPTION 'OTHER_OPEN_RESERVATIONS'; END IF;
 SELECT count(*) INTO n FROM commerce.ai_cost_reservation WHERE user_id=owner_id AND state IN ('reserved','unknown');
 IF n<>1 THEN RAISE EXCEPTION 'OTHER_OPEN_RESERVATIONS'; END IF;
 IF p.reserved_atoms<>{RESERVE} OR p.blocked OR u.reserved_atoms<>{RESERVE}
 THEN RAISE EXCEPTION 'BUDGET_RESERVE_CHANGED'; END IF;
 SELECT count(*) INTO n FROM finance.assistant_run a JOIN finance.analyzer_task_request t
 ON a.user_id=t.user_id AND a.request_id=t.id WHERE a.user_id=owner_id AND a.request_id='{REQUEST}'
 AND t.state='completed' AND t.reply->>'code'='ASSISTANT_DELIVERY_UNKNOWN'
 AND jsonb_array_length(a.receipt->'calls')=1 AND a.receipt->'calls'->0->>'state'='unknown'
 AND a.receipt->'calls'->0->>'code'='ASSISTANT_DELIVERY_UNKNOWN'
 AND a.receipt->'calls'->0->>'usage' IS NULL;
 IF n<>1 THEN RAISE EXCEPTION 'ASSISTANT_RESULT_CHANGED'; END IF;
 {mutation}
END $reconcile$;
SELECT json_build_object('status',CASE WHEN c.state='released' THEN 'RELEASED' ELSE 'READY' END,
 'requestId',c.request_id,'costState',c.state,'providerUsage',r.usage_state,
 'requestElapsedMs',CASE WHEN r.state='unknown' THEN round(extract(epoch FROM (r.updated_at-r.dispatched_at))*1000) ELSE NULL END,
 'projectReservedAtoms',p.reserved_atoms::text,'userReservedAtoms',b.reserved_atoms::text)
 FROM commerce.ai_cost_reservation c JOIN commerce.analyzer_request r USING(user_id,request_id,step)
 JOIN commerce.ai_project_budget p ON p.project_id=c.project_id AND p.period_start=c.project_period_start
 JOIN commerce.ai_user_budget b ON b.user_id=c.user_id AND b.anchor_at=c.anchor_at AND b.period_start=c.period_start
 WHERE c.request_id='{REQUEST}' AND c.step='assistant_0' AND c.project_id='{PROJECT}';
{'COMMIT' if apply else 'ROLLBACK'};
"""

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--attest-unbilled',action='store_true')
    args=parser.parse_args()
    if os.geteuid()!=0: raise RuntimeError('ROOT_REQUIRED')
    if args.apply and not args.attest_unbilled: raise RuntimeError('OPERATOR_ATTESTATION_REQUIRED')
    emit(step='connection',status='START')
    connection=json.loads(run(['/usr/bin/node','--input-type=module','-'],CONNECTION,timeout=16))
    emit(step='connection',**connection)
    emit(step='accounting',status='START')
    container=database()
    preview=json.loads(sql(container,reconcile_query()).strip())
    emit(step='accounting',**preview)
    if not args.apply: return
    directory=Path('/var/lib/cashneuro')
    s=directory.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or directory.resolve()!=directory:
        raise RuntimeError('AUDIT_DIRECTORY_INVALID')
    path=directory/('ai-unbilled-reconciliation-'+REQUEST+'.json')
    record={'requestId':REQUEST,'status':'OPERATOR_ATTESTATION','source':'Owner declaration: Cloud.ru did not bill this request',
            'scope':'staging only','reservedAtoms':str(RESERVE),'providerUsage':'unknown','connection':connection,
            'note':'Allocation released by operator; not a provider-issued zero-usage receipt.'}
    try:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    except FileExistsError:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd) as f:
            s=os.fstat(f.fileno())
            if s.st_uid!=0 or s.st_mode&0o077 or s.st_nlink!=1 or not stat.S_ISREG(s.st_mode): raise RuntimeError('AUDIT_FILE_INVALID')
            old=json.load(f)
        if any(old.get(k)!=record[k] for k in ('requestId','source','scope','reservedAtoms','providerUsage')): raise RuntimeError('AUDIT_FILE_CHANGED')
    else:
        with os.fdopen(fd,'w') as f:
            json.dump(record,f,ensure_ascii=False);f.write('\n');f.flush();os.fsync(f.fileno())
        fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    result=json.loads(sql(container,reconcile_query(True)).strip())
    emit(step='accounting',auditFile=str(path),**result)

if __name__=='__main__':
    try: main()
    except (OSError,ValueError,KeyError,TypeError,RuntimeError,subprocess.TimeoutExpired) as error:
        code=str(error) if isinstance(error,RuntimeError) and re.fullmatch('[A-Z_]{3,80}',str(error)) else 'INSPECTION_FAILED'
        emit(status='STOP',code=code)
        raise SystemExit(1)
