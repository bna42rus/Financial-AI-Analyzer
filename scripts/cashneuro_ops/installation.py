"""Interactive private setup and idempotent systemd timers; no provider purchases."""
import json
import os
from pathlib import Path
import re
import shutil
import sys
import termios

from . import backups
from .common import CONFIG, STATE, OpsError, emit, env_file, private_dir, private_write, run, settings

LIB = Path('/usr/local/lib/cashneuro-ops')


def prompt(message, *, secret=False, default=None):
    # Mobile SSH clients can leave the TTY in raw/CR mode. Buffered text readline
    # can wait indefinitely for another byte after CR. Normalize this one prompt,
    # read bytes directly, and always restore the caller's terminal settings.
    try:
        fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY | os.O_CLOEXEC)
    except OSError:
        raise OpsError('INTERACTIVE_TERMINAL_REQUIRED') from None
    original = None
    try:
        original = termios.tcgetattr(fd)
        normal = original[:]
        normal[6] = original[6][:]
        normal[0] = (normal[0] | termios.ICRNL) & ~(termios.IGNCR | termios.INLCR)
        normal[1] |= termios.OPOST | termios.ONLCR
        normal[3] |= termios.ICANON | termios.ISIG
        if secret:
            normal[3] &= ~(termios.ECHO | termios.ECHONL)
        else:
            normal[3] |= termios.ECHO
        termios.tcsetattr(fd, termios.TCSANOW, normal)
        label = message.rstrip().rstrip(':') + (f' [{default}]' if default is not None and not secret else '') + ': '
        os.write(fd, label.encode('utf-8'))
        value = bytearray()
        while True:
            char = os.read(fd, 1)
            if not char:
                raise OpsError('TERMINAL_INPUT_CLOSED')
            if char in (b'\r', b'\n'):
                break
            value.extend(char)
            if len(value) > 8192:
                raise OpsError('TERMINAL_INPUT_TOO_LONG')
        answer = value.decode('utf-8')
        if not secret:
            answer = answer.strip()
            if not answer and default is not None:
                return default
            if not answer:
                raise OpsError('CONFIGURATION_VALUE_REQUIRED')
        return answer
    finally:
        try:
            if original is not None:
                try:
                    if secret:
                        os.write(fd, b'\n')
                finally:
                    termios.tcsetattr(fd, termios.TCSANOW, original)
        finally:
            os.close(fd)


def configure(replace=False):
    private_dir(STATE)
    private_dir(CONFIG.parent)
    if CONFIG.exists() and not replace:
        return backups.validate_config(settings())
    previous = settings() if CONFIG.exists() else {}
    emit('s3-setup', status='INPUT_REQUIRED', note='Секреты вводятся только в терминале. Сохраните пароль резервных копий отдельно от сервера.')
    default_email = ''
    path = Path('/etc/cashneuro/staging/control-mail.env')
    if path.exists():
        default_email = env_file(path).get('MAIL_ADMIN_RECIPIENT', '')
    def secret_value(name,label):
        value = prompt(label + (' (Enter — сохранённое значение): ' if previous else ': '), secret=True)
        return value or previous.get(name, '')
    quota = prompt('Фактический установленный объём вашего S3-бакета в ГБ (тариф не меняется)', default=str(previous.get('quotaBytes',1_000_000_000)//1_000_000_000))
    if not re.fullmatch('[1-9][0-9]{0,4}', quota):
        raise OpsError('BACKUP_QUOTA_INVALID')
    config = {'version': 'cashneuro-ops/1', 'endpoint': 'https://s3.twcstorage.ru',
              'quotaBytes': int(quota) * 1000**3, 'bucket': prompt('Имя существующего приватного S3-бакета', default=previous.get('bucket')),
              'accessKey': secret_value('accessKey','S3 Access Key'), 'secretKey': secret_value('secretKey','S3 Secret Key'),
              'password': secret_value('password','Пароль резервных архивов (от 20 символов; для существующих репозиториев тот же пароль)'),
              'alertEmail': prompt('Ваш email для уведомлений об ошибках', default=previous.get('alertEmail') or default_email or None),
              'policy': {'productionDaily': 7, 'predeploy': 2, 'stagingPredeploy': 2}}
    if len(config['password']) < 20 or config['password'] != prompt('Повторите пароль резервных архивов: ', secret=True):
        raise OpsError('BACKUP_PASSWORD_CONFIRMATION_FAILED')
    if not re.fullmatch(r'[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+', config['alertEmail']):
        raise OpsError('ALERT_RECIPIENT_INVALID')
    backups.validate_config(config)
    # Existing Postbox configuration is needed by the independent failure notifier.
    from .common import private_read
    mail = json.loads(private_read('/etc/cashneuro/mail/staging-postbox.json'))
    if not all(isinstance(mail.get(k), str) and mail[k] for k in ('username', 'password')):
        raise OpsError('ALERT_POSTBOX_CONFIGURATION_MISSING')
    # Save privately before initializing repositories, so an interrupted setup is resumable.
    if previous:
        private_write(CONFIG.with_name('ops.previous.json'), json.dumps(previous))
    private_write(CONFIG, json.dumps(config))
    emit('s3-setup', status='SAVED_PRIVATE', automaticTariffUpgrade=False)
    return config


def install_units(root=Path('/etc/systemd/system')):
    service = """[Unit]
Description=CashNeuro encrypted backup (%i)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cashneuro-ops scheduled %i
UMask=0077
Nice=15
IOSchedulingClass=idle
CPUWeight=10
MemoryMax=768M
TimeoutStartSec=2h
LimitCORE=0
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/cashneuro-ops /run/lock
RestrictSUIDSGID=yes
"""
    definitions = {
        'production': ('*-*-* 03:10:00 Europe/Moscow', True),
        'journal': ('*:0/5', False),
        'restore-production': ('*-*-01 04:10:00 Europe/Moscow', True),
        'restore-staging': ('*-*-02 04:10:00 Europe/Moscow', True),
        'watchdog': ('hourly', True),
    }
    # Atomic writes preserve intended public unit permissions; configuration remains private.
    def unit_write(path, content):
        import os
        import tempfile
        fd, temporary = tempfile.mkstemp(prefix='.cashneuro-', dir=root)
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    unit_write(root / 'cashneuro-backup@.service', service)
    timers = []
    for name, (calendar, persistent) in definitions.items():
        timer = 'cashneuro-backup-' + name + '.timer'
        text = f"""[Unit]
Description=CashNeuro backup schedule ({name})

[Timer]
OnCalendar={calendar}
AccuracySec=30s
Persistent={'true' if persistent else 'false'}
Unit=cashneuro-backup@{name}.service

[Install]
WantedBy=timers.target
"""
        unit_write(root / timer, text)
        timers.append(timer)
    retention_service = """[Unit]
Description=CashNeuro bounded release retention
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cashneuro-ops prune --apply
Nice=15
IOSchedulingClass=idle
UMask=0077
TimeoutStartSec=30min
"""
    unit_write(root / 'cashneuro-release-retention.service', retention_service)
    unit_write(root / 'cashneuro-release-retention.timer', """[Timer]
OnCalendar=*-*-* 05:20:00 Europe/Moscow
Persistent=true
Unit=cashneuro-release-retention.service

[Install]
WantedBy=timers.target
""")
    timers.append('cashneuro-release-retention.timer')
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', *timers])
    emit('maintenance-timers', enabled=timers, timezone='Europe/Moscow')


def setup():
    if not Path(backups.RESTIC_BIN).is_file():
        raise OpsError('RESTIC_NOT_INSTALLED')
    version = run([backups.RESTIC_BIN, 'version']).decode()
    match = re.search(r'restic (\d+)\.(\d+)\.(\d+)', version)
    if not match or tuple(map(int, match.groups())) < (0, 17, 0):
        raise OpsError('RESTIC_0_17_OR_NEWER_REQUIRED')
    config = configure()
    for environment in ('staging', 'production'):
        for journal in (False, True):
            backups.initialize(config, environment, journal)
    # First readable uploads and a real restore test precede enabling schedules.
    backups.backup(config, 'staging', 'predeploy')
    backups.backup(config, 'production', 'daily')
    backups.restore_test(config, 'staging')
    backups.restore_test(config, 'production')
    from .sizing import benchmark
    benchmark()
    install_units()
    emit('setup-complete', encryptedS3=True, paidModelCalls=0, restorePublicAccess=False)
