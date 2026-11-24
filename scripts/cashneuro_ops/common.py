"""Bounded subprocesses, private files and unambiguous local PostgreSQL selection."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

STATE = Path('/var/lib/cashneuro-ops')
CONFIG = Path('/etc/cashneuro/backup/ops.json')
INSTALL_LOCK = Path('/run/lock/cashneuro-assistant-install.lock')
ENVIRONMENTS = {'staging': ('finance_staging', '5411'), 'production': ('finance_production', '5412')}


class OpsError(Exception):
    """Only constant, non-sensitive error codes cross the CLI boundary."""


def emit(step, **values):
    print(json.dumps({'step': step, **values}, ensure_ascii=False), flush=True)


def require_root():
    if os.geteuid() != 0:
        raise OpsError('ROOT_REQUIRED')


def private_dir(path):
    path = Path(path)
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.resolve() != path or info.st_uid != 0 or info.st_mode & 0o077:
        raise OpsError('PRIVATE_DIRECTORY_REQUIRED')
    return path


def private_read(path, maximum=1024 * 1024):
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > maximum or path.resolve() != path:
            raise OpsError('PRIVATE_FILE_REQUIRED')
        return stream.read(maximum + 1)


def private_write(path, value):
    path = Path(path)
    private_dir(path.parent)
    if isinstance(value, str):
        value = value.encode()
    fd, temporary = tempfile.mkstemp(prefix='.ops-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(args, *, data=None, input_file=None, env=None, cwd=None, output=None, timeout=60):
    try:
        result = subprocess.run([str(x) for x in args], input=data, stdin=input_file, env=env, cwd=cwd,
                                stdout=output if output is not None else subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise OpsError('COMMAND_TIMEOUT') from None
    except OSError:
        raise OpsError('COMMAND_UNAVAILABLE') from None
    if result.returncode:
        # Provider, database and subprocess diagnostics can contain secrets.
        raise OpsError('COMMAND_FAILED_' + str(result.returncode))
    return result.stdout or b''


@contextmanager
def locked(path=INSTALL_LOCK):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise OpsError('LOCK_FILE_INVALID')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OpsError('ANOTHER_OPERATION_RUNNING') from None
        yield
    finally:
        os.close(fd)


def database(environment):
    if environment not in ENVIRONMENTS:
        raise OpsError('ENVIRONMENT_INVALID')
    db, port = ENVIRONMENTS[environment]
    ids = run(['docker', 'ps', '--format', '{{.ID}}']).decode().splitlines()
    if not ids or len(ids) > 30 or any(not re.fullmatch('[a-f0-9]{12,64}', x) for x in ids):
        raise OpsError('CONTAINER_LAYOUT_UNEXPECTED')
    entries = json.loads(run(['docker', 'inspect', *ids]))
    matches = [x for x in entries if any(p.get('HostIp') == '127.0.0.1' and p.get('HostPort') == port
               for p in (x.get('NetworkSettings', {}).get('Ports', {}).get('5432/tcp') or []))]
    if len(matches) != 1:
        raise OpsError('DATABASE_NOT_UNIQUE_' + environment.upper())
    container = matches[0]
    values = dict(x.split('=', 1) for x in container.get('Config', {}).get('Env', []) if '=' in x)
    owner = values.get('POSTGRES_USER', 'postgres')
    if not re.fullmatch('[a-zA-Z_][a-zA-Z0-9_]{0,62}', owner):
        raise OpsError('DATABASE_OWNER_INVALID')
    result = {'container': container['Id'], 'database': db, 'owner': owner,
              'image': container['Image'], 'mounts': container.get('Mounts', [])}
    actual = sql(result, 'SELECT current_database();').strip()
    if actual != db:
        raise OpsError('DATABASE_MISMATCH')
    return result


def sql(db, query, *, timeout=30):
    return run(['docker', 'exec', '-i', db['container'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                '-U', db['owner'], '-d', db['database'], '-Atq'], data=query.encode(), timeout=timeout).decode()


def settings(path=CONFIG):
    result = json.loads(private_read(path))
    if result.get('version') != 'cashneuro-ops/1':
        raise OpsError('CONFIGURATION_VERSION_INVALID')
    return result


def env_file(path):
    """Read assignments without executing a shell or returning their contents."""
    result = {}
    for line in private_read(path).decode().splitlines():
        match = re.fullmatch(r'\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*', line)
        if match:
            value = match[2]
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            result[match[1]] = value
    return result


def cleanup_isolated_container(name):
    """A failed docker client can still have created its container; verify by name/label."""
    match = re.fullmatch(r'cashneuro-(restore|sizing)-[a-f0-9]{16}', name)
    if not match:
        raise OpsError('ISOLATED_CONTAINER_NAME_INVALID')
    ids = run(['docker', 'ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']).decode().splitlines()
    if not ids:
        return
    if len(ids) != 1 or not re.fullmatch('[a-f0-9]{12,64}', ids[0]):
        raise OpsError('ISOLATED_CONTAINER_NOT_UNIQUE')
    labels = json.loads(run(['docker', 'inspect', '--format', '{{json .Config.Labels}}', ids[0]]))
    label = 'cashneuro.restore-test' if match[1] == 'restore' else 'cashneuro.synthetic-sizing'
    if not isinstance(labels, dict) or labels.get(label) != 'true':
        raise OpsError('ISOLATED_CONTAINER_LABEL_MISMATCH')
    run(['docker', 'rm', '-f', ids[0]], timeout=60)


def start_isolated_postgres(name, pgdata, image, owner):
    """An empty private mount is PGDATA itself, including on PostgreSQL 18+."""
    purpose = 'restore' if owner == 'cashneuro_restore' else 'sizing' if owner == 'cashneuro_sizing' else None
    if purpose is None or not re.fullmatch('cashneuro-' + purpose + '-[a-f0-9]{16}', name):
        raise OpsError('ISOLATED_CONTAINER_NAME_INVALID')
    pgdata = Path(pgdata)
    pgdata.mkdir(mode=0o700)
    # The image chowns PGDATA before dropping root. With the image's nested
    # default, a root-owned 0700 mount remains an inaccessible parent directory.
    run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '512m', '--cpus', '0.5',
         '--label', 'cashneuro.restore-test=true' if purpose == 'restore' else 'cashneuro.synthetic-sizing=true',
         '--mount', 'type=bind,src=' + str(pgdata) + ',dst=/var/lib/postgresql',
         '-e', 'PGDATA=/var/lib/postgresql', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
         '-e', 'POSTGRES_USER=' + owner, '--pull', 'never', image], timeout=60)
    db = {'container': name, 'owner': owner, 'database': 'postgres'}
    deadline = time.monotonic() + 120
    next_report = 0
    while time.monotonic() < deadline:
        if time.monotonic() >= next_report:
            emit('isolated-postgres-starting', purpose=purpose)
            next_report = time.monotonic() + 10
        state = json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', name], timeout=5))
        if state.get('OOMKilled'):
            raise OpsError('ISOLATED_POSTGRES_OOM')
        if not state.get('Running'):
            raise OpsError('ISOLATED_POSTGRES_EXITED')
        try:
            # The entrypoint starts a temporary server during initdb; only use
            # the final server after it has exec'ed postgres as PID 1.
            if run(['docker', 'exec', name, 'cat', '/proc/1/comm'], timeout=5).strip() == b'postgres':
                if sql(db, 'SELECT 1;', timeout=5).strip() == '1':
                    return db
        except OpsError:
            pass
        time.sleep(1)
    raise OpsError('ISOLATED_POSTGRES_NOT_READY')
