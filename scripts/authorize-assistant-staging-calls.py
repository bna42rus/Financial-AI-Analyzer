#!/usr/bin/env python3
"""Apply the owner's existing cumulative 70-call authorization, never reset usage.

Only the expired, known Staging admission may change from 60 to 70. The usual
release admission subsequently reads actual database dispatches/costs, checks
unresolved reservations, verifies the public tariff and renews the admission.
This helper sends no HTTP requests and never edits database accounting.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

CONFIG = Path('/etc/cashneuro/ai/assistant-staging.json')
AUDIT_ROOT = Path('/var/lib/cashneuro')
REQUEST = '115403a1-e063-4b2e-9876-f7e6123b26b1'
PROJECT = 'staging/assistant-5859b601e6fd1b12c01bed1d'
LOCK = '/run/lock/cashneuro-assistant-install.lock'


def private_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError('PRIVATE_CONFIGURATION_REQUIRED')
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('CONFIGURATION_TOO_LARGE')
    return raw


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def planned_settings(value, now):
    result = json.loads(json.dumps(value))
    admission = result['admission']
    maximum, used, remaining = admission['stageMaximumCalls'], admission['calls'], result['maximumCalls']
    if any(type(n) is not int for n in (maximum, used, remaining)) or maximum not in (60, 70) or used < 0 or remaining < 1 or maximum - used != remaining:
        raise ValueError('CUMULATIVE_CALL_ACCOUNTING_CHANGED')
    if result['realm'] != 'staging/finance' or result['cost']['projectId'] != PROJECT or admission['stageCapAtoms'] != '10000000000':
        raise ValueError('STAGING_AUTHORIZATION_CHANGED')
    if any(datetime.fromisoformat(result[key].replace('Z', '+00:00')) > now for key in ('expiresAt',)) or datetime.fromisoformat(result['cost']['projectPeriodEnd'].replace('Z', '+00:00')) > now:
        raise ValueError('ACTIVE_ADMISSION_REQUIRES_REVIEW')
    if maximum == 60:
        admission['stageMaximumCalls'] = 70
        result['maximumCalls'] = remaining + 10
    return result


def authorize(config, audit_root, apply, now):
    root = audit_root.lstat()
    if not stat.S_ISDIR(root.st_mode) or root.st_uid != 0 or root.st_mode & 0o022:
        raise ValueError('PRIVATE_AUDIT_DIRECTORY_REQUIRED')
    attestation = json.loads(private_read(audit_root / ('ai-unbilled-reconciliation-' + REQUEST + '.json')))
    if attestation.get('requestId') != REQUEST or attestation.get('status') != 'OPERATOR_ATTESTATION' or attestation.get('scope') != 'staging only' or attestation.get('reservationAtoms') != '2328657920':
        raise ValueError('RECONCILIATION_ATTESTATION_REQUIRED')
    raw = private_read(config)
    previous = json.loads(raw)
    updated = planned_settings(previous, now)
    changed = updated != previous
    public = {'status': 'PREVIEW', 'cumulativeCallLimit': 70, 'usageReset': False,
              'paidCalls': 0, 'configurationChanged': False,
              'admissionRenewed': False, 'databaseAccountingChanged': False}
    if not apply or not changed:
        return {**public, 'status': 'ALREADY_AUTHORIZED' if apply else 'PREVIEW'}
    backup = Path(tempfile.mkdtemp(prefix='assistant-call-limit-70-', dir=audit_root))
    private_write(backup / 'assistant-staging.before.json', raw)
    encoded = (json.dumps(updated, ensure_ascii=False) + '\n').encode()
    audit = {'authorization': 'Owner-approved cumulative 70 calls; existing 10 RUB cap unchanged',
             'previousSha256': hashlib.sha256(raw).hexdigest(),
             'nextSha256': hashlib.sha256(encoded).hexdigest(),
             'oldCeiling': 60, 'newCeiling': 70, 'callsAlreadyAccounted': previous['admission']['calls'],
             'createdAt': now.isoformat(), 'paidCalls': 0, 'usageReset': False}
    private_write(backup / 'authorization.json', (json.dumps(audit) + '\n').encode())
    sync_directory(backup)
    sync_directory(audit_root)
    # Recheck the exact config after writing the durable private recovery copy.
    if private_read(config) != raw:
        raise ValueError('CONFIGURATION_CHANGED')
    fd, temporary = tempfile.mkstemp(prefix='.assistant-call-limit-', dir=config.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, config)
        directory = os.open(config.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {**public, 'status': 'AUTHORIZED', 'configurationChanged': True, 'privateBackup': str(backup)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--cumulative-call-limit', type=int, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or args.cumulative_call_limit != 70:
        raise ValueError('EXPLICIT_ROOT_AUTHORIZATION_REQUIRED')
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(authorize(CONFIG, AUDIT_ROOT, args.apply, datetime.now(timezone.utc))))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        code = str(error)
        if not code or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_' for c in code):
            code = 'STAGING_AUTHORIZATION_UNAVAILABLE'
        print(json.dumps({'status': 'STOP', 'code': code, 'paidCalls': 0}))
        raise SystemExit(1)
