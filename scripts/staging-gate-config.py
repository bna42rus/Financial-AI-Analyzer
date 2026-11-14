"""Replace only Staging's outer Basic Auth; keep its existing credential verifier."""
import re
from pathlib import Path
START = b'# BEGIN CASHNEURO STAGING GATE'
END = b'# END CASHNEURO STAGING GATE'
def configure(data):
    for host in (b'test.cashneuro.ru', b'admin.test.cashneuro.ru'):
        data = configure_site(data, host)
    return data

def configure_site(data, host):
    matches = list(re.finditer(rb'(?m)^' + re.escape(host) + rb'\s*\{', data))
    if len(matches) != 1:
        raise ValueError('STAGING_GATE_SITE_NOT_UNIQUE')
    a = matches[0].end(); level = 1; b = a
    while b < len(data) and level:
        level += (data[b:b+1] == b'{') - (data[b:b+1] == b'}'); b += 1
    if level:
        raise ValueError('STAGING_GATE_SITE_UNCLOSED')
    block = data[a:b-1]
    if START in block:
        if block.count(START) != 1 or block.count(END) != 1:
            raise ValueError('STAGING_GATE_MARKERS_INVALID')
        return data
    auth = list(re.finditer(rb'(?ms)(?<!\S)basic_auth(?:[ \t]+[^\n{]+)?[ \t\r\n]*\{[^{}]+\}', block))
    if len(auth) != 1:
        raise ValueError('STAGING_GATE_AUTH_NOT_UNIQUE')
    original = re.sub(rb'^basic_auth(?:[ \t]+(?:\*|@[A-Za-z0-9_-]+))?', b'basic_auth', auth[0].group(0).strip(), count=1)
    replacement = b'''\n    ''' + START + b'''
    handle /__staging/credentials {
        route {
            @external not remote_ip 127.0.0.1 ::1
            respond @external 404
            ''' + original + b'''
            respond "" 204
        }
    }
    @staging_protected not path /__staging/*
    forward_auth @staging_protected 127.0.0.1:18182 {
        uri /__staging/verify
    }
    handle /__staging/* {
        reverse_proxy 127.0.0.1:18182
    }
    ''' + END + b'\n'
    block = block[:auth[0].start()] + replacement + block[auth[0].end():]
    return data[:a] + block + data[b-1:]

def install(release, write, run, replace):
    key = Path('/etc/cashneuro/staging/gate.key')
    if not key.exists():
        import secrets
        write(key, secrets.token_bytes(32))
    unit = Path('/etc/systemd/system/cashneuro-staging-gate.service')
    replace(unit, ('''[Unit]
Description=CashNeuro Staging outer login
After=network.target
[Service]
Type=exec
DynamicUser=yes
SupplementaryGroups=cashneuro-staging-code
LoadCredential=gate-key:/etc/cashneuro/staging/gate.key
ExecStart=/usr/bin/node ''' + str(release / 'scripts/staging-gate.mjs') + '''
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6
[Install]
WantedBy=multi-user.target
''').encode())
    run(['systemctl','daemon-reload'])
    run(['systemctl','enable','cashneuro-staging-gate.service'])
    run(['systemctl','restart','cashneuro-staging-gate.service'])

    # Do not activate a frontend that depends on an unavailable outer login.
    import time
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(10):
        try:
            with opener.open('http://127.0.0.1:18182/__staging/health', timeout=2) as response:
                if response.status == 200 and response.read(32) == b'ok':
                    return
        except OSError:
            pass
        time.sleep(0.5)
    raise RuntimeError('STAGING_GATE_NOT_HEALTHY')
