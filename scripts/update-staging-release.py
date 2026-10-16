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
            '[Service]\nType=exec\nDynamicUser=yes\nWorkingDirectory=' + str(release / 'apps/api') + '\n'
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


def restore(backup):
    metadata = json.loads((backup / 'rollback.json').read_text())
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


def install(source, sha):
    if not re.fullmatch('[a-f0-9]{40}', sha):
        raise m.InstallationError('RELEASE_INVALID')
    config = settings()
    origin = validate_origin(config['API_BASE_URL'])
    validate_manifest(json.loads((source / 'apps/web/dist/release.json').read_text()), sha, origin)
    m.wait_health(True)
    current = Path(m.run(['systemctl', 'show', m.UNIT, '--property=WorkingDirectory', '--value']).decode().strip()).parents[1]
    if current.parent != m.BASE / 'backend-releases' or not re.fullmatch('[a-f0-9]{40}', current.name):
        raise m.InstallationError('INSTALLED_API_LAYOUT_CHANGED')
    private = m.CONFIG.lstat()
    if not stat.S_ISREG(private.st_mode) or private.st_uid != 0 or private.st_mode & 0o077:
        raise m.InstallationError('PRIVATE_CONFIGURATION_REQUIRED')
    binding = json.loads(m.CONFIG.read_text())['sourceSha256']
    identity = json.loads(m.run(['/usr/bin/node', '--experimental-transform-types', source / 'apps/api/src/assistant-staging-main.ts', '--prepare']))
    if identity['sourceSha256'] != binding:
        raise m.InstallationError('API_SOURCE_CHANGED_REQUIRES_SEPARATE_ADMISSION')
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
    services = m.run(['systemctl', 'list-units', '--all', '--plain', '--no-legend', '--type=service', 'cashneuro*import*']).decode().splitlines()
    existing = [line.split()[0] for line in services if len(line.split()) > 3 and line.split()[2] == 'active']
    metadata['workerManaged'] = not existing or existing == [WORKER]
    metadata['workerWasActive'] = WORKER in existing
    enabled = m.run(['systemctl', 'show', WORKER, '--property=UnitFileState', '--value']).decode().strip() if WORKER_UNIT.exists() else ''
    metadata['workerWasEnabled'] = enabled == 'enabled'
    m.private_write(backup / 'rollback.json', json.dumps(metadata).encode())
    print('1/3: сохранена конфигурация отката; ключ, лимиты и БД остаются прежними.', flush=True)
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
    print('2/3: подключение собранного интерфейса к API и проверка обработчика импорта.', flush=True)
    try:
        m.atomic_replace(m.DROPIN, old_dropin.replace(str(current).encode(), str(release).encode()))
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
    print(json.dumps({'status': 'UPDATED', 'sha': sha, 'frontendMode': 'connected', 'apiOrigin': origin, 'assistantAdmission': 'unchanged', 'paidCalls': 0, 'rollback': rollback}, ensure_ascii=False), flush=True)


def main():
    if os.geteuid() != 0:
        raise m.InstallationError('ROOT_REQUIRED')
    parser = argparse.ArgumentParser()
    parser.add_argument('--inspect-api-origin', action='store_true')
    parser.add_argument('--source')
    parser.add_argument('--sha')
    parser.add_argument('--rollback')
    args = parser.parse_args()
    if args.inspect_api_origin:
        print(validate_origin(settings()['API_BASE_URL']))
        return
    lock = os.open('/run/lock/cashneuro-assistant-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if args.rollback:
        restore(Path(args.rollback).resolve())
    elif args.source and args.sha:
        install(Path(args.source).resolve(), args.sha)
    else:
        raise m.InstallationError('ARGUMENTS_REQUIRED')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Обновление остановлено: ' + (str(error) if isinstance(error, m.InstallationError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
