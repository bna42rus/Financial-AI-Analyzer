"""Replace only the Staging API key via hidden TTY input; keep budget settings.

Validate with an invalid, non-inference completion request before saving.
"""
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess

CHECK = r"""
import {readFileSync} from 'node:fs';
const {apiKey}=JSON.parse(readFileSync(0,'utf8'));
try{
 const r=await fetch('https://foundation-models.api.cloud.ru/v1/chat/completions',{
  method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},
  body:'{}',redirect:'error',signal:AbortSignal.timeout(12000)});
 const reader=r.body?.getReader();let text='',n=0;
 if(reader)try{while(n<16384){const p=await reader.read();if(p.done)break;n+=p.value.length;text+=new TextDecoder().decode(p.value.slice(0,16384-text.length));}}finally{await reader.cancel();}
 const accepted=[400,422].includes(r.status)&&/\b(?:model|messages)\b/iu.test(text)&&/required|missing|field/iu.test(text);
 console.log(JSON.stringify({accepted,httpStatus:r.status}));
}catch{console.log(JSON.stringify({accepted:false}));}
"""


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    if os.geteuid() != 0:
        raise RuntimeError('ROOT_REQUIRED')
    with open('/dev/tty', 'r+') as tty:
        value = getpass.getpass('Новый Key Secret Foundation Models (скрытый ввод): ', stream=tty).strip()
    if not re.fullmatch(r'[\x21-\x7e]{20,512}', value):
        raise RuntimeError('KEY_FORMAT_INVALID')
    checked = subprocess.run(['/usr/bin/node', '--input-type=module', '-e', CHECK],
                             input=json.dumps({'apiKey': value}), text=True,
                             capture_output=True, timeout=18, check=False)
    result = json.loads(checked.stdout)
    if not result.get('accepted'):
        print(json.dumps({'status': 'KEY_NOT_SAVED', 'httpStatus': result.get('httpStatus'), 'modelCalls': 0}))
        return 1
    path = Path('/etc/cashneuro/ai/assistant-staging.json')
    lock = os.open('/run/cashneuro-staging-key-rotation.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 65536 or path.resolve() != path:
            raise RuntimeError('PRIVATE_CONFIGURATION_REQUIRED')
        original = path.read_bytes()
        settings = json.loads(original)
        if settings.get('realm') != 'staging/finance':
            raise RuntimeError('STAGING_CONFIGURATION_REQUIRED')
        settings['apiKey'] = value
        backup = path.with_name(path.name + '.key-backup-' + secrets.token_hex(8))
        private_write(backup, original)
        temporary = path.with_name('.assistant-key-' + secrets.token_hex(8))
        try:
            private_write(temporary, (json.dumps(settings, ensure_ascii=False) + '\n').encode())
            if path.read_bytes() != original:
                raise RuntimeError('CONFIGURATION_CHANGED')
            os.replace(temporary, path)
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            temporary.unlink(missing_ok=True)
        try:
            restart = subprocess.run(['systemctl', 'restart', 'cashneuro-staging-api@finance.service'], capture_output=True, timeout=60, check=False)
            restarted = restart.returncode == 0
        except subprocess.SubprocessError:
            restarted = False
        status = 'UPDATED' if restarted else 'KEY_SAVED_API_RESTART_FAILED'
        print(json.dumps({'status': status, 'backup': str(backup), 'modelCalls': 0}, ensure_ascii=False))
        return 0 if restarted else 1
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{1,80}', str(error)) else 'KEY_ROTATION_FAILED'
        print(json.dumps({'status': 'STOP', 'code': code, 'modelCalls': 0}))
        raise SystemExit(1)
