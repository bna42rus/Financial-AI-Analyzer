"""Retain live references and two predecessors; share the deployment lock."""
from contextlib import nullcontext
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat

from .common import OpsError, STATE, emit, locked, private_dir, private_write, run

BASE = Path('/srv/cashneuro/staging/backend-releases')
HEX = re.compile('[a-f0-9]{40}')
SERVICE_ARGS = ['systemctl', 'show', 'cashneuro-*', '-p', 'Id', '-p', 'ActiveState', '-p', 'WorkingDirectory', '-p', 'ExecStart']
CADDY_ARGS = ['caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--pretty']


def release_names(text, base=BASE):
    return set(re.findall(re.escape(str(base)) + r'/([a-f0-9]{40})(?![a-f0-9])', text))


def choose_predecessors(directories, current, count=2):
    """Only versions older than the actual running release qualify as predecessors."""
    if current not in directories:
        raise OpsError('CURRENT_RELEASE_MISSING')
    cutoff = directories[current].stat().st_mtime_ns
    prior = sorted((p for n, p in directories.items() if n != current and p.stat().st_mtime_ns <= cutoff),
                   key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
    return {current, *(p.name for p in prior[:count])}


def references(base, services, caddy):
    protected = release_names(services + '\n' + caddy, base)
    finance = run(['systemctl', 'show', 'cashneuro-staging-api@finance.service',
                   '-p', 'WorkingDirectory', '--value']).decode().strip()
    match = re.fullmatch(re.escape(str(base)) + r'/([a-f0-9]{40})/apps/api', finance)
    if not match:
        raise OpsError('RUNNING_RELEASE_LAYOUT_CHANGED')
    protected.add(match[1])
    for path in [*base.parent.glob('*'), *base.parent.glob('*/*')]:
        if path.is_symlink():
            protected.update(release_names(str(path.resolve()), base))
    # Includes bind mounts and tablespace mounts: no mounted release is removable.
    protected.update(release_names(Path('/proc/self/mountinfo').read_text(), base))
    for proc in Path('/proc').iterdir():
        if proc.name.isdigit():
            for name in ('cwd', 'exe', 'cmdline'):
                try:
                    path = proc / name
                    text = str(path.resolve()) if name != 'cmdline' else path.read_bytes().decode(errors='replace')
                    protected.update(release_names(text, base))
                except (FileNotFoundError, ProcessLookupError):
                    pass
            try:
                protected.update(release_names((proc / 'maps').read_text(errors='replace'), base))
                for descriptor in (proc / 'fd').iterdir():
                    try:
                        protected.update(release_names(str(descriptor.resolve()), base))
                    except (FileNotFoundError, ProcessLookupError):
                        pass
            except (FileNotFoundError, ProcessLookupError):
                pass
    # Configuration of disabled/timer-started units also protects their releases.
    root = Path('/etc/systemd/system')
    for path in [*root.glob('cashneuro*.service'), *root.glob('cashneuro*.service.d/*.conf')]:
        if path.is_file() and path.stat().st_size <= 1024 * 1024:
            protected.update(release_names(path.read_text(errors='replace'), base))
    return match[1], protected


def dependency_closure(base, keep):
    keep = set(keep)
    checked = set()
    while keep - checked:
        name = next(iter(keep - checked))
        checked.add(name)
        for directory, dirs, files in os.walk(base / name):
            for item in dirs + files:
                path = Path(directory) / item
                if path.is_symlink():
                    keep.update(release_names(str(path.resolve()), base))
    return keep


def prune(*, apply=False, already_locked=False, base=BASE):
    with nullcontext() if already_locked else locked():
        if base.resolve() != base or not base.is_dir() or not shutil.rmtree.avoids_symlink_attacks:
            raise OpsError('RELEASE_ROOT_INVALID')
        directories = {}
        for path in base.iterdir():
            if HEX.fullmatch(path.name) and path.is_dir() and not path.is_symlink():
                info = path.stat()
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise OpsError('RELEASE_NOT_IMMUTABLE')
                directories[path.name] = path
        services, caddy = run(SERVICE_ARGS).decode(), run(CADDY_ARGS).decode()
        current, protected = references(base, services, caddy)
        keep = dependency_closure(base, protected | choose_predecessors(directories, current))
        # A candidate prepared concurrently/newer than the running version is retained.
        keep.update(n for n, p in directories.items() if p.stat().st_mtime_ns > directories[current].stat().st_mtime_ns)
        remove = sorted(set(directories) - keep)
        emit('release-retention', mode='apply' if apply else 'preview', current=current,
             keep=sorted(set(directories) & keep), remove=remove)
        if not apply:
            return {'kept': len(set(directories) & keep), 'removed': 0}
        if services != run(SERVICE_ARGS).decode() or caddy != run(CADDY_ARGS).decode():
            raise OpsError('LIVE_CONFIGURATION_CHANGED')
        audit = private_dir(STATE / 'release-audit')
        record = {'at': datetime.now(timezone.utc).isoformat(), 'current': current, 'keep': sorted(keep), 'remove': remove}
        digest = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
        private_write(audit / (digest + '.json'), json.dumps(record))
        before = shutil.disk_usage(base).free
        for index, name in enumerate(remove, 1):
            path = directories[name]
            if path.is_symlink() or path.resolve().parent != base or path.is_mount():
                raise OpsError('RELEASE_PATH_CHANGED')
            emit('release-delete', index=index, total=len(remove), release=name)
            shutil.rmtree(path)
        result = {'kept': len(set(directories) & keep), 'removed': len(remove),
                  'freedBytes': max(0, shutil.disk_usage(base).free - before)}
        emit('release-retention-done', **result)
        return result
