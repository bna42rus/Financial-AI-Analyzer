#!/usr/bin/env python3
"""Publish only validated public dictionary data, without restarting application services."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata

ACTIVE = Path('/var/lib/cashneuro/merchant-dictionary/active.json')
INSTALLED = Path('/usr/local/lib/cashneuro/merchant-dictionary')
DATA_PATH = 'packages/finance-core/src/catalog/merchant-dictionary.json'
BRANCH = 'feature/cashneuro-acceptance-20261110'
REPOSITORY = Path('/home/finance-admin/cashneuro-staging-src')

def normalize(value):
    return re.sub(r'[^\w]+', ' ', unicodedata.normalize('NFKC', value).casefold().replace('ё', 'е').replace('_', ' ')).strip()

def validate(raw, targets):
    if len(raw) > 1024 * 1024:
        raise ValueError('DICTIONARY_TOO_LARGE')
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {'schema', 'revision', 'entries'} or data['schema'] != 'cashneuro-merchant-dictionary/1' or not isinstance(data['revision'], str) or not re.fullmatch(r'[-.a-zA-Z0-9]{1,80}', data['revision']) or not isinstance(data['entries'], list) or len(data['entries']) > 3000:
        raise ValueError('INVALID_DICTIONARY')
    ids, forms = set(), {}
    for entry in data['entries']:
        if not isinstance(entry, dict) or set(entry) - {'id', 'name', 'forms', 'target', 'confidence', 'tokens'} or not {'id', 'name', 'forms', 'target', 'confidence'} <= set(entry):
            raise ValueError('INVALID_ENTRY')
        identifier = entry['id']
        if not isinstance(identifier, str) or not re.fullmatch(r'[-a-zA-Z0-9]{1,80}', identifier) or identifier in ids or not isinstance(entry['name'], str) or not entry['name'].strip() or len(entry['name']) > 160 or entry['target'] not in targets or type(entry['confidence']) is not int or entry['confidence'] not in (80, 96) or not isinstance(entry['forms'], list) or not 1 <= len(entry['forms']) <= 300:
            raise ValueError('INVALID_ENTRY')
        ids.add(identifier)
        for value in [entry['name'], *entry['forms']]:
            if not isinstance(value, str) or len(value) > 160 or not normalize(value) or any(unicodedata.category(c) in ('Cc', 'Cf') for c in value):
                raise ValueError('INVALID_FORM')
        for value in entry['forms']:
            key = normalize(value)
            if key in forms and forms[key] != identifier:
                raise ValueError('AMBIGUOUS_ALIAS')
            forms[key] = identifier
        token_sets = entry.get('tokens', [])
        if not isinstance(token_sets, list) or len(token_sets) > 30:
            raise ValueError('INVALID_TOKENS')
        for tokens in token_sets:
            if not isinstance(tokens, list) or not 2 <= len(tokens) <= 8 or any(not isinstance(t, str) or not normalize(t) or ' ' in normalize(t) for t in tokens):
                raise ValueError('INVALID_TOKENS')
    return data

def atomic(path, raw, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def run(command):
    return subprocess.run(command, check=True, capture_output=True, timeout=45).stdout

def publish(raw, targets):
    data = validate(raw, targets)
    if ACTIVE.exists() and ACTIVE.read_bytes() == raw:
        return False
    atomic(ACTIVE, raw)
    return data['revision']

def install(source):
    targets = json.loads((source / 'scripts/merchant-dictionary-targets.json').read_text())
    raw = (source / DATA_PATH).read_bytes()
    validate(raw, targets)
    atomic(INSTALLED / 'sync.py', Path(__file__).read_bytes())
    atomic(INSTALLED / 'targets.json', json.dumps(targets).encode())
    publish(raw, targets)
    unit = ('[Unit]\nDescription=Update CashNeuro public merchant dictionary\nAfter=network-online.target\n'
            '[Service]\nType=oneshot\nExecStart=/usr/bin/python3 ' + str(INSTALLED / 'sync.py') + ' --pull\n'
            'TimeoutStartSec=100\nNoNewPrivileges=yes\nPrivateTmp=yes\nUMask=0022\n')
    timer = ('[Unit]\nDescription=Check CashNeuro merchant dictionary updates\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=1min\nRandomizedDelaySec=10s\n'
             '[Install]\nWantedBy=timers.target\n')
    atomic(Path('/etc/systemd/system/cashneuro-merchant-dictionary.service'), unit.encode())
    atomic(Path('/etc/systemd/system/cashneuro-merchant-dictionary.timer'), timer.encode())
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'cashneuro-merchant-dictionary.timer'])

def pull():
    ACTIVE.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    with (ACTIVE.parent / '.sync.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        command = ['runuser', '-u', 'finance-admin', '--', 'git', '-C', str(REPOSITORY)]
        run(command + ['fetch', '--quiet', 'origin', 'refs/heads/' + BRANCH + ':refs/remotes/origin/dictionary-sync'])
        raw = run(command + ['show', 'refs/remotes/origin/dictionary-sync:' + DATA_PATH])
        return publish(raw, json.loads((INSTALLED / 'targets.json').read_text()))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--install', type=Path)
    parser.add_argument('--pull', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('ROOT_REQUIRED')
    try:
        if args.install:
            install(args.install.resolve())
        elif args.pull:
            pull()
        else:
            raise ValueError('ACTION_REQUIRED')
    except Exception as error:
        # Dictionary contents, Git credentials and statement data never enter logs.
        raise SystemExit('Dictionary update failed: ' + type(error).__name__) from None
