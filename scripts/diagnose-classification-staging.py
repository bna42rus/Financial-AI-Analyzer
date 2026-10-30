"""Bounded, read-only technical receipts. No model calls or service changes."""
import datetime
import json
import os
from pathlib import Path
import re
import stat
import subprocess


class InspectionError(Exception):
    pass


def emit(step, **values):
    print(json.dumps({'step': step, **values}, ensure_ascii=False), flush=True)


def command(args, *, data=None, timeout=6):
    try:
        result = subprocess.run(args, input=data, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise InspectionError('COMMAND_TIMEOUT') from None
    except OSError:
        raise InspectionError('COMMAND_UNAVAILABLE') from None
    if result.returncode:
        # Neither stderr nor arbitrary exception text may contain credentials.
        raise InspectionError('COMMAND_EXIT_' + str(result.returncode))
    return result.stdout


def receipt_query(settings):
    emails = settings.get('allowedEmails')
    cost = settings.get('cost', {})
    if (not isinstance(emails, list) or not 1 <= len(emails) <= 100
            or any(not isinstance(v, str) or not 1 <= len(v) <= 254 for v in emails)
            or not isinstance(cost, dict)):
        raise InspectionError('CONFIGURATION_SCOPE_INVALID')
    # Only the account selector and budget key enter SQL. API keys, arbitrary
    # configuration and request/answer payloads never leave their private files.
    scope = json.dumps({'emails': emails, 'project': cost.get('projectId'),
                        'period': cost.get('projectPeriodStart')}).replace("'", "''")
    return """BEGIN READ ONLY;
SET LOCAL standard_conforming_strings=on;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='2s';
WITH config AS (SELECT '%s'::jsonb AS value),
 test_account AS (
  SELECT id FROM identity.auth_user
  WHERE email_verified AND email IN (
   SELECT jsonb_array_elements_text(value->'emails') FROM config)
  ORDER BY id LIMIT 1
 ), blockers AS (
  SELECT r.request_id,r.step,r.created_at,r.dispatched_at,r.state,r.provider,
   r.usage_state,r.input_tokens,r.output_tokens,r.model_version,
   c.state AS cost_state,c.reserved_atoms::text,c.settled_atoms::text,
   c.reported_input_tokens,c.reported_output_tokens,c.reported_model_version,
   c.project_id,c.project_period_start,c.request_id IS NULL AS missing_cost_receipt
  FROM commerce.analyzer_request r LEFT JOIN commerce.ai_cost_reservation c
  USING(user_id,request_id,step)
  WHERE r.user_id=(SELECT id FROM test_account)
   AND (r.state='sent' OR r.usage_state='unknown')
 )
SELECT json_build_object('databaseMatches',current_database()='finance_staging',
 'classificationMigrationPresent',to_regclass('finance.classification_run') IS NOT NULL,
 'testAccountFound',EXISTS(SELECT 1 FROM test_account),
 'blockingCount',(SELECT count(*) FROM blockers),
 'blockingRequests',COALESCE((SELECT json_agg(t) FROM (
  SELECT * FROM blockers ORDER BY created_at,request_id,step LIMIT 30
 )t),'[]'::json),
 'openReservationCount',(SELECT count(*) FROM commerce.ai_cost_reservation c
  WHERE c.user_id=(SELECT id FROM test_account) AND c.state IN ('reserved','unknown')),
 'openReservations',COALESCE((SELECT json_agg(t) FROM (
  SELECT c.request_id,c.step,c.created_at,c.state,c.project_id,c.project_period_start,
   c.reserved_atoms::text,c.settled_atoms::text,
   c.quoted_input_tokens,c.quoted_output_tokens,c.quoted_model_version,
   c.reported_input_tokens,c.reported_output_tokens,c.reported_model_version
  FROM commerce.ai_cost_reservation c
  WHERE c.user_id=(SELECT id FROM test_account) AND c.state IN ('reserved','unknown')
  ORDER BY c.created_at,c.request_id,c.step LIMIT 30
 )t),'[]'::json),
 'currentProjectBudget',(SELECT row_to_json(t) FROM (
  SELECT b.project_id,b.period_start,b.period_end,b.limit_atoms::text,
   b.spent_atoms::text,b.reserved_atoms::text,b.blocked
  FROM commerce.ai_project_budget b,config
  WHERE b.project_id=config.value->>'project'
   AND b.period_start=(config.value->>'period')::timestamptz
 )t),
 'receipts',COALESCE((SELECT json_agg(t) FROM (
  SELECT r.created_at,r.state,r.usage_state,r.input_tokens,r.output_tokens,c.state AS cost_state
  FROM commerce.analyzer_request r LEFT JOIN commerce.ai_cost_reservation c
  USING(user_id,request_id,step)
  WHERE r.provider='cashneuro-category-smoke/1'
   AND r.user_id=(SELECT id FROM test_account)
  ORDER BY r.created_at DESC,r.request_id LIMIT 10
 )t),'[]'::json));
ROLLBACK;
""" % scope


def inspect():
    if os.geteuid() != 0:
        raise InspectionError('ROOT_REQUIRED')
    emit('1/4', status='START', paidCalls=0)
    output = command(['systemctl', '--no-pager', 'show',
                      'cashneuro-staging-api@finance.service',
                      'cashneuro-staging-import.service', 'caddy.service',
                      '-p', 'Id', '-p', 'ActiveState', '-p', 'SubState',
                      '-p', 'Result', '-p', 'WorkingDirectory'])
    # Only known units, states and release paths leave this inspection.
    rows = []
    for block in output.strip().split('\n\n'):
        values = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        row = {k: v for k, v in values.items()
               if k in {'Id', 'ActiveState', 'SubState', 'Result'} and re.fullmatch(r'[A-Za-z0-9@._-]{1,100}', v)}
        directory = values.get('WorkingDirectory', '')
        if re.fullmatch(r'/srv/cashneuro/staging/(backend-current|backend-releases/[a-f0-9]{40})/apps/api', directory):
            row['WorkingDirectory'] = directory
        rows.append(row)
    emit('1/4', status='OK', services=rows)

    emit('2/4', status='START')
    path = Path('/etc/cashneuro/ai/assistant-staging.json')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 65536:
        raise InspectionError('PRIVATE_CONFIGURATION_REQUIRED')
    settings = json.loads(path.read_text())
    now = datetime.datetime.now(datetime.timezone.utc)
    def stamp(key):
        value = settings.get(key)
        if not isinstance(value, str):
            raise InspectionError('CONFIGURATION_TIMESTAMP_INVALID')
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise InspectionError('CONFIGURATION_TIMESTAMP_INVALID')
        return parsed
    emit('2/4', status='OK', admissionExpired=stamp('expiresAt') <= now,
         tariffOlderThan24Hours=(now - stamp('tariffCheckedAt')).total_seconds() > 86400)

    emit('3/4', status='START')
    identifiers = command(['docker', 'ps', '--format', '{{.ID}}']).splitlines()
    if len(identifiers) > 30 or any(not re.fullmatch('[a-f0-9]{12,64}', v) for v in identifiers):
        raise InspectionError('CONTAINER_LAYOUT_UNEXPECTED')
    if not identifiers:
        raise InspectionError('STAGING_DATABASE_NOT_FOUND')
    ports = command(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', *identifiers]).splitlines()
    if len(ports) != len(identifiers):
        raise InspectionError('CONTAINER_LAYOUT_UNEXPECTED')
    selected = [identifier for identifier, raw in zip(identifiers, ports)
                if any(p.get('HostIp') == '127.0.0.1' and p.get('HostPort') == '5411'
                       for p in (json.loads(raw) or {}).get('5432/tcp') or [])]
    if len(selected) != 1:
        raise InspectionError('STAGING_DATABASE_LAYOUT_CHANGED')
    emit('3/4', status='OK', database='finance_staging', port=5411)

    emit('4/4', status='START')
    query = receipt_query(settings)
    output = command(['docker', 'exec', '-i', selected[0], 'sh', '-c',
                      'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" '
                      '-d finance_staging -Atq'], data=query, timeout=9)
    report = json.loads(output)
    emit('4/4', status='OK', **report)
    emit('DONE', paidCalls=0)


def main():
    try:
        inspect()
        return 0
    except InspectionError as error:
        emit('STOP', code=str(error), paidCalls=0)
    except (OSError, ValueError, TypeError, AttributeError):
        emit('STOP', code='INSPECTION_DATA_UNAVAILABLE', paidCalls=0)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
