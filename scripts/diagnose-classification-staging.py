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
    query = """BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='2s';
SELECT json_build_object('databaseMatches',current_database()='finance_staging',
 'classificationMigrationPresent',to_regclass('finance.classification_run') IS NOT NULL,
 'receipts',COALESCE((SELECT json_agg(t) FROM (
  SELECT r.created_at,r.state,r.usage_state,r.input_tokens,r.output_tokens,c.state AS cost_state
  FROM commerce.analyzer_request r LEFT JOIN commerce.ai_cost_reservation c
  USING(user_id,request_id,step)
  WHERE r.provider='cashneuro-category-smoke/1'
  AND r.created_at>=to_timestamp(1792231353)
  ORDER BY r.created_at DESC LIMIT 10
 )t),'[]'::json));
ROLLBACK;
"""
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
