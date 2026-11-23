"""Read-only capacity/accounting inspection and recovery of recorded real usage."""
import json
import importlib.util
from pathlib import Path
import re
import uuid
from urllib.parse import urlsplit

from .common import STATE, OpsError, database, emit, env_file, private_read, private_write, run, sql

SOURCE = Path(__file__).resolve().parents[1] / 'source'

# Owner explicitly confirmed these historical Staging calls were not billed.
# UUID + exact original reservation identify the scope; never sweep future unknowns.
CONFIRMED_UNBILLED_HOLDS = {
    'e6b054ec-e6fb-4ae4-88e4-27a626159e45': '2225201920',
    'c3d74b6a-e077-45b4-b996-cf865c802096': '2152001920',
}
CONFIRMED_PROJECT = 'staging/assistant-5859b601e6fd1b12c01bed1d'

ACCOUNTING_SQL = """BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT json_build_object(
 'databaseBytes',pg_database_size(current_database()),
 'openReservations',COALESCE((SELECT json_agg(t) FROM (
  SELECT c.request_id,c.step,c.state,c.created_at,c.reserved_atoms::text,c.settled_atoms::text,
   c.reported_input_tokens,c.reported_output_tokens,c.reported_model_version,
   r.state AS request_state,r.usage_state,r.dispatched_at,
   r.input_tokens,r.output_tokens,r.model_version,
   CASE WHEN c.step IN ('assistant_0','assistant_1','assistant_2')
    THEN jsonb_typeof(a.receipt->'calls'->right(c.step,1)::int->'usage')='object' ELSE false END AS saved_usage_present
  FROM commerce.ai_cost_reservation c LEFT JOIN commerce.analyzer_request r USING(user_id,request_id,step)
  LEFT JOIN finance.assistant_run a ON a.user_id=c.user_id AND a.request_id=c.request_id
  WHERE c.state IN ('reserved','unknown') ORDER BY c.created_at,c.request_id,c.step LIMIT 100
 )t),'[]'::json),
 'projectBudgets',COALESCE((SELECT json_agg(t) FROM (
  SELECT project_id,period_start,period_end,limit_atoms::text,spent_atoms::text,reserved_atoms::text,blocked
  FROM commerce.ai_project_budget ORDER BY period_start DESC LIMIT 10
 )t),'[]'::json));
ROLLBACK;"""

RECOVERY = r"""
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
let input='';for await(const chunk of process.stdin)input+=chunk;
const c=JSON.parse(input);
const require=createRequire(c.release+'/apps/api/package.json');
const {Pool}=require('pg');
const {reconcileRecordedAssistantCosts}=await import(pathToFileURL(c.source+'/apps/api/src/analyzer-cost.ts'));
const pool=new Pool({connectionString:c.url,max:1,connectionTimeoutMillis:5000});
const db=await pool.connect();let recovered=0;
try{
 for(const user of c.users){
  await db.query('BEGIN');
  try{
   await db.query("SET LOCAL statement_timeout='15s';SET LOCAL lock_timeout='3s'");
   await db.query("SELECT set_config('app.user_id',$1,true)",[user.user_id]);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['cloud-task-dispatch:'+user.user_id]);
   recovered+=await reconcileRecordedAssistantCosts(db,user.user_id);
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
 }
 console.log(JSON.stringify({recordedUsageSettled:recovered,paidCalls:0,unknownUsageReleased:0}));
}finally{db.release();await pool.end();}
"""


def recover_known_usage():
    config = json.loads(private_read('/etc/cashneuro/ai/assistant-staging.json'))
    url = env_file('/etc/cashneuro/staging/finance-api.env').get('DATABASE_URL', '')
    parsed = urlsplit(url)
    if parsed.scheme not in ('postgres', 'postgresql') or parsed.hostname not in ('localhost', '127.0.0.1') or parsed.port != 5411 or parsed.path != '/finance_staging' or parsed.username != 'finance_api':
        raise OpsError('RECOVERY_DATABASE_SCOPE_INVALID')
    release = Path(run(['systemctl', 'show', 'cashneuro-staging-api@finance.service', '-p', 'WorkingDirectory', '--value']).decode().strip()).parents[1]
    if not re.fullmatch(r'/srv/cashneuro/staging/backend-releases/[a-f0-9]{40}', str(release)) or release.resolve() != release:
        raise OpsError('RECOVERY_RELEASE_INVALID')
    if not (SOURCE / 'apps/api/src/analyzer-cost.ts').is_file():
        raise OpsError('AUDITED_RECOVERY_SOURCE_MISSING')
    project = config.get('cost', {}).get('projectId')
    if not isinstance(project, str) or not re.fullmatch(r'staging/[a-z0-9._/-]{1,70}', project):
        raise OpsError('RECOVERY_PROJECT_INVALID')
    literal = "'" + project.replace("'", "''") + "'"
    users = json.loads(sql(database('staging'), """BEGIN READ ONLY;SET LOCAL statement_timeout='5s';
SELECT COALESCE(json_agg(t),'[]'::json) FROM (SELECT DISTINCT c.user_id
FROM commerce.ai_cost_reservation c JOIN finance.assistant_run a
ON a.user_id=c.user_id AND a.request_id=c.request_id
WHERE c.project_id=""" + literal + """ AND c.state IN ('reserved','unknown')
AND c.step IN ('assistant_0','assistant_1','assistant_2')
AND jsonb_typeof(a.receipt->'calls'->right(c.step,1)::int->'usage')='object' LIMIT 100)t;ROLLBACK;"""))
    payload = json.dumps({'release': str(release), 'source': str(SOURCE), 'url': url, 'project': project, 'users': users}).encode()
    result = json.loads(run(['/usr/bin/node', '--experimental-transform-types', '--input-type=module', '-e', RECOVERY], data=payload, timeout=120))
    emit('known-usage-reconciliation', **result)
    return result


def inspect_accounting(settle_known=False):
    if settle_known:
        recover_known_usage()
    result = json.loads(sql(database('staging'), ACCOUNTING_SQL))
    emit('assistant-accounting', paidCalls=0, **result)
    return result


def resolve_hold(request_id, confirmed_unbilled=False, expected_atoms=None):
    """A separate explicit owner declaration; never invoked by setup or a timer."""
    if str(uuid.UUID(request_id)) != request_id:
        raise OpsError('REQUEST_ID_INVALID')
    config = json.loads(private_read('/etc/cashneuro/ai/assistant-staging.json'))
    project = config.get('cost', {}).get('projectId', '')
    if not re.fullmatch(r'staging/[a-z0-9._/-]{1,70}', project):
        raise OpsError('RECOVERY_PROJECT_INVALID')
    db = database('staging')
    trusted_known = (expected_atoms is not None and CONFIRMED_UNBILLED_HOLDS.get(request_id) == expected_atoms
                     and project == CONFIRMED_PROJECT)
    if expected_atoms is not None and not trusted_known:
        raise OpsError('CONFIRMED_HOLD_SCOPE_INVALID')
    row = json.loads(sql(db, "SELECT row_to_json(t) FROM (SELECT d.email,c.reserved_atoms::text,c.state,c.settled_atoms::text,r.state AS request_state FROM commerce.ai_cost_reservation c JOIN commerce.account_directory d USING(user_id) JOIN commerce.analyzer_request r USING(user_id,request_id,step) WHERE c.request_id='" + request_id + "' AND c.step='assistant_0' AND c.project_id='" + project + "')t;") or 'null')
    if not row:
        if trusted_known:
            result = {'requestId':request_id,'status':'NOT_FOUND_REQUIRES_REVIEW','paidCalls':0}
            emit('operator-hold-reconciliation', **result)
            return result
        raise OpsError('HOLD_NOT_IN_CONFIGURED_TEST_SCOPE')
    if expected_atoms is not None and row['reserved_atoms'] != expected_atoms:
        raise OpsError('CONFIRMED_HOLD_AMOUNT_CHANGED')
    # A repeated installation must not release/subtract an already released hold again.
    if trusted_known and row['state'] == 'released' and row['settled_atoms'] == '0' and row['request_state'] == 'failed':
        result = {'requestId':request_id,'status':'ALREADY_RELEASED','paidCalls':0}
        emit('operator-hold-reconciliation', **result)
        return result
    if not trusted_known and row['email'].lower() not in [x.lower() for x in config.get('allowedEmails', [])]:
        raise OpsError('HOLD_NOT_IN_CONFIGURED_TEST_SCOPE')
    path = Path(__file__).resolve().parents[1] / 'reconcile-assistant-reservation-staging.py'
    spec = importlib.util.spec_from_file_location('operator_unbilled_reconciliation', path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    query = helper.query(row['email'], request_id, row['reserved_atoms'])
    preview = json.loads(sql(db, query))
    if confirmed_unbilled:
        helper.attest(request_id, row['reserved_atoms'])
        result = json.loads(sql(db, helper.query(row['email'], request_id, row['reserved_atoms'], True)))
    else:
        result = preview
    emit('operator-hold-reconciliation', paidCalls=0, ownerUnbilledDeclaration=confirmed_unbilled, **result)
    return result


def resolve_confirmed_holds(confirmed_unbilled=False):
    """Only the two exact UUID/amount pairs authorized by the owner on 24 Nov."""
    results = [resolve_hold(request_id, confirmed_unbilled, expected_atoms=atoms)
               for request_id, atoms in CONFIRMED_UNBILLED_HOLDS.items()]
    emit('confirmed-holds-summary', ownerUnbilledDeclaration=confirmed_unbilled,
         knownHoldsResolved=all(x.get('status') in ('RELEASED','ALREADY_RELEASED') for x in results),
         requests=results, paidCalls=0)
    return results


def inspect_storage():
    for environment in ('staging', 'production'):
        db = database(environment)
        report = json.loads(sql(db, """BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
SELECT json_build_object('databaseBytes',pg_database_size(current_database()),
 'tables',COALESCE((SELECT json_agg(t) FROM (
 SELECT schemaname,relname,pg_total_relation_size(relid) AS total_bytes,
 pg_indexes_size(relid) AS index_bytes,n_live_tup AS estimated_rows
 FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20)t),'[]'::json));
ROLLBACK;"""))
        report['mounts'] = [{'source': x.get('Source'), 'destination': x.get('Destination'), 'type': x.get('Type')} for x in db['mounts']]
        emit('database-storage', environment=environment, **report)


def probe_cloudru():
    helper = Path(__file__).resolve().parents[1] / 'diagnose-assistant-post-staging.py'
    result = json.loads(run(['/usr/bin/python3', '-B', helper], timeout=25))
    result = {'provider': 'cloud.ru', 'keyAcceptedAtCompletionEndpoint': result.get('reason') == 'INVALID_PAYLOAD_EXPECTED', **result}
    private_write(STATE / 'provider-key-check.json', json.dumps(result))
    emit('provider-key', **result)
    return result


def probe_key():
    """Compatibility alias: this installation uses the existing Cloud.ru key."""
    return probe_cloudru()
