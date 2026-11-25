"""Root-only isolated synthetic pilot. No deployment, key output or budget reset."""
import argparse
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
from urllib.parse import urlsplit

BASE = Path('/var/lib/cashneuro/analyzer-next-pilot')
SERVICE = 'cashneuro-staging-api@finance.service'

def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, check=False, **kwargs)
    if result.returncode:
        raise RuntimeError('PILOT_COMMAND_FAILED')
    return result.stdout

def private(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
        raise RuntimeError('PILOT_PRIVATE_CONFIGURATION_REQUIRED')
    return path.read_text()

def directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('PILOT_DIRECTORY_DENIED')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--resume', help='Reuse an existing private run and its receipts by source SHA')
    parser.add_argument('--suite', choices=['basic', 'additional'], default='basic')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--live', action='store_true')
    mode.add_argument('--replay-only', action='store_true', help='Never dispatch a model request; require all saved replies')
    args = parser.parse_args()
    if args.replay_only and not args.resume:
        parser.error('--replay-only requires --resume')
    if os.geteuid() != 0 or not re.fullmatch('[a-f0-9]{40}', args.sha):
        raise RuntimeError('PILOT_ROOT_SHA_REQUIRED')
    if args.resume is not None and not re.fullmatch('[a-f0-9]{40}', args.resume):
        raise RuntimeError('PILOT_RESUME_SHA_INVALID')
    repo = Path(args.source).resolve()
    if run(['git', '-c', 'safe.directory='+str(repo), '-C', str(repo), 'rev-parse', args.sha+'^{commit}'], text=True).strip() != args.sha:
        raise RuntimeError('PILOT_COMMIT_INVALID')
    active = dict(line.split('=', 1) for line in run(['systemctl', 'show', SERVICE, '-p', 'ActiveState', '-p', 'SubState', '-p', 'WorkingDirectory'], text=True).splitlines())
    api = active.get('WorkingDirectory', '')
    if active.get('ActiveState') != 'active' or active.get('SubState') != 'running' or not re.fullmatch('/srv/cashneuro/staging/backend-releases/[a-f0-9]{40}/apps/api', api):
        raise RuntimeError('PILOT_ACTIVE_RELEASE_REQUIRED')
    values = {}
    for line in private(Path('/etc/cashneuro/staging/finance-api.env')).splitlines():
        match = re.fullmatch(r'\s*([A-Z_]+)\s*=\s*(.*?)\s*', line)
        if match:
            values[match[1]] = match[2].strip('\"\'')
    url = urlsplit(values.get('DATABASE_URL', ''))
    if values.get('APP_ENV') != 'staging' or values.get('API_PROFILE') != 'finance' or url.scheme not in ('postgres', 'postgresql') or url.hostname not in ('127.0.0.1', 'localhost') or url.port != 5411 or url.username != 'finance_api' or url.path != '/finance_staging' or url.query or url.fragment:
        raise RuntimeError('PILOT_SCOPED_DATABASE_REQUIRED')
    settings = json.loads(private(Path('/etc/cashneuro/ai/assistant-staging.json')))
    emails = settings.get('allowedEmails', [])
    if settings.get('realm') != 'staging/finance' or settings.get('monthly', {}).get('limitRub') != '100' or len(emails) != 1:
        raise RuntimeError('PILOT_EXISTING_MONTHLY_CAP_REQUIRED')
    directory(BASE)
    with open(BASE / 'pilot.lock', 'a', opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW, 0o600)) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        target = BASE / args.sha
        directory(target)
        source = target / 'source'
        if not source.exists():
            archive = run(['git', '-c', 'safe.directory='+str(repo), '-C', str(repo), 'archive', '--format=tar', args.sha])
            source.mkdir(mode=0o700)
            with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as contents:
                contents.extractall(source, filter='data')
            (source / 'apps/api/node_modules').symlink_to(Path(api) / 'node_modules', target_is_directory=True)
            (target / 'source-ready.json').write_text(json.dumps({'sha': args.sha}))
            (target / 'source-ready.json').chmod(0o600)
        if (source / 'pnpm-lock.yaml').read_bytes() != (Path(api).parents[1] / 'pnpm-lock.yaml').read_bytes():
            raise RuntimeError('PILOT_DEPENDENCY_LOCK_CHANGED')
        modules = source / 'apps/api/node_modules'
        if not modules.is_symlink():
            raise RuntimeError('PILOT_MODULE_LINK_INVALID')
        if modules.readlink() != Path(api) / 'node_modules':
            modules.unlink()
            modules.symlink_to(Path(api) / 'node_modules', target_is_directory=True)
        if json.loads(private(target / 'source-ready.json')) != {'sha': args.sha}:
            raise RuntimeError('PILOT_SOURCE_INCOMPLETE')
        print('PRECHECK: offline contracts, context, complete dialogs and comparison regressions.', flush=True)
        checks = ['next-contract', 'next-period', 'next-read-binding', 'next-tasks', 'next-workflow', 'next-regression', 'next-additional-pilot']
        checked = subprocess.run(['/usr/bin/node', '--test', *[str(source / 'packages/analyzer/test' / (name+'.test.ts')) for name in checks]], cwd=source / 'apps/api', env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'NODE_ENV': 'test'})
        if checked.returncode:
            raise RuntimeError('PILOT_OFFLINE_PRECHECK_FAILED')
        spec = importlib.util.spec_from_file_location('pilot_account', source / 'scripts/diagnose-analyzer-account-staging.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        email = emails[0]
        if not isinstance(email, str) or len(email) > 320:
            raise RuntimeError('PILOT_ACCOUNT_INVALID')
        encoded = email.lower().encode().hex()
        sql = "BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout='10s'; SELECT user_id FROM commerce.account_directory WHERE status='active' AND lower(email)=convert_from(decode('" + encoded + "','hex'),'UTF8'); ROLLBACK;"
        owner = module.run(['docker', 'exec', '-i', module.database(), 'sh', '-c', 'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d finance_staging -Atq'], sql).splitlines()
        if len(owner) != 1 or not re.fullmatch('[A-Za-z0-9_-]{1,256}', owner[0]):
            raise RuntimeError('PILOT_ACCOUNT_NOT_UNIQUE')
        journal_target = target
        if args.resume:
            journal_target = BASE / args.resume
            if not journal_target.is_dir():
                raise RuntimeError('PILOT_RESUME_NOT_FOUND')
            directory(journal_target)
            private(journal_target / 'run.json')
            print('Reusing the existing pilot receipts; '+('model dispatch disabled.' if args.replay_only else 'only missing replies may dispatch.'), flush=True)
        payload = {'activeApi': api, 'directory': str(journal_target), 'databaseUrl': values['DATABASE_URL'], 'settings': settings, 'email': email, 'userId': owner[0], 'suite': args.suite}
        result = subprocess.run(['/usr/bin/node', '--import', 'tsx', 'src/analyzer-next-pilot-main.ts', '--replay-only' if args.replay_only else '--live'], cwd=source / 'apps/api', input=json.dumps(payload), text=True, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'NODE_ENV': 'production'})
        return result.returncode

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{1,80}', str(error)) else 'PILOT_WRAPPER_STOPPED'
        print(code)
        raise SystemExit(1)
