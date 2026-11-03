"""Read-only Staging layout inspection; never emit unit environments or secrets."""
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request
import urllib.parse


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=20, check=False)
        return result.stdout if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def properties(unit):
    output = command(['systemctl', 'show', unit, '--property=WorkingDirectory,FragmentPath,DropInPaths,ActiveState'])
    return dict(line.split('=', 1) for line in (output or '').splitlines() if '=' in line)


def link(path):
    p = Path(path)
    return {'path': str(p), 'exists': p.exists(), 'symlink': p.is_symlink(), 'resolved': str(p.resolve()) if p.exists() else None}


def roots(node, hosts=()):
    result = []
    if isinstance(node, dict):
        matches = node.get('match', [])
        local = [host for match in matches if isinstance(match, dict) for host in match.get('host', [])]
        if local:
            hosts = tuple(local)
        value = node.get('root')
        if isinstance(value, str):
            result.append({'hosts': list(hosts), **link(value)})
        for key, child in node.items():
            if key not in ('match', 'root'):
                result.extend(roots(child, hosts))
    elif isinstance(node, list):
        for child in node:
            result.extend(roots(child, hosts))
    return result


if os.geteuid() != 0:
    raise SystemExit('Run this read-only inspection with sudo')
result = {'inspection': 'assistant-staging-layout/1', 'paidCalls': 0}
result['financeApi'] = properties('cashneuro-staging-api@finance.service')
result['controlApi'] = properties('cashneuro-staging-api@control.service')
result['backend'] = link('/srv/cashneuro/staging/backend-current')
result['frontendRoots'] = []
adapted = command(['caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--pretty'])
if adapted:
    try:
        result['frontendRoots'] = [row for row in roots(json.loads(adapted)) if 'test.cashneuro.ru' in row['hosts'] or not row['hosts']]
    except (ValueError, TypeError):
        result['caddyStatus'] = 'CONFIG_NOT_PARSED'
else:
    result['caddyStatus'] = 'CONFIG_UNAVAILABLE'
allowed = {'PORT', 'APP_ENV', 'API_PROFILE', 'API_BASE_URL', 'WEB_ORIGIN', 'AI_ENABLED', 'ASSISTANT_ENABLED'}
settings = {}
try:
    for line in Path('/etc/cashneuro/staging/finance-api.env').read_text().splitlines():
        match = re.fullmatch(r'\s*([A-Z_]+)\s*=\s*(.*?)\s*', line)
        if match and match.group(1) in allowed:
            key, value = match.group(1), match.group(2).strip('"\'')
            if key in {'API_BASE_URL', 'WEB_ORIGIN'}:
                parsed = urllib.parse.urlsplit(value)
                settings[key] = parsed.scheme + '://' + (parsed.hostname or '') + (':' + str(parsed.port) if parsed.port else '')
            elif key == 'PORT':
                settings[key] = value if value.isdigit() and len(value) <= 5 else 'OTHER'
            else:
                settings[key] = value if value in {'0', '1', 'staging', 'development', 'test', 'finance', 'control'} else 'OTHER'
except OSError:
    result['settingsStatus'] = 'UNAVAILABLE'
result['publicSettings'] = settings
try:
    port = int(settings.get('PORT', '3000'))
    if not 1 <= port <= 65535:
        raise ValueError()
    with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/health', timeout=5) as reply:
        health = json.load(reply)
    result['financeHealth'] = {key: health[key] if health[key] in {'ok', 'finance', 'control', 'cashneuro-assistant-workflow/7'} else 'OTHER' for key in ['status', 'profile', 'assistant'] if key in health}
except Exception:
    result['financeHealth'] = {'status': 'UNAVAILABLE'}
result['stagingPostgres'] = []
containers = command(['docker', 'ps', '--format', '{{.ID}}'])
for container in (containers or '').splitlines()[:50]:
    ports = command(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', container])
    try:
        bindings = json.loads(ports or '{}') or {}
    except ValueError:
        continue
    local = [p for p in bindings.get('5432/tcp') or [] if p.get('HostPort') == '5411']
    if local:
        result['stagingPostgres'].append({'id': container, 'bindings': local})
print(json.dumps(result, ensure_ascii=False, indent=2))
