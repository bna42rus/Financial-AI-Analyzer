"""Root-only installation for the inspected Staging layout. No model POSTs.
Rollback restores files/services; additive migrations and cost receipts remain.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time
import urllib.request

BASE = Path('/srv/cashneuro/staging')
CONFIG = Path('/etc/cashneuro/ai/assistant-staging.json')
DROPIN = Path('/etc/systemd/system/cashneuro-staging-api@finance.service.d/99-assistant.conf')
RUNTIME = Path('/run/cashneuro-assistant-finance')
CADDY = Path('/etc/caddy/Caddyfile')
UNIT = 'cashneuro-staging-api@finance.service'


class InstallationError(Exception):
    pass


def run(args, *, data=None, timeout=90, output=None):
    result = subprocess.run([str(a) for a in args], input=data, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        command = Path(str(args[0])).name
        if command == 'systemctl':
            verb = str(args[1]) if len(args) > 1 and re.fullmatch('[a-z-]+', str(args[1])) else 'operation'
            units = [str(arg) for arg in args[2:] if re.fullmatch(r'[A-Za-z0-9@._-]+\.service', str(arg))]
            command += ':' + verb + (':' + ','.join(units) if units else '') + ':EXIT_' + str(result.returncode)
        raise InstallationError('COMMAND_FAILED:' + command)
    return result.stdout if output is None else b''


def private_write(path, data):
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def atomic_replace(path, data, mode=0o644, uid=0, gid=0):
    path = Path(path)
    temporary = path.with_name(path.name + '.assistant-' + str(os.getpid()))
    private_write(temporary, data)
    os.chown(temporary, uid, gid)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def copy_credentials():
    directory = RUNTIME.lstat()
    if not stat.S_ISDIR(directory.st_mode) or RUNTIME.resolve() != RUNTIME or directory.st_mode & 0o077 or directory.st_uid == 0:
        raise InstallationError('RUNTIME_DIRECTORY_INVALID')
    files = {'authorized-key.json': Path('/etc/cashneuro/kms/staging/finance/authorized-key.json'),
             'wrapping-key.json': Path('/etc/cashneuro/kms/staging/finance/wrapping-key.json'),
             'assistant-cloud.json': CONFIG}
    for name, source in files.items():
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 65536:
            raise InstallationError('PRIVATE_CREDENTIAL_REQUIRED')
        atomic_replace(RUNTIME / name, source.read_bytes(), 0o600, directory.st_uid, directory.st_gid)


def frontend_root(config):
    found = []
    def visit(node, hosts=()):
        if isinstance(node, dict):
            local = tuple(h for match in node.get('match', []) for h in match.get('host', []))
            hosts = local or hosts
            if isinstance(node.get('root'), str):
                found.append((hosts, node['root']))
            for key, child in node.items():
                if key not in ('match', 'root'):
                    visit(child, hosts)
        elif isinstance(node, list):
            for child in node:
                visit(child, hosts)
    visit(config)
    owned = {root for hosts, root in found if hosts == ('test.cashneuro.ru',)}
    if len(owned) != 1:
        raise InstallationError('FRONTEND_LAYOUT_CHANGED')
    root = owned.pop()
    if any(root == other and hosts != ('test.cashneuro.ru',) for hosts, other in found):
        raise InstallationError('SHARED_FRONTEND_ROOT_DENIED')
    return root


def migration_prefix(existing):
    seen_missing = False
    for present in existing:
        if present and seen_missing:
            raise InstallationError('MIGRATION_PREFIX_INVALID')
        seen_missing = seen_missing or not present
    return sum(existing)


def docker_database():
    found = []
    for container in run(['docker', 'ps', '--format', '{{.ID}}']).decode().splitlines():
        ports = json.loads(run(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', container])) or {}
        if any(p.get('HostIp') == '127.0.0.1' and p.get('HostPort') == '5411' for p in ports.get('5432/tcp') or []):
            found.append(container)
    if len(found) != 1:
        raise InstallationError('STAGING_DATABASE_LAYOUT_CHANGED')
    container = found[0]
    env = json.loads(run(['docker', 'inspect', '--format', '{{json .Config.Env}}', container]))
    values = dict(item.split('=', 1) for item in env if '=' in item)
    owner = values.get('POSTGRES_USER', 'postgres')
    if not re.fullmatch('[a-z_][a-z0-9_]{0,62}', owner):
        raise InstallationError('DATABASE_OWNER_INVALID')
    prefix = ['docker', 'exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', owner, '-d', 'finance_staging', '-Atq']
    def sql(text):
        return run(prefix, data=text.encode(), timeout=120).decode().strip()
    if sql("SELECT current_database()='finance_staging' AND rolsuper FROM pg_roles WHERE rolname=current_user") != 't':
        raise InstallationError('STAGING_DATABASE_OWNER_REQUIRED')
    return container, owner, sql


def health(expected=False):
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=3) as response:
        value = json.load(response)
    return value.get('status') == 'ok' and value.get('profile') == 'finance' and (not expected or value.get('assistant') == 'cashneuro-assistant-workflow/6')


def wait_health(expected=False):
    for attempt in range(60):
        try:
            if health(expected):
                return
        except Exception:
            pass
        time.sleep(1)
    raise InstallationError('API_HEALTH_FAILED')


def restore(backup):
    manifest = json.loads((backup / 'rollback.json').read_text())
    for key, path in [('caddy', CADDY), ('dropin', DROPIN)]:
        previous = manifest[key]
        if previous is None:
            path.unlink(missing_ok=True)
        else:
            atomic_replace(path, (backup / key).read_bytes(), previous['mode'], previous['uid'], previous['gid'])
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'reset-failed', UNIT])
    run(['systemctl', 'restart', UNIT])
    run(['caddy', 'validate', '--config', CADDY])
    run(['systemctl', 'reload', 'caddy'])
    wait_health()
    print('Откат API и фронтенда выполнен. Миграции и квитанции расходов сохранены.', flush=True)


def read_test_email(terminal_path='/dev/tty', *, from_stdin=False):
    if from_stdin:
        return sys.stdin.readline().strip().lower()
    # A terminal is not seekable; buffered r+ (BufferedRandom) rejects it.
    # Separate read/write streams also work when stdin carries the Bash script.
    with open(terminal_path, 'r') as reader, open(terminal_path, 'w') as writer:
        writer.write('Почта вашего тестового аккаунта Finance: ')
        writer.flush()
        return reader.readline().strip().lower()


def install(args):
    source = Path(args.source).resolve()
    if not re.fullmatch('[0-9a-f]{40}', args.sha) or not (source / 'apps/api/src/assistant-staging-main.ts').is_file():
        raise InstallationError('RELEASE_INVALID')
    release = BASE / 'backend-releases' / args.sha
    if release.exists() or DROPIN.exists():
        raise InstallationError('RELEASE_ALREADY_EXISTS_REQUIRES_REVIEW')
    environment = Path('/etc/cashneuro/staging/finance-api.env').read_text()
    settings = {}
    for line in environment.splitlines():
        match = re.fullmatch(r'\s*([A-Z_]+)\s*=\s*(.*?)\s*', line)
        if match:
            settings[match[1]] = match[2].strip('\"\'')
    if settings.get('APP_ENV') != 'staging' or settings.get('API_PROFILE') != 'finance' or settings.get('PORT') != '3000' or settings.get('WEB_ORIGIN') != 'https://test.cashneuro.ru':
        raise InstallationError('STAGING_SETTINGS_CHANGED')
    if settings.get('ASSISTANT_ENABLED') == '1':
        raise InstallationError('PILOT_ALREADY_ENABLED')
    old_frontend = frontend_root(json.loads(run(['caddy', 'adapt', '--config', CADDY, '--pretty'])))
    original = CADDY.read_bytes()
    if original.count(old_frontend.encode()) != 1 or not Path(old_frontend).is_dir():
        raise InstallationError('FRONTEND_LAYOUT_CHANGED')
    wait_health()
    container, owner, sql = docker_database()
    email = read_test_email(from_stdin=args.email_stdin)
    if not re.fullmatch(r'[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}', email) or len(email) > 200:
        raise InstallationError('TEST_ACCOUNT_EMAIL_INVALID')
    literal = "'" + email.replace("'", "''") + "'"
    # A pre-existing verified, active test account is required. No access is granted.
    user = sql("SELECT json_build_object('id',u.id,'quota',c.quota_policy) FROM identity.auth_user u JOIN identity.security_state s ON s.user_id=u.id JOIN commerce.access_cycle c ON c.user_id=u.id WHERE u.email=" + literal + " AND u.email_verified AND s.status='active' AND (c.indefinite OR c.access_end>clock_timestamp())")
    if not user:
        raise InstallationError('VERIFIED_ACTIVE_FINANCE_TEST_ACCOUNT_REQUIRED')
    user = json.loads(user)
    tables = ['commerce.analyzer_request', 'commerce.ai_cost_reservation', 'finance.analyzer_task_book', 'finance.assistant_profile']
    flags = [sql("SELECT to_regclass('" + table + "') IS NOT NULL") == 't' for table in tables]
    start = migration_prefix(flags)
    backup = Path('/var/lib/cashneuro') / ('assistant-install-' + args.sha[:12] + '-' + str(int(time.time())))
    backup.mkdir(mode=0o700)
    metadata = {'release': str(release), 'previousBackend': str((BASE / 'backend-current').resolve()), 'caddy': None, 'dropin': None}
    for name, path in [('caddy', CADDY), ('dropin', DROPIN)]:
        if path.exists():
            info = path.stat()
            metadata[name] = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
            private_write(backup / name, path.read_bytes())
    private_write(backup / 'rollback.json', json.dumps(metadata).encode())
    print('1/5: резервная копия тестовой БД.', flush=True)
    with os.fdopen(os.open(backup / 'database.dump', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        run(['docker', 'exec', container, 'pg_dump', '-U', owner, '-d', 'finance_staging', '-Fc'], output=stream, timeout=300)
        stream.flush()
        os.fsync(stream.fileno())
    print('2/5: установка отдельного релиза; работающий API пока не меняется.', flush=True)
    shutil.copytree(source, release, symlinks=True)
    for root, dirs, files in os.walk(release, followlinks=False):
        for name in ['.'] + dirs + files:
            path = Path(root) / name
            if path.is_symlink():
                continue
            os.chown(path, 0, 0)
            os.chmod(path, stat.S_IMODE(path.stat().st_mode) & ~0o022 | (0o555 if path.is_dir() else 0o444))
    private_write(backup / 'release-sha', (args.sha + '\n').encode())
    CONFIG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    setup = {'keyFile': args.key_file, 'budgetFiles': args.budget_file, 'allowedEmails': [email], 'outputFile': str(CONFIG)}
    private_write(backup / 'setup.json', json.dumps(setup).encode())
    print('3/5: проверка ключа и каталога моделей без платного запроса.', flush=True)
    result = json.loads(run(['/usr/bin/node', '--experimental-transform-types', release / 'apps/api/src/assistant-staging-main.ts', '--configure', backup / 'setup.json']))
    print('Ключ подготовлен; доступно вызовов в согласованном этапе: ' + str(result['maximumCalls']), flush=True)
    print('4/5: аддитивные миграции одной транзакцией.', flush=True)
    migrations = sorted((release / 'packages/database/migrations').glob('*.sql'))
    selected = [next(p for p in migrations if p.name.startswith(str(n).zfill(4) + '_')) for n in range(24 + start, 28)]
    # Do not replace an existing account quota or change its entitlement.
    quota_sql = ''
    if user['quota'] is None:
        quota_sql = "UPDATE commerce.access_cycle SET quota_policy='{\"source\":\"override\",\"limit\":20}'::jsonb WHERE user_id=(SELECT id FROM identity.auth_user WHERE email=" + literal + ") AND quota_policy IS NULL;"
        private_write(backup / 'quota-note', b'Only the selected Staging test account acquired its missing 20-task policy. Existing entitlement and cost ceilings are unchanged.\n')
    sql("BEGIN; SET LOCAL lock_timeout='10s'; SELECT pg_advisory_xact_lock(529306481);\n" + '\n'.join(p.read_text() for p in selected) + '\n' + quota_sql + '\nCOMMIT;')
    rollback_command = 'sudo /usr/bin/python3 ' + shlex.quote(str(release / 'scripts/install-assistant-staging.py')) + ' --rollback ' + shlex.quote(str(backup))
    print('Откат: ' + rollback_command, flush=True)
    new_frontend = release / 'apps/web/dist'
    if not (new_frontend / 'index.html').is_file():
        raise InstallationError('FRONTEND_BUILD_MISSING')
    frontend_manifest = json.loads((new_frontend / 'release.json').read_text())
    if frontend_manifest != {'schema': 'cashneuro-web-build/1', 'revision': args.sha, 'profile': 'finance', 'mode': 'connected', 'apiOrigin': 'https://test.cashneuro.ru'}:
        raise InstallationError('CONNECTED_FRONTEND_REQUIRED')
    candidate = backup / 'Caddyfile.candidate'
    private_write(candidate, original.replace(old_frontend.encode(), str(new_frontend).encode()))
    run(['caddy', 'validate', '--config', candidate, '--adapter', 'caddyfile'])
    DROPIN.parent.mkdir(parents=True, exist_ok=True)
    dropin = ('[Service]\nWorkingDirectory=' + str(release / 'apps/api') + '\nEnvironment=ASSISTANT_ENABLED=1\nEnvironment=AI_ENABLED=0\n'
              'Environment=CREDENTIALS_DIRECTORY=' + str(RUNTIME) + '\nExecStart=\nExecStart=/usr/bin/env CREDENTIALS_DIRECTORY=' + str(RUNTIME) + ' ASSISTANT_ENABLED=1 AI_ENABLED=0 /usr/bin/node --import tsx src/main.ts\nRuntimeDirectory=cashneuro-assistant-finance\nRuntimeDirectoryMode=0700\n'
              'LoadCredential=assistant-cloud.json:' + str(CONFIG) + '\nExecStartPre=+/usr/bin/python3 ' + str(release / 'scripts/install-assistant-staging.py') + ' --copy-credentials\n')
    print('5/5: переключение Finance API и фронтенда; автоматический откат при ошибке.', flush=True)
    try:
        atomic_replace(DROPIN, dropin.encode())
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'reset-failed', UNIT])
        run(['systemctl', 'restart', UNIT])
        wait_health(True)
        info = CADDY.stat()
        atomic_replace(CADDY, candidate.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        run(['systemctl', 'reload', 'caddy'])
        wait_health(True)
        actual = frontend_root(json.loads(run(['caddy', 'adapt', '--config', CADDY, '--pretty'])))
        if actual != str(new_frontend):
            raise InstallationError('FRONTEND_SWITCH_FAILED')
    except Exception:
        print('Ошибка переключения. Выполняется откат.', flush=True)
        restore(backup)
        raise
    print(json.dumps({'status': 'INSTALLED', 'sha': args.sha, 'assistant': 'cashneuro-assistant-workflow/6', 'paidCalls': 0, 'rollback': rollback_command}, ensure_ascii=False), flush=True)


def main():
    if os.geteuid() != 0:
        raise InstallationError('ROOT_REQUIRED')
    parser = argparse.ArgumentParser()
    parser.add_argument('--copy-credentials', action='store_true')
    parser.add_argument('--email-stdin', action='store_true')
    parser.add_argument('--rollback')
    parser.add_argument('--source')
    parser.add_argument('--sha')
    parser.add_argument('--key-file')
    parser.add_argument('--budget-file', action='append')
    args = parser.parse_args()
    if args.copy_credentials:
        copy_credentials()
        return
    lock = os.open('/run/lock/cashneuro-assistant-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if args.rollback:
        restore(Path(args.rollback).resolve())
    elif args.source and args.sha and args.key_file and args.budget_file:
        install(args)
    else:
        raise InstallationError('ARGUMENTS_REQUIRED')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print subprocess output, environment, SQL, account IDs or credentials.
        print('Установка остановлена: ' + (str(error) if isinstance(error, InstallationError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
