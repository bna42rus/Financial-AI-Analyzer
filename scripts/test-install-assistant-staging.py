import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-assistant-staging.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class InstallationTests(unittest.TestCase):
    def test_frontend_requires_one_exclusive_test_host(self):
        def route(host, root):
            return {'match': [{'host': [host]}], 'handle': [{'handler': 'vars', 'root': root}]}
        config = {'routes': [route('test.cashneuro.ru', '/srv/test/web'), route('admin.test.cashneuro.ru', '/srv/admin')]}
        self.assertEqual(m.frontend_root(config), '/srv/test/web')
        config['routes'][1]['handle'][0]['root'] = '/srv/test/web'
        with self.assertRaisesRegex(m.InstallationError, 'SHARED_FRONTEND'):
            m.frontend_root(config)
        with self.assertRaisesRegex(m.InstallationError, 'LAYOUT_CHANGED'):
            m.frontend_root({'routes': [route('example.test', '/srv/web')]})

    def test_only_a_contiguous_migration_prefix_is_admitted(self):
        for n in range(5):
            self.assertEqual(m.migration_prefix([True] * n + [False] * (4-n)), n)
        for state in [[False, True, False, False], [True, False, True, True]]:
            with self.assertRaises(m.InstallationError):
                m.migration_prefix(state)

    def test_failed_command_never_exposes_stderr_or_stdout(self):
        result = subprocess.CompletedProcess(['docker'], 1, b'private database password', b'private model key')
        with patch.object(m.subprocess, 'run', return_value=result):
            with self.assertRaises(m.InstallationError) as caught:
                m.run(['docker', 'exec', 'synthetic'])
        self.assertEqual(str(caught.exception), 'COMMAND_FAILED:docker')

    def test_private_snapshots_are_exclusive_and_replacement_keeps_original_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'snapshot'
            m.private_write(path, b'original')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                m.private_write(path, b'overwrite')
            with patch.object(m.os, 'chown'):
                m.atomic_replace(path, b'replacement', 0o640, os.getuid(), os.getgid())
            self.assertEqual(path.read_bytes(), b'replacement')
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_rollback_restores_api_and_frontend_without_touching_database_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backup = root / 'backup'
            backup.mkdir()
            (backup / 'caddy').write_bytes(b'old caddy')
            metadata = {'mode': 0o644, 'uid': os.getuid(), 'gid': os.getgid()}
            (backup / 'rollback.json').write_text(json.dumps({'caddy': metadata, 'dropin': None}))
            caddy, dropin = root / 'Caddyfile', root / '99-assistant.conf'
            caddy.write_bytes(b'new caddy')
            dropin.write_bytes(b'new provider')
            commands = []
            with patch.object(m, 'CADDY', caddy), patch.object(m, 'DROPIN', dropin), patch.object(m.os, 'chown'), patch.object(m, 'run', side_effect=lambda args, **kw: commands.append(args) or b''), patch.object(m, 'wait_health'):
                m.restore(backup)
            self.assertEqual(caddy.read_bytes(), b'old caddy')
            self.assertFalse(dropin.exists())
            self.assertIn(['systemctl', 'restart', m.UNIT], commands)
            self.assertFalse(any('docker' in command or 'psql' in command for command in commands))


if __name__ == '__main__':
    unittest.main()
