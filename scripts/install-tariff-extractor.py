"""Install two Ubuntu tools using a temporary signed official package source.

Never edit permanent APT/DNS settings, remove lock files, stop updates, or upgrade
the OS. Already installed trusted binaries require no package-manager operation.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

BINARIES = (Path('/usr/bin/pdftotext'), Path('/usr/bin/prlimit'))
LOCKS = (Path('/var/lib/dpkg/lock-frontend'), Path('/var/lib/dpkg/lock'), Path('/var/lib/apt/lists/lock'))


def emit(status):
    print(json.dumps({'step':'tariff-tools','status':status}),flush=True)


def ready():
    for path in BINARIES:
        try:
            info=path.stat()
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not os.access(path,os.X_OK):
            return False
    return True


def wait_for_package_manager(paths=LOCKS,timeout=300,interval=1):
    deadline=time.monotonic()+timeout
    next_report=0
    while True:
        busy=False
        for path in paths:
            try:
                fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
            except FileNotFoundError:
                continue
            try:
                try:
                    fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    fcntl.lockf(fd,fcntl.LOCK_UN)
                except BlockingIOError:
                    busy=True
            finally:
                os.close(fd)
        if not busy:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('SYSTEM_UPDATES_STILL_RUNNING')
        if time.monotonic() >= next_report:
            emit('WAITING_FOR_SYSTEM_UPDATES')
            next_report=time.monotonic()+10
        time.sleep(interval)


def official_sources(codename,architecture):
    if not re.fullmatch('[a-z][a-z0-9]{1,30}',codename):
        raise RuntimeError('UBUNTU_RELEASE_INVALID')
    if architecture in ('amd64','amd64v3','i386'):
        archive='https://archive.ubuntu.com/ubuntu'
        security='https://security.ubuntu.com/ubuntu'
    elif architecture in ('arm64','armhf','ppc64el','riscv64','s390x'):
        archive=security='https://ports.ubuntu.com/ubuntu-ports'
    else:
        raise RuntimeError('UBUNTU_ARCHITECTURE_UNSUPPORTED')
    signed='[signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg]'
    return '\n'.join('deb '+signed+' '+host+' '+suite+' main universe' for host,suite in
                     ((archive,codename),(archive,codename+'-updates'),(security,codename+'-security')))+'\n'


def install():
    if os.geteuid()!=0:
        raise RuntimeError('ROOT_REQUIRED')
    if ready():
        emit('ALREADY_READY')
        return
    release=dict(line.split('=',1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if release.get('ID','').strip('"')!='ubuntu':
        raise RuntimeError('UBUNTU_REQUIRED')
    architecture=subprocess.check_output(['/usr/bin/dpkg','--print-architecture'],text=True).strip()
    sources=official_sources(release.get('VERSION_CODENAME','').strip('"'),architecture)
    if not Path('/usr/share/keyrings/ubuntu-archive-keyring.gpg').is_file():
        raise RuntimeError('UBUNTU_ARCHIVE_KEYRING_REQUIRED')
    wait_for_package_manager()
    with tempfile.TemporaryDirectory(prefix='cashneuro-apt-') as temporary:
        directory=Path(temporary);directory.chmod(0o755)
        source=directory/'official.list';source.write_text(sources);source.chmod(0o644)
        options=['-o','Dir::Etc::sourcelist='+str(source),'-o','Dir::Etc::sourceparts=-',
                 '-o','APT::Get::List-Cleanup=false','-o','APT::Update::Error-Mode=any',
                 '-o','DPkg::Lock::Timeout=300','-o','Acquire::Retries=2',
                 '-o','Acquire::http::Timeout=20','-o','Acquire::https::Timeout=20']
        emit('INSTALLING_FROM_OFFICIAL_UBUNTU')
        env={**os.environ,'DEBIAN_FRONTEND':'noninteractive'}
        # No subprocess timeout: never kill dpkg midway through installation.
        for action in (['update'],['install','-y','--no-install-recommends','poppler-utils','util-linux']):
            if subprocess.run(['/usr/bin/apt-get',*options,*action],env=env,check=False).returncode:
                raise RuntimeError('TARIFF_TOOLS_INSTALL_FAILED')
    if not ready():
        raise RuntimeError('TARIFF_TOOLS_NOT_READY')
    emit('READY')


if __name__=='__main__':
    try:
        install()
    except Exception as error:
        code=str(error) if isinstance(error,RuntimeError) and re.fullmatch('[A-Z_]{1,80}',str(error)) else 'TARIFF_TOOLS_INSTALL_FAILED'
        print(json.dumps({'step':'tariff-tools','status':'STOP','code':code}),flush=True)
        raise SystemExit(1)
