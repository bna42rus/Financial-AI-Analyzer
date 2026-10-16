import contextlib
import io
import json
from pathlib import Path
import runpy
import types
import unittest
from unittest.mock import patch


class InspectionPrivacy(unittest.TestCase):
    def test_only_paths_public_settings_and_staging_ports_leave_the_inspection(self):
        secret = 'SYNTHETIC_SECRET_MUST_NOT_LEAVE_INSPECTION'
        def run(args, **kwargs):
            output = ''
            if args[0] == 'systemctl':
                output = 'ActiveState=active\nWorkingDirectory=/srv/cashneuro/staging/backend-current/apps/api\n'
            elif args[0] == 'caddy':
                output = json.dumps({'routes': [{'match': [{'host': ['test.cashneuro.ru']}], 'handle': [{'root': '/srv/cashneuro/staging/web-current', 'password': secret}]}]})
            elif args[:2] == ['docker', 'ps']:
                output = 'staging-container\n'
            elif args[:2] == ['docker', 'inspect']:
                output = json.dumps({'5432/tcp': [{'HostPort': '5411', 'HostIp': '127.0.0.1'}]})
            return types.SimpleNamespace(stdout=output, returncode=0)
        stream = io.StringIO()
        with patch('os.geteuid', return_value=0), patch('subprocess.run', side_effect=run), patch.object(Path, 'read_text', return_value='APP_ENV=staging\nPORT=3000\nDATABASE_URL='+secret+'\nAUTH_SECRET='+secret+'\nAPI_BASE_URL=https://user:'+secret+'@test.cashneuro.ru\n'), patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps({'status':'ok','profile':'finance','untrusted':secret}).encode())), contextlib.redirect_stdout(stream):
            runpy.run_path(str(Path(__file__).with_name('inspect-assistant-staging.py')))
        text = stream.getvalue()
        self.assertNotIn(secret, text)
        self.assertNotIn('DATABASE_URL', text)
        result = json.loads(text)
        self.assertEqual(result['publicSettings']['API_BASE_URL'], 'https://test.cashneuro.ru')
        self.assertEqual(result['stagingPostgres'][0]['bindings'][0]['HostPort'], '5411')
        self.assertEqual(result['frontendRoots'][0]['hosts'], ['test.cashneuro.ru'])


if __name__ == '__main__':
    unittest.main()
