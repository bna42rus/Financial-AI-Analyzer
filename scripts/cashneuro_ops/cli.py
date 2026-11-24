import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys

from . import backups, capacity, diagnostics, installation, releases, sizing
from .common import CONFIG, STATE, OpsError, emit, locked, private_dir, private_read, private_write, require_root, settings


def state():
    report = {'configured': CONFIG.exists(), 'backups': {}, 'restoreTests': {}, 'capacityStopEnabled':False}
    for environment in ('staging', 'production'):
        for prefix, key in [('backup-', 'backups'), ('restore-test-', 'restoreTests')]:
            path = STATE / (prefix + environment + '.json')
            report[key][environment] = json.loads(private_read(path)) if path.exists() else None
    failure = STATE / 'last-failure.json'
    report['lastFailure'] = json.loads(private_read(failure)) if failure.exists() else None
    for filename,key in [('provider-key-check.json','providerKeyCheck'),('synthetic-sizing.json','syntheticSizing'),('storage-capacity.json','storageCapacity'),('storage-last-alert.json','storageGrowthAlert')]:
        path = STATE / filename
        report[key] = json.loads(private_read(path)) if path.exists() else None
    return report


def watchdog(config):
    report = state()
    now = datetime.now(timezone.utc)
    production = report['backups']['production']
    if not production or (now - datetime.fromisoformat(production['at'])).total_seconds() > 36 * 3600:
        raise OpsError('PRODUCTION_BACKUP_STALE')
    for result in report['restoreTests'].values():
        if not result or (now - datetime.fromisoformat(result['at'])).total_seconds() > 40 * 86400:
            raise OpsError('RESTORE_TEST_STALE')
    if report['lastFailure'] and not report['lastFailure'].get('resolved'):
        raise OpsError('BACKUP_FAILURE_UNRESOLVED')
    emit('watchdog', ok=True)


def scheduled(name):
    config = backups.validate_config(settings())
    if name == 'production':
        backups.backup(config, 'production', 'daily')
        capacity.monitor(config)
    elif name in ('restore-production', 'restore-staging'):
        backups.restore_test(config, name.removeprefix('restore-'))
    elif name == 'journal':
        with locked():
            with locked(backups.BACKUP_LOCK):
                for environment in ('staging', 'production'):
                    result = backups.journal(config, environment)
                    emit('deletion-journal', environment=environment, erasedAccounts=len(result['erased']),
                         trackedGenerations=len(result['generations']))
    elif name == 'watchdog':
        capacity.monitor(config)
        watchdog(config)
    else:
        raise OpsError('SCHEDULE_INVALID')


def failure(code, operation):
    private_dir(STATE)
    record = {'code': code, 'operation': operation, 'at': datetime.now(timezone.utc).isoformat(), 'resolved': False}
    private_write(STATE / 'last-failure.json', json.dumps(record))
    # One incident notification per day, even if the hourly watchdog repeats it.
    notified = STATE / 'last-alert.json'
    previous = json.loads(private_read(notified)) if notified.exists() else None
    if previous and (datetime.now(timezone.utc) - datetime.fromisoformat(previous['at'])).total_seconds() < 86400:
        return
    private_write(notified, json.dumps(record))
    try:
        backups.alert(settings(), code)
        emit('backup-alert', accepted=True)
    except Exception:
        emit('backup-alert', accepted=False, code='ALERT_DELIVERY_NOT_CONFIRMED')


def operation_name(args):
    if args.command == 'scheduled':
        return 'scheduled:' + args.name
    if args.command in ('backup','restore-test'):
        return args.command + ':' + args.environment
    return args.command


def success(operation):
    path = STATE / 'last-failure.json'
    if path.exists():
        value = json.loads(private_read(path))
        if value.get('operation') == operation and not value.get('resolved'):
            value['resolved'] = True
            private_write(path,json.dumps(value))


def main():
    parser = argparse.ArgumentParser(description='CashNeuro operator maintenance; credentials never go in arguments.')
    sub = parser.add_subparsers(dest='command', required=True)
    prune = sub.add_parser('prune')
    prune.add_argument('--apply', action='store_true')
    prune.add_argument('--deployment-lock-held', action='store_true')
    sub.add_parser('setup')
    configure = sub.add_parser('configure')
    configure.add_argument('--replace', action='store_true')
    sub.add_parser('status')
    sub.add_parser('storage')
    sub.add_parser('capacity')
    diag = sub.add_parser('diagnose')
    diag.add_argument('--settle-recorded-usage', action='store_true')
    hold = sub.add_parser('resolve-hold')
    hold.add_argument('request_id')
    hold.add_argument('--confirm-provider-unbilled', action='store_true')
    confirmed = sub.add_parser('resolve-confirmed-holds')
    confirmed.add_argument('--confirm-provider-unbilled', action='store_true')
    sub.add_parser('probe-cloudru')
    sub.add_parser('probe-key')
    sub.add_parser('benchmark')
    backup = sub.add_parser('backup')
    backup.add_argument('environment', choices=['staging', 'production'])
    backup.add_argument('--kind', choices=['daily', 'predeploy'], default='predeploy')
    backup.add_argument('--deployment-lock-held', action='store_true')
    restore = sub.add_parser('restore-test')
    restore.add_argument('environment', choices=['staging', 'production'])
    schedule = sub.add_parser('scheduled')
    schedule.add_argument('name', choices=['production', 'journal', 'restore-production', 'restore-staging', 'watchdog'])
    sub.add_parser('resolve-alert')
    args = parser.parse_args()
    try:
        require_root()
        os.umask(0o077)
        if args.command == 'prune':
            releases.prune(apply=args.apply, already_locked=args.deployment_lock_held)
        elif args.command == 'setup':
            installation.setup()
        elif args.command == 'configure':
            installation.configure(args.replace)
        elif args.command == 'status':
            emit('maintenance-status', **state())
        elif args.command == 'storage':
            diagnostics.inspect_storage()
        elif args.command == 'capacity':
            capacity.monitor(backups.validate_config(settings()))
        elif args.command == 'diagnose':
            with locked():
                diagnostics.inspect_accounting(args.settle_recorded_usage)
        elif args.command == 'resolve-hold':
            diagnostics.resolve_hold(args.request_id,args.confirm_provider_unbilled)
        elif args.command == 'resolve-confirmed-holds':
            with locked():
                diagnostics.resolve_confirmed_holds(args.confirm_provider_unbilled)
        elif args.command == 'probe-cloudru':
            diagnostics.probe_cloudru()
        elif args.command == 'probe-key':
            diagnostics.probe_key()
        elif args.command == 'benchmark':
            sizing.benchmark()
        elif args.command == 'backup':
            config = backups.validate_config(settings())
            backups.backup(config, args.environment, args.kind, already_locked=args.deployment_lock_held)
            capacity.monitor(config)
        elif args.command == 'restore-test':
            backups.restore_test(backups.validate_config(settings()), args.environment)
        elif args.command == 'scheduled':
            scheduled(args.name)
        elif args.command == 'resolve-alert':
            watchdog({}) if not (STATE / 'last-failure.json').exists() else None
            path = STATE / 'last-failure.json'
            if path.exists():
                value = json.loads(private_read(path)); value['resolved'] = True
                private_write(path, json.dumps(value))
            emit('alert-resolved', ok=True)
        success(operation_name(args))
    except KeyboardInterrupt:
        emit('STOP', code='CANCELLED_BY_OPERATOR', paidCalls=0)
        raise SystemExit(130)
    except Exception as error:
        code = str(error) if isinstance(error, OpsError) and re.fullmatch('[A-Z0-9_]{1,100}', str(error)) else 'MAINTENANCE_FAILED'
        emit('STOP', code=code, paidCalls=0)
        if code == 'ANOTHER_OPERATION_RUNNING' and args.command == 'scheduled':
            emit('scheduled-skip', reason='deployment-or-backup-in-progress')
            return
        if args.command in ('scheduled', 'backup', 'restore-test'):
            failure(code, operation_name(args))
        raise SystemExit(1)
