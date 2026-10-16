#!/usr/bin/env python3
"""Save a Cloud.ru benchmark-only key. Never enable application AI."""
import getpass
import json
import os
import pathlib
import re
import stat
import sys
import warnings

def main():
    if os.geteuid() != 0:
        sys.exit('Выполни через sudo.')
    os.umask(0o077)
    directory = pathlib.Path('/etc/cashneuro/ai/benchmark')
    parent = pathlib.Path('/')
    for name in directory.parts[1:]:
        parent /= name
        try:
            parent.mkdir(mode=0o700)
        except FileExistsError:
            pass
        meta = parent.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            sys.exit('Небезопасная папка настроек. Ключ не сохранялся.')
    target = directory / 'provider-keys.json'
    if target.exists() or target.is_symlink():
        sys.exit('Файл ключей уже существует. Он не перезаписан.')
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        with open('/dev/tty', 'w') as tty:
            secret = getpass.getpass('Cloud.ru Key Secret (ввод скрыт): ', stream=tty)
    if not re.fullmatch(r'[\x21-\x7e]{20,512}', secret):
        sys.exit('Неверный формат Key Secret. Ключ не сохранялся.')
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump({'cloud': {'apiKey': secret}}, output)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    print('Cloud.ru: ключ сохранён с правами 0600. AI на сайте не включался.')

if __name__ == '__main__':
    try:
        main()
    except getpass.GetPassWarning:
        sys.exit('Скрытый ввод недоступен. Подключись к VPS через интерактивный SSH-терминал.')
    except (OSError, EOFError):
        sys.exit('Сохранение не завершено. Секрет не выводился.')
