"""Update the connected Staging UI/API without changing credentials or cost admission."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys
import time
from urllib.parse import urlsplit

# Root inspection must not create root-owned cache files in the user's build.
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('staging_install', Path(__file__).with_name('install-assistant-staging.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
WORKER = 'cashneuro-staging-import.service'
WORKER_UNIT = Path('/etc/systemd/system') / WORKER
WORKER_ENV = Path('/etc/cashneuro/staging/finance-import.env')


def settings():
    values = {}
    for line in Path('/etc/cashneuro/staging/finance-api.env').read_text().splitlines():
        match = re.fullmatch(r'\s*([A-Z_]+)\s*=\s*(.*?)\s*', line)
        if match:
            values[match[1]] = match[2].strip('\"\'')
    if values.get('APP_ENV') != 'staging' or values.get('API_PROFILE') != 'finance':
        raise m.InstallationError('STAGING_SETTINGS_CHANGED')
    validate_origin(values.get('API_BASE_URL', ''))
    url = urlsplit(values.get('DATABASE_URL', ''))
    if url.scheme not in ('postgres', 'postgresql') or url.hostname not in ('127.0.0.1', 'localhost') or url.port != 5411 or url.username != 'finance_api' or url.path != '/finance_staging' or url.query or url.fragment:
        raise m.InstallationError('SCOPED_STAGING_DATABASE_REQUIRED')
    return values


def validate_origin(value):
    url = urlsplit(value)
    if url.scheme != 'https' or url.hostname != 'test.cashneuro.ru' or url.port or url.username or url.password or url.query or url.fragment or url.path not in ('', '/', '/api', '/api/'):
        raise m.InstallationError('STAGING_API_ORIGIN_INVALID')
    return value.rstrip('/')


def validate_manifest(value, sha, origin):
    if value != {'schema': 'cashneuro-web-build/1', 'revision': sha, 'profile': 'finance', 'mode': 'connected', 'apiOrigin': origin}:
        raise m.InstallationError('CONNECTED_FRONTEND_REQUIRED')


def worker_unit(release):
    return ('[Unit]\nDescription=CashNeuro Staging import worker (Finance)\nAfter=network-online.target\nWants=network-online.target\n'
            '[Service]\nType=exec\nDynamicUser=yes\nSupplementaryGroups=cashneuro-staging-code\nWorkingDirectory=' + str(release / 'apps/api') + '\n'
            'EnvironmentFile=' + str(WORKER_ENV) + '\nExecStart=/usr/bin/node --import tsx src/import-main.ts\n'
            'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=yes\n'
            'ProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\nLimitCORE=0\nUMask=0077\n'
            '[Install]\nWantedBy=multi-user.target\n')


def snapshot(backup, name, path):
    if not path.exists():
        return None
    info = path.stat()
    m.private_write(backup / name, path.read_bytes())
    return {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}


def rebind_classification_settings(previous, installed_sha, next_sha):
    if previous.get('sourceSha256') != installed_sha or not re.fullmatch('[a-f0-9]{64}', next_sha):
        raise m.InstallationError('INSTALLED_ASSISTANT_BINDING_CHANGED')
    rebound = json.loads(json.dumps(previous))
    rebound['sourceSha256'] = next_sha
    return rebound


def restore(backup):
    metadata = json.loads((backup / 'rollback.json').read_text())
    if metadata.get('assistantConfig'):
        previous = metadata['assistantConfig']
        m.atomic_replace(m.CONFIG, (backup / 'assistantConfig').read_bytes(), previous['mode'], previous['uid'], previous['gid'])
    if metadata.get('workerManaged'):
        if WORKER_UNIT.exists():
            m.run(['systemctl', 'daemon-reload'])
            m.run(['systemctl', 'stop', WORKER])
            if not metadata.get('workerWasEnabled'):
                m.run(['systemctl', 'disable', WORKER])
        for name, path in [('workerUnit', WORKER_UNIT), ('workerEnv', WORKER_ENV)]:
            previous = metadata[name]
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                m.atomic_replace(path, (backup / name).read_bytes(), previous['mode'], previous['uid'], previous['gid'])
    m.restore(backup)
    if metadata.get('workerManaged') and metadata.get('workerWasActive'):
        m.run(['systemctl', 'start', WORKER])


def validate_admission_pair(previous, next_settings, fallback, installed_sha, tested_sha):
    if next_settings.get('sourceSha256') != tested_sha or fallback.get('sourceSha256') != installed_sha or {**fallback, 'sourceSha256': tested_sha} != next_settings:
        raise m.InstallationError('CLASSIFICATION_ADMISSION_BINDING_CHANGED')
    for key in ['realm', 'apiKey', 'allowedEmails', 'modelMetadataSha256', 'tariffSource']:
        if previous.get(key) != next_settings.get(key):
            raise m.InstallationError('CLASSIFICATION_ADMISSION_AUTHORITY_CHANGED')
    old, new = previous['admission'], next_settings['admission']
    if any(old[key] != new[key] for key in ['stageCapAtoms', 'stageMaximumCalls']) or int(new['spentAtoms']) < int(old['spentAtoms']) or new['calls'] < old['calls'] or next_settings['maximumCalls'] > previous['maximumCalls']:
        raise m.InstallationError('CLASSIFICATION_ADMISSION_ACCOUNTING_CHANGED')
    if previous['cost']['projectId'] != next_settings['cost']['projectId'] or previous['cost']['price'] != next_settings['cost']['price']:
        raise m.InstallationError('CLASSIFICATION_ADMISSION_PROJECT_CHANGED')


def install(source, sha, enable_classification=False, evidence=None, tested_sha=None):
    if bool(evidence) != bool(tested_sha) or evidence and (not enable_classification or not re.fullmatch('[a-f0-9]{64}', tested_sha)):
        raise m.InstallationError('CLASSIFICATION_EVIDENCE_ARGUMENTS_INVALID')
    print('Подготовка: проверяем релиз и резервную копию Staging.', flush=True)
    if not re.fullmatch('[a-f0-9]{40}', sha):
        raise m.InstallationError('RELEASE_INVALID')
    config = settings()
    origin = validate_origin(config['API_BASE_URL'])
    validate_manifest(json.loads((source / 'apps/web/dist/release.json').read_text()), sha, origin)
    # The running API may be the previous workflow. Post-switch checks below
    # still require the candidate workflow; preflight checks liveness/profile.
    m.wait_health(False)
    current = Path(m.run(['systemctl', 'show', m.UNIT, '--property=WorkingDirectory', '--value']).decode().strip()).parents[1]
    if current.parent != m.BASE / 'backend-releases' or not re.fullmatch('[a-f0-9]{40}', current.name):
        raise m.InstallationError('INSTALLED_API_LAYOUT_CHANGED')
    private = m.CONFIG.lstat()
    if not stat.S_ISREG(private.st_mode) or private.st_uid != 0 or private.st_mode & 0o077:
        raise m.InstallationError('PRIVATE_CONFIGURATION_REQUIRED')
    original_settings = json.loads(m.CONFIG.read_text())
    binding = original_settings['sourceSha256']
    identity = json.loads(m.run(['/usr/bin/node', '--experimental-transform-types', source / 'apps/api/src/assistant-staging-main.ts', '--prepare']))
    if evidence and identity['sourceSha256'] != tested_sha:
        raise m.InstallationError('CLASSIFICATION_TESTED_RELEASE_CHANGED')
    if identity['sourceSha256'] != binding:
        if not enable_classification:
            raise m.InstallationError('API_SOURCE_CHANGED_REQUIRES_SEPARATE_ADMISSION')
        installed = json.loads(m.run(['/usr/bin/node', '--experimental-transform-types', current / 'apps/api/src/assistant-staging-main.ts', '--prepare']))
        rebind_classification_settings(original_settings, installed['sourceSha256'], identity['sourceSha256'])
    rebound = rebind_classification_settings(original_settings, binding, identity['sourceSha256'])
    if enable_classification and not evidence:
        # Explicit feature opt-in changes only source identity. No new key,
        # ceiling, accounting period, tariff or expiration is manufactured.
        validation = 'import {checkAssistantStagingSettings} from ' + json.dumps((source / 'apps/api/src/analyzer-assistant-settings.ts').as_uri()) + ';import {readFileSync} from "node:fs";checkAssistantStagingSettings(JSON.parse(readFileSync(0,"utf8")));'
        m.run(['/usr/bin/node', '--experimental-transform-types', '--input-type=module', '-e', validation], data=json.dumps(rebound).encode())
    original = m.CADDY.read_bytes()
    old_root = m.frontend_root(json.loads(m.run(['caddy', 'adapt', '--config', m.CADDY, '--pretty'])))
    if original.count(old_root.encode()) != 1:
        raise m.InstallationError('FRONTEND_LAYOUT_CHANGED')
    old_dropin = m.DROPIN.read_bytes()
    if str(current).encode() not in old_dropin:
        raise m.InstallationError('INSTALLED_API_DROPIN_CHANGED')
    release = m.BASE / 'backend-releases' / sha
    if release.exists():
        raise m.InstallationError('RELEASE_ALREADY_EXISTS_REQUIRES_REVIEW')
    backup = Path('/var/lib/cashneuro') / ('connected-release-' + sha[:12] + '-' + str(int(time.time())))
    backup.mkdir(mode=0o700)
    metadata = {name: snapshot(backup, name, path) for name, path in [('caddy', m.CADDY), ('dropin', m.DROPIN), ('workerUnit', WORKER_UNIT), ('workerEnv', WORKER_ENV)]}
    if enable_classification:
        metadata['assistantConfig'] = snapshot(backup, 'assistantConfig', m.CONFIG)
        if evidence:
            m.private_write(backup / 'assistantConfig.original', m.CONFIG.read_bytes())
    services = m.run(['systemctl', 'list-units', '--all', '--plain', '--no-legend', '--type=service', 'cashneuro*import*']).decode().splitlines()
    existing = [line.split()[0] for line in services if len(line.split()) > 3 and line.split()[2] == 'active']
    metadata['workerManaged'] = not existing or existing == [WORKER]
    metadata['workerWasActive'] = WORKER in existing
    enabled = m.run(['systemctl', 'show', WORKER, '--property=UnitFileState', '--value']).decode().strip() if WORKER_UNIT.exists() else ''
    metadata['workerWasEnabled'] = enabled == 'enabled'
    m.private_write(backup / 'rollback.json', json.dumps(metadata).encode())
    container, owner, sql = m.docker_database()
    with os.fdopen(os.open(backup / 'database.dump', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        m.run(['docker', 'exec', container, 'pg_dump', '-U', owner, '-d', 'finance_staging', '-Fc'], output=stream, timeout=300)
        stream.flush()
        os.fsync(stream.fileno())
    if enable_classification:
        if sql("SELECT to_regclass('finance.classification_run') IS NOT NULL") == 'f':
            migration = (source / 'packages/database/migrations/0028_ai_classification.sql').read_text()
            sql('BEGIN;\n' + migration + '\nCOMMIT;')
        if sql("SELECT position('details' IN pg_get_constraintdef(oid))>0 FROM pg_constraint WHERE conrelid='finance.ingestion_row'::regclass AND conname='finite_source_evidence'") == 'f':
            sql('BEGIN;\n' + (source / 'packages/database/migrations/0029_bank_description.sql').read_text() + '\nCOMMIT;')
    if sql("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='finance' AND table_name='workspace' AND column_name='marketplace_catalog_initialized')") == 'f':
        sql('BEGIN;\n' + (source / 'packages/database/migrations/0030_marketplace_catalog.sql').read_text() + '\nCOMMIT;')
    if sql("SELECT position('textEvidence' IN pg_get_constraintdef(oid))>0 FROM pg_constraint WHERE conrelid='finance.ingestion_row'::regclass AND conname='finite_source_evidence'") == 'f':
        sql('BEGIN;\n' + (source / 'packages/database/migrations/0031_merchant_source.sql').read_text() + '\nCOMMIT;')
    if sql("SELECT to_regclass('finance.category_binding') IS NOT NULL") != 't':
        sql('BEGIN;\n' + (source / 'packages/database/migrations/0032_category_bindings.sql').read_text() + '\nCOMMIT;')
    print('1/3: сохранены настройки отката и резервная копия тестовой БД; схема импорта проверена.', flush=True)
    shutil.copytree(source, release, symlinks=True)
    for directory, dirs, files in os.walk(release, followlinks=False):
        for name in ['.'] + dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                continue
            os.chown(path, 0, 0)
            os.chmod(path, stat.S_IMODE(path.stat().st_mode) & ~0o022 | (0o555 if path.is_dir() else 0o444))
    new_root = release / 'apps/web/dist'
    candidate = backup / 'Caddyfile.candidate'
    m.private_write(candidate, original.replace(old_root.encode(), str(new_root).encode()))
    m.run(['caddy', 'validate', '--config', candidate, '--adapter', 'caddyfile'])
    rollback = 'sudo /usr/bin/python3 ' + shlex.quote(str(release / 'scripts/update-staging-release.py')) + ' --rollback ' + shlex.quote(str(backup))
    print('Откат: ' + rollback, flush=True)
    if evidence:
        print('Проверяем два сохранённых ответа и оплаченные квитанции; новых модельных запросов: 0.', flush=True)
        next_path, fallback_path = backup / 'assistantConfig.next', backup / 'assistantConfig.rollbackFresh'
        m.run(['/usr/bin/node', '--experimental-transform-types', release / 'apps/api/src/classification-admit-main.ts', '--prepare', evidence, next_path, fallback_path, tested_sha, binding], output=sys.stdout.buffer, timeout=60)
        rebound = json.loads(next_path.read_text())
        fallback = json.loads(fallback_path.read_text())
        validate_admission_pair(original_settings, rebound, fallback, binding, tested_sha)
        # Original expired settings remain in assistantConfig.original. The
        # service rollback uses fresh authority bound to the previous runtime,
        # with the same carried costs/call ceiling as the candidate.
        m.atomic_replace(backup / 'assistantConfig', fallback_path.read_bytes(), 0o600)
    print('2/3: подключение собранного интерфейса к API и проверка обработчика импорта.', flush=True)
    try:
        new_dropin = old_dropin.replace(str(current).encode(), str(release).encode())
        if enable_classification:
            m.atomic_replace(m.CONFIG, json.dumps(rebound).encode(), 0o600)
            if evidence:
                print('Категоризация: два сохранённых PASS приняты на проверенном runtime; повторных POST нет.', flush=True)
            else:
                print('Проверка категоризации: два платных запроса на синтетике в пределах прежнего лимита.', flush=True)
                m.run(['/usr/bin/node', '--experimental-transform-types', release / 'apps/api/src/classification-smoke-main.ts', '--live'], output=sys.stdout.buffer, timeout=180)
            new_dropin += b'\n[Service]\nEnvironment=CLASSIFICATION_ENABLED=1\n'
        m.atomic_replace(m.DROPIN, new_dropin)
        if metadata['workerManaged']:
            # Copy only the scoped DB connection, never auth/KMS/AI credentials.
            worker_env = 'APP_ENV=staging\nAPI_PROFILE=finance\nDATABASE_URL=' + json.dumps(config['DATABASE_URL']) + '\n'
            m.atomic_replace(WORKER_ENV, worker_env.encode(), 0o600)
            m.atomic_replace(WORKER_UNIT, worker_unit(release).encode())
        m.run(['systemctl', 'daemon-reload'])
        m.run(['systemctl', 'restart', m.UNIT])
        m.wait_health(True)
        if metadata['workerManaged']:
            m.run(['systemctl', 'enable', WORKER])
            m.run(['systemctl', 'restart', WORKER])
            time.sleep(2)
            if m.run(['systemctl', 'is-active', WORKER]).decode().strip() != 'active':
                raise m.InstallationError('IMPORT_WORKER_NOT_ACTIVE')
        info = m.CADDY.stat()
        m.atomic_replace(m.CADDY, candidate.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        m.run(['systemctl', 'reload', 'caddy'])
        m.wait_health(True)
        actual = m.frontend_root(json.loads(m.run(['caddy', 'adapt', '--config', m.CADDY, '--pretty'])))
        if actual != str(new_root):
            raise m.InstallationError('FRONTEND_SWITCH_FAILED')
    except Exception:
        print('Ошибка переключения. Возвращаем прежнюю конфигурацию.', flush=True)
        restore(backup)
        raise
    print('3/3: установлен подключённый интерфейс, API помощника и обработчик импорта.', flush=True)
    print(json.dumps({'status': 'UPDATED', 'sha': sha, 'frontendMode': 'connected', 'apiOrigin': origin, 'assistantAdmission': 'continued_with_prior_usage' if evidence else 'unchanged', 'paidCalls': 2 if enable_classification and not evidence else 0, 'rollback': rollback}, ensure_ascii=False), flush=True)


def main():
    if os.geteuid() != 0:
        raise m.InstallationError('ROOT_REQUIRED')
    parser = argparse.ArgumentParser()
    parser.add_argument('--inspect-api-origin', action='store_true')
    parser.add_argument('--source')
    parser.add_argument('--sha')
    parser.add_argument('--rollback')
    parser.add_argument('--enable-classification', action='store_true')
    parser.add_argument('--classification-evidence')
    parser.add_argument('--tested-runtime-sha')
    args = parser.parse_args()
    if args.inspect_api_origin:
        print(validate_origin(settings()['API_BASE_URL']))
        return
    lock = os.open('/run/lock/cashneuro-assistant-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if args.rollback:
        restore(Path(args.rollback).resolve())
    elif args.source and args.sha:
        install(Path(args.source).resolve(), args.sha, args.enable_classification, args.classification_evidence, args.tested_runtime_sha)
    else:
        raise m.InstallationError('ARGUMENTS_REQUIRED')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Обновление остановлено: ' + (str(error) if isinstance(error, m.InstallationError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
