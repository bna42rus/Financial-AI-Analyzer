"""Encrypted restic repositories, bounded retention and isolated restore tests.

Databases, global role definitions and an explicit configuration allowlist only.
No raw statement files, release directories, Docker volumes or KMS RSA credentials.
"""
from contextlib import nullcontext
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat

from .common import CONFIG, ENVIRONMENTS, STATE, OpsError, cleanup_isolated_container, database, emit, locked, private_dir, private_read, private_write, run, settings, sql, start_isolated_postgres

BACKUP_LOCK = Path('/run/lock/cashneuro-backup.lock')
HOST = 'cashneuro'
RESTIC_BIN = '/usr/bin/restic'


def validate_config(value):
    if value.get('version') != 'cashneuro-ops/1' or value.get('endpoint') != 'https://s3.twcstorage.ru':
        raise OpsError('BACKUP_CONFIGURATION_INVALID')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', value.get('bucket', '')):
        raise OpsError('BUCKET_NAME_INVALID')
    for name in ('accessKey', 'secretKey', 'password'):
        secret = value.get(name)
        if not isinstance(secret, str) or not 16 <= len(secret) <= 4096 or '\x00' in secret or '\n' in secret:
            raise OpsError('BACKUP_CREDENTIAL_INVALID')
    quota = value.get('quotaBytes')
    if not isinstance(quota, int) or isinstance(quota, bool) or not 1000**3 <= quota <= 20000 * 1000**3:
        raise OpsError('BACKUP_QUOTA_INVALID')
    if value.get('policy') != {'productionDaily': 7, 'predeploy': 2, 'stagingPredeploy': 2}:
        raise OpsError('BACKUP_POLICY_CHANGED')
    return value


def restic_env(config, environment, journal=False):
    validate_config(config)
    if environment not in ENVIRONMENTS:
        raise OpsError('ENVIRONMENT_INVALID')
    suffix = environment + ('-deletion-journal' if journal else '')
    # Independent repository encryption keys; the recovery passphrase is kept offline by the owner.
    clean = {k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL','TMPDIR')}
    return {**clean, 'AWS_ACCESS_KEY_ID': config['accessKey'], 'AWS_SECRET_ACCESS_KEY': config['secretKey'],
            'AWS_DEFAULT_REGION': 'ru-1', 'RESTIC_PASSWORD': config['password'],
            'RESTIC_REPOSITORY': 's3:' + config['endpoint'] + '/' + config['bucket'] + '/cashneuro-backups-v1/' + suffix,
            'RESTIC_CACHE_DIR': str(STATE / 'restic-cache' / suffix)}


def restic(config, environment, args, *, journal=False, cwd=None, output=None, timeout=1800):
    return run([RESTIC_BIN, '--no-lock' if args and args[0] == 'version' else '--retry-lock',
                *([] if args and args[0] == 'version' else ['30s']), *args],
               env=restic_env(config, environment, journal), cwd=cwd, output=output, timeout=timeout)


def initialize(config, environment, journal=False):
    emit('repository-check', environment=environment, purpose='deletion-journal' if journal else 'database')
    env = restic_env(config, environment, journal)
    # Never initialize over an inaccessible existing repository. Only an absent config may be new.
    import subprocess
    probe = subprocess.run([RESTIC_BIN, 'cat', 'config'], env=env, capture_output=True, timeout=60)
    if probe.returncode == 0:
        return
    # Restic exit code 10 specifically identifies a missing repository (>=0.17).
    if probe.returncode != 10:
        raise OpsError('REPOSITORY_ACCESS_FAILED')
    restic(config, environment, ['init', '--repository-version', '2'], journal=journal)


def snapshot_id(output):
    for line in reversed(output.decode().splitlines()):
        value = json.loads(line)
        if value.get('message_type') == 'summary' and re.fullmatch('[a-f0-9]{8,64}', value.get('snapshot_id', '')):
            return value['snapshot_id']
    raise OpsError('BACKUP_SNAPSHOT_NOT_CONFIRMED')


def snapshot_files(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise OpsError('BACKUP_SYMLINK_DENIED')
        if path.is_file() and path.name != 'manifest.json':
            h = hashlib.sha256()
            with path.open('rb') as stream:
                for part in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(part)
            result[str(path.relative_to(root))] = {'bytes': path.stat().st_size, 'sha256': h.hexdigest()}
    return result


def prune_local_deploy_dumps(root=Path('/var/lib/cashneuro'), keep=2):
    """Only old pg_dump files from this project's known staging installers."""
    candidates = []
    if not root.is_dir() or root.resolve() != root:
        raise OpsError('LOCAL_BACKUP_ROOT_INVALID')
    for directory in root.iterdir():
        if not re.fullmatch(r'(?:connected-release-[a-f0-9]{12}-[A-Za-z0-9_-]+|assistant-install-[a-f0-9]{12}-[0-9]+)', directory.name):
            continue
        if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != 0 or directory.stat().st_mode & 0o022:
            raise OpsError('LOCAL_BACKUP_DIRECTORY_UNSAFE')
        path = directory / 'database.dump'
        if not path.exists():
            continue
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077 or stream.read(5) != b'PGDMP':
                raise OpsError('LOCAL_DATABASE_DUMP_INVALID')
        candidates.append(path)
    candidates.sort(key=lambda p: (p.stat().st_mtime_ns, str(p)), reverse=True)
    for path in candidates[keep:]:
        # Keep rollback metadata and cost/key audit records, remove only the DB archive.
        private_write(path.parent / 'database-dump-pruned.json', json.dumps({'reason':'verified encrypted S3 copy + bounded local retention', 'keptLocalDumps':keep}))
        path.unlink()
    emit('local-staging-dump-retention', kept=min(keep,len(candidates)), removed=max(0,len(candidates)-keep))


def configuration_files(environment):
    paths = [Path('/etc/caddy/Caddyfile')]
    paths += sorted(Path('/etc/cashneuro', environment).glob('*.env'))
    paths += sorted(Path('/etc/cashneuro/kms', environment).glob('*/wrapping-key.json'))
    paths += [Path('/etc/cashneuro/mail', environment + '-postbox.json')]
    if environment == 'staging':
        paths += [Path('/etc/cashneuro/ai/assistant-staging.json')]
    paths += sorted(Path('/etc/systemd/system').glob('cashneuro-' + environment + '*.service'))
    paths += sorted(Path('/etc/systemd/system').glob('cashneuro-' + environment + '*.service.d/*.conf'))
    return [p for p in paths if p.exists()]


def copy_configuration(root, environment):
    for path in configuration_files(environment):
        # Configurations may be 0644. Backups are always created 0600 in a 0700 directory.
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 1024 * 1024 or path.resolve() != path:
            raise OpsError('CONFIGURATION_FILE_UNSAFE')
        destination = root / 'configuration' / path.relative_to('/')
        private_dir(destination.parent)
        private_write(destination, path.read_bytes())
    # RSA credentials are recovered separately through Yandex Cloud, not this archive.
    wrapping = list(Path('/etc/cashneuro/kms', environment).glob('*/wrapping-key.json'))
    if environment == 'staging' and len(wrapping) != 2:
        raise OpsError('KMS_WRAPPING_RECORDS_MISSING')


def read_journal_source(db):
    present = json.loads(sql(db, "SELECT json_build_object('erasure',to_regclass('identity.erasure_evidence') IS NOT NULL,'workspace',to_regclass('finance.workspace') IS NOT NULL);"))
    erased = json.loads(sql(db, "SELECT COALESCE(json_agg(json_build_object('id',id,'userId',former_user_id,'erasedAt',erased_at) ORDER BY erased_at,id),'[]'::json) FROM identity.erasure_evidence;")) if present['erasure'] else []
    workspaces = json.loads(sql(db, "SELECT COALESCE(json_agg(json_build_object('userId',user_id,'generation',generation,'keyVersion',key_version,'revision',revision) ORDER BY user_id),'[]'::json) FROM finance.workspace;")) if present['workspace'] else []
    return {'erased': erased, 'workspaces': workspaces, 'schema': present}


def merge_journal(previous, current, environment):
    if previous and (previous.get('version') != 'cashneuro-deletions/1' or previous.get('environment') != environment):
        raise OpsError('DELETION_JOURNAL_INVALID')
    erased = {x['id']: x for x in (previous or {}).get('erased', [])}
    for value in current['erased']:
        if value['id'] in erased and erased[value['id']] != value:
            raise OpsError('DELETION_JOURNAL_CONFLICT')
        erased[value['id']] = value
    # Preserve old generations as tombstones, even after later account deletion.
    workspaces = [{k:v for k,v in x.items() if k != 'revision'} for x in current['workspaces']]
    generations = {(x['userId'], x['generation']): x for x in (previous or {}).get('generations', [])}
    for value in workspaces:
        generations[(value['userId'], value['generation'])] = value
    return {'version': 'cashneuro-deletions/1', 'environment': environment,
            'observedAt': datetime.now(timezone.utc).isoformat(),
            'erased': sorted(erased.values(), key=lambda x: x['id']),
            'generations': sorted(generations.values(), key=lambda x: (x['userId'], x['generation'])),
            'currentWorkspaces': workspaces, 'schema': current['schema']}


def journal(config, environment, db=None):
    db = db or database(environment)
    snapshots = json.loads(restic(config, environment, ['snapshots', '--json'], journal=True))
    previous = None
    if snapshots:
        latest = max(snapshots, key=lambda x: x['time'])
        previous = json.loads(restic(config, environment, ['dump', latest['id'], '/journal.json'], journal=True))
    result = merge_journal(previous, read_journal_source(db), environment)
    root = private_dir(STATE / 'work' / (environment + '-journal'))
    try:
        private_write(root / 'journal.json', json.dumps(result, sort_keys=True))
        sid = snapshot_id(restic(config, environment, ['backup', '--json', '--host', HOST, '--tag', 'deletion-journal', 'journal.json'], journal=True, cwd=root))
        if json.loads(restic(config, environment, ['dump', sid, '/journal.json'], journal=True)) != result:
            raise OpsError('DELETION_JOURNAL_VERIFY_FAILED')
        restic(config, environment, ['forget', '--tag', 'deletion-journal', '--group-by', '', '--keep-last', '2', '--prune'], journal=True)
    finally:
        if (root / 'journal.json').exists():
            (root / 'journal.json').unlink()
    return result


def backup(config, environment, kind, *, already_locked=False):
    if kind not in ('daily', 'predeploy') or environment == 'staging' and kind != 'predeploy':
        raise OpsError('BACKUP_KIND_INVALID')
    with nullcontext() if already_locked else locked():
        with locked(BACKUP_LOCK):
            db = database(environment)
            current_journal = journal(config, environment, db)
            if current_journal.get('currentWorkspaces') and len(list(Path('/etc/cashneuro/kms', environment).glob('*/wrapping-key.json'))) != 2:
                raise OpsError('KMS_WRAPPING_RECORDS_MISSING')
            root = private_dir(STATE / 'work' / environment)
            if list(root.iterdir()):
                raise OpsError('PREVIOUS_BACKUP_WORK_REQUIRES_REVIEW')
            try:
                size = int(sql(db, 'SELECT pg_database_size(current_database());'))
                if shutil.disk_usage(root).free < size * 2 + 512 * 1024**2:
                    raise OpsError('BACKUP_DISK_HEADROOM_LOW')
                emit('backup-dump', environment=environment, databaseBytes=size)
                for filename, command in (
                    ('database.dump', ['pg_dump', '-Fc', '-U', db['owner'], '-d', db['database']]),
                    ('roles.sql', ['pg_dumpall', '--globals-only', '-U', db['owner']]),
                ):
                    with (root / filename).open('xb') as stream:
                        os.chmod(root / filename, 0o600)
                        run(['docker', 'exec', db['container'], *command], output=stream, timeout=1800)
                # The dump must have a readable TOC before any upload/retention action.
                with (root / 'database.dump').open('rb') as stream:
                    run(['docker', 'exec', '-i', db['container'], 'pg_restore', '--list'], input_file=stream, timeout=120)
                copy_configuration(root, environment)
                table_sizes = json.loads(sql(db, "SELECT COALESCE(json_agg(t),'[]'::json) FROM (SELECT schemaname,relname,pg_total_relation_size(relid) AS bytes FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20)t;"))
                manifest = {'version': 'cashneuro-backup/1', 'environment': environment, 'database': db['database'],
                            'kind': kind, 'createdAt': datetime.now(timezone.utc).isoformat(),
                            'databaseBytes': size, 'files': snapshot_files(root), 'largestTables': table_sizes,
                            'services': run(['systemctl', 'show', 'cashneuro-' + environment + '-*', '-p', 'Id', '-p', 'WorkingDirectory']).decode(),
                            'recovery': 'Isolated restore + independent deletion-journal check required before public start. KMS RSA access recovered separately.'}
                private_write(root / 'manifest.json', json.dumps(manifest, sort_keys=True))
                # A declared quota is a guard, never a purchase or bucket auto-upgrade.
                existing = json.loads(restic(config, environment, ['snapshots', '--json']))
                raw = json.loads(restic(config, environment, ['stats', '--mode', 'raw-data', '--json'])) if existing else {'total_size': 0}
                estimate = sum(p.stat().st_size for p in root.rglob('*') if p.is_file())
                # Split the configured bucket cap across both DB and both journal repositories.
                if int(raw.get('total_size', 0)) + estimate * 2 + 32 * 1024**2 > config['quotaBytes'] // 2:
                    raise OpsError('BACKUP_DECLARED_CAPACITY_LOW')
                emit('backup-upload', environment=environment, archiveBytes=estimate)
                output = restic(config, environment, ['backup', '--json', '--host', HOST, '--tag', kind, '.'], cwd=root)
                sid = snapshot_id(output)
                saved = json.loads(restic(config, environment, ['dump', sid, '/manifest.json']))
                if saved != manifest:
                    raise OpsError('BACKUP_MANIFEST_MISMATCH')
                restic(config, environment, ['check'])
                # Forget only after a new readable, structurally verified snapshot exists.
                keep = 7 if kind == 'daily' else 2
                restic(config, environment, ['forget', '--tag', kind, '--host', HOST, '--group-by', '', '--keep-last', str(keep), '--prune'])
                restic(config, environment, ['check'])
                result = {'ok': True, 'snapshot': sid, 'environment': environment, 'kind': kind,
                          'at': datetime.now(timezone.utc).isoformat(), 'databaseBytes': size,
                          'dumpBytes': (root / 'database.dump').stat().st_size}
                private_write(STATE / ('backup-' + environment + '.json'), json.dumps(result))
                if environment == 'staging':
                    prune_local_deploy_dumps()
                emit('backup-complete', **result)
                return result
            finally:
                shutil.rmtree(root)


def restore_test(config, environment):
    """Restore into an ephemeral, network-isolated PostgreSQL, never into live DBs."""
    with locked():
        with locked(BACKUP_LOCK):
            memory = re.search(r'^MemAvailable:\s+(\d+) kB', Path('/proc/meminfo').read_text(), re.M)
            if not memory or int(memory[1]) < 768 * 1024:
                raise OpsError('RESTORE_MEMORY_HEADROOM_LOW')
            live = database(environment)
            snapshots = json.loads(restic(config, environment, ['snapshots', '--json']))
            if not snapshots:
                raise OpsError('NO_BACKUP_TO_TEST')
            sid = max(snapshots, key=lambda x: x['time'])['id']
            root = private_dir(STATE / 'restore-test' / environment)
            if list(root.iterdir()):
                raise OpsError('PREVIOUS_RESTORE_TEST_REQUIRES_REVIEW')
            container = 'cashneuro-restore-' + secrets.token_hex(8)
            try:
                emit('restore-download', environment=environment, snapshot=sid)
                restic(config, environment, ['restore', sid, '--target', str(root)], timeout=3600)
                manifest = json.loads(private_read(root / 'manifest.json'))
                if manifest.get('environment') != environment or manifest.get('database') != live['database'] or snapshot_files(root) != manifest.get('files'):
                    raise OpsError('RESTORED_FILE_HASH_MISMATCH')
                if shutil.disk_usage(root).free < int(manifest['databaseBytes']) * 2 + 512 * 1024**2:
                    raise OpsError('RESTORE_DISK_HEADROOM_LOW')
                # No network, published ports, restart policy, live volumes or application workers.
                test = start_isolated_postgres(container, root / 'pgdata', live['image'], 'cashneuro_restore')
                roles = json.loads(sql(live, "SELECT COALESCE(json_agg(rolname),'[]'::json) FROM pg_roles WHERE rolname !~ '^pg_' AND rolname<>'cashneuro_restore';"))
                for role in roles:
                    sql(test, 'CREATE ROLE "' + role.replace('"', '""') + '";')
                sql(test, 'CREATE DATABASE cashneuro_restore_test;')
                test['database'] = 'cashneuro_restore_test'
                emit('restore-postgres', environment=environment, snapshot=sid, network='none')
                with (root / 'database.dump').open('rb') as stream:
                    run(['docker', 'exec', '-i', container, 'pg_restore', '--no-owner', '--no-privileges', '--exit-on-error',
                         '-U', test['owner'], '-d', test['database']], input_file=stream, timeout=3600)
                count = int(sql(test, "SELECT count(*) FROM pg_class WHERE relkind='r';"))
                result = {'ok': True, 'environment': environment, 'snapshot': sid, 'tables': count,
                          'at': datetime.now(timezone.utc).isoformat(), 'publicAccess': False,
                          'productionRestoreAuthorized': False}
                # Checking is deliberately separate from opening a restored service.
                current = journal(config, environment, live)
                restored = read_journal_source(test)
                restored_ids = {x['userId'] for x in restored['workspaces']}
                erasures = {x['userId'] for x in current['erased']}
                result['erasedAccountsPresentInOldSnapshot'] = len(restored_ids & erasures)
                now_generations = {x['userId']: x['generation'] for x in current['currentWorkspaces']}
                result['changedGenerations'] = sum(x['userId'] in now_generations and x['generation'] != now_generations[x['userId']] for x in restored['workspaces'])
                private_write(STATE / ('restore-test-' + environment + '.json'), json.dumps(result))
                emit('isolated-restore-test', **result)
                return result
            finally:
                try:
                    cleanup_isolated_container(container)
                except Exception:
                    emit('isolated-cleanup-required', container=container)
                    raise OpsError('ISOLATED_CONTAINER_CLEANUP_REQUIRED') from None
                shutil.rmtree(root)


def alert(config, code):
    """One operational email to the configured owner, no database/provider details."""
    import smtplib
    import ssl
    from email.message import EmailMessage
    recipient = config.get('alertEmail', '')
    if not re.fullmatch(r'[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+', recipient):
        raise OpsError('ALERT_RECIPIENT_MISSING')
    secret = json.loads(private_read('/etc/cashneuro/mail/staging-postbox.json'))
    message = EmailMessage()
    message['From'] = 'CashNeuro <notifications@cashneuro.ru>'
    message['To'] = recipient
    message['Subject'] = 'CashNeuro: ошибка резервного копирования'
    message.set_content('Автоматическая проверка резервных копий завершилась ошибкой ' + code + '.\nПроверьте sudo cashneuro-ops status. Данные и ключи в это письмо не включаются.')
    with smtplib.SMTP_SSL('postbox.cloud.yandex.net', 465, timeout=10, context=ssl.create_default_context()) as smtp:
        smtp.login(secret['username'], secret['password'])
        smtp.send_message(message)
