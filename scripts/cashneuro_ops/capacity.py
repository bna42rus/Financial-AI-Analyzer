"""Read-only S3 size monitoring. A failed measurement never blocks a backup.

List current objects, including encrypted packs and metadata. Old object versions
and incomplete multipart uploads are outside this metric; it is not a bill cap.
"""
from datetime import datetime, timezone
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import re
import time
from urllib.parse import quote
import xml.etree.ElementTree as ET

from .common import STATE, OpsError, emit, locked, private_dir, private_read, private_write

REFERENCE_BYTES = 10_000_000_000
MONITOR_LOCK = Path('/run/lock/cashneuro-storage-monitor.lock')
HOST = 's3.twcstorage.ru'


def signed_get(access_key, secret_key, host, path, query, now, region='ru-1'):
    """AWS SigV4; the caller pins the HTTPS host, region, method and bucket path."""
    stamp = now.strftime('%Y%m%dT%H%M%SZ')
    day = stamp[:8]
    payload_hash = hashlib.sha256(b'').hexdigest()
    signed = 'host;x-amz-content-sha256;x-amz-date'
    headers = 'host:' + host + '\nx-amz-content-sha256:' + payload_hash + '\nx-amz-date:' + stamp + '\n'
    canonical = '\n'.join(('GET', path, query, headers, signed, payload_hash))
    scope = day + '/' + region + '/s3/aws4_request'
    to_sign = '\n'.join(('AWS4-HMAC-SHA256', stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()))
    key = ('AWS4' + secret_key).encode()
    for value in (day, region, 's3', 'aws4_request'):
        key = hmac.new(key, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return {'Host': host, 'x-amz-content-sha256': payload_hash, 'x-amz-date': stamp,
            'Authorization': 'AWS4-HMAC-SHA256 Credential=' + access_key + '/' + scope +
                             ',SignedHeaders=' + signed + ',Signature=' + signature}


def list_page(config, token, deadline):
    params = {'list-type': '2', 'max-keys': '1000', 'encoding-type': 'url'}
    if token is not None:
        params['continuation-token'] = token
    query = '&'.join(quote(k, safe='-_.~') + '=' + quote(v, safe='-_.~') for k,v in sorted(params.items()))
    path = '/' + config['bucket']
    headers = signed_get(config['accessKey'], config['secretKey'], HOST, path, query, datetime.now(timezone.utc))
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise OpsError('S3_SIZE_CHECK_TIMEOUT')
    connection = http.client.HTTPSConnection(HOST, timeout=min(5,remaining))
    try:
        connection.request('GET', path + '?' + query, headers=headers)
        response = connection.getresponse()
        if response.status != 200:
            raise OpsError('S3_SIZE_CHECK_UNAVAILABLE')
        body = bytearray()
        while True:
            if time.monotonic() >= deadline:
                raise OpsError('S3_SIZE_CHECK_TIMEOUT')
            part = response.read1(65536)
            if not part:
                return bytes(body)
            body.extend(part)
            if len(body) > 4 * 1024**2:
                raise OpsError('S3_SIZE_RESPONSE_TOO_LARGE')
    finally:
        connection.close()


def current_objects(config):
    from .backups import validate_config
    validate_config(config)
    token = None
    seen = set()
    count = total = 0
    deadline = time.monotonic() + 30
    for page in range(100):
        root = ET.fromstring(list_page(config, token, deadline))
        if root.tag not in ('ListBucketResult', '{http://s3.amazonaws.com/doc/2006-03-01/}ListBucketResult'):
            raise OpsError('S3_SIZE_RESPONSE_INVALID')
        prefix = root.tag[:-len('ListBucketResult')]
        for item in root.findall(prefix + 'Contents'):
            size = item.findtext(prefix + 'Size', '')
            if not re.fullmatch(r'[0-9]{1,20}', size):
                raise OpsError('S3_SIZE_RESPONSE_INVALID')
            total += int(size)
            count += 1
        truncated = root.findtext(prefix + 'IsTruncated')
        if truncated == 'false':
            return {'currentObjectBytes':total, 'currentObjects':count, 'pages':page + 1,
                    'measurement':'s3-current-object-sizes/1', 'includesPreviousVersions':False,
                    'includesIncompleteMultipart':False}
        if truncated != 'true':
            raise OpsError('S3_SIZE_RESPONSE_INVALID')
        token = root.findtext(prefix + 'NextContinuationToken', '')
        if not token or len(token) > 8192 or token in seen:
            raise OpsError('S3_SIZE_PAGINATION_INVALID')
        seen.add(token)
    raise OpsError('S3_SIZE_PAGE_LIMIT')


def notify_growth(config, result, now):
    path = STATE / 'storage-last-alert.json'
    previous = json.loads(private_read(path)) if path.exists() else None
    if previous:
        elapsed = (now - datetime.fromisoformat(previous['at'])).total_seconds()
        if previous.get('accepted') and result['warningLevel'] <= previous['warningLevel'] and elapsed < 86400:
            return
        if not previous.get('accepted') and elapsed < 3600:
            return
    from .backups import alert
    try:
        alert(config, 'S3_STORAGE_GROWTH', capacity=result)
        accepted = True
    except Exception:
        accepted = False
    private_write(path, json.dumps({'at':now.isoformat(), 'warningLevel':result['warningLevel'], 'accepted':accepted}))
    emit('storage-growth-alert', accepted=accepted, warningLevel=result['warningLevel'])


def monitor(config):
    """All network/SMTP/state errors stay separate from backup success/failure."""
    try:
        private_dir(STATE)
        with locked(MONITOR_LOCK):
            now = datetime.now(timezone.utc)
            measured = current_objects(config)
            reference = config.get('capacityWarningBytes', REFERENCE_BYTES)
            percent = measured['currentObjectBytes'] * 100 // reference
            level = 100 if percent >= 100 else 90 if percent >= 90 else 80 if percent >= 80 else 0
            result = {**measured, 'at':now.isoformat(), 'warningReferenceBytes':reference,
                      'warningLevel':level, 'capacityStopEnabled':False, 'legacyQuotaIgnored':'quotaBytes' in config,
                      'measurementAvailable':True}
            private_write(STATE / 'storage-capacity.json', json.dumps(result))
            emit('storage-capacity', **result)
            if level:
                notify_growth(config, result, now)
            return result
    except Exception:
        # No raw exception: URLs/XML/provider/SMTP output can contain identifiers.
        emit('storage-capacity', measurementAvailable=False, capacityStopEnabled=False,
             code='S3_SIZE_CHECK_UNAVAILABLE', backupNotBlocked=True)
        try:
            path = STATE / 'storage-capacity.json'
            previous = json.loads(private_read(path)) if path.exists() else {}
            private_write(path, json.dumps({**previous, 'measurementAvailable':False,
                                           'capacityStopEnabled':False, 'lastErrorAt':datetime.now(timezone.utc).isoformat()}))
        except Exception:
            pass
        return None
