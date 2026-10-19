import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('diagnose', Path(__file__).with_name('diagnose-classification-staging.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DiagnosisTests(unittest.TestCase):
    def run_inspection(self, *, failed=None, timeout=None, production=False):
        secret = 'SYNTHETIC_SECRET_NEVER_PRINT'
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == timeout:
                raise subprocess.TimeoutExpired(args, 6, stderr=secret)
            output = ''
            if args[0] == 'systemctl':
                output = 'Id=cashneuro-staging-api@finance.service\nActiveState=active\nEnvironment='+secret+'\n'
            elif args[:2] == ['docker', 'ps']:
                output = 'abcdef123456\n'
            elif args[:2] == ['docker', 'inspect']:
                output = json.dumps({'5432/tcp': [{'HostIp':'127.0.0.1','HostPort':'5412' if production else '5411'}]})
            elif args[:2] == ['docker', 'exec']:
                output = json.dumps({'databaseMatches':True,'classificationMigrationPresent':True,'receipts':[]})
            return types.SimpleNamespace(stdout=output, stderr=secret, returncode=1 if args[0] == failed else 0)
        stream = io.StringIO()
        settings = {'apiKey':secret, 'allowedEmails':[secret+'@example.test'],
                    'expiresAt':'2999-01-01T00:00:00Z','tariffCheckedAt':'2026-10-16T16:35:30Z'}
        with patch('os.geteuid',return_value=0), patch.object(Path,'lstat',return_value=types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_size=100)), patch.object(Path,'read_text',return_value=json.dumps(settings)), patch('subprocess.run',side_effect=run), contextlib.redirect_stdout(stream):
            code = m.main()
        text = stream.getvalue()
        self.assertNotIn(secret,text)
        self.assertNotIn('Environment',text)
        return code, [json.loads(line) for line in text.splitlines()], calls

    def test_read_only_receipts_with_progress_and_no_model_or_service_mutations(self):
        code, rows, calls = self.run_inspection()
        self.assertEqual(code,0)
        self.assertEqual(rows[0],{'step':'1/4','status':'START','paidCalls':0})
        self.assertEqual(rows[-1],{'step':'DONE','paidCalls':0})
        self.assertTrue(all(call[1]['timeout']<=9 for call in calls))
        args, options = calls[-1]
        self.assertEqual(args[:4],['docker','exec','-i','abcdef123456'])
        self.assertIn('-d finance_staging -Atq',args[-1])
        self.assertIn('BEGIN READ ONLY;', options['input'])
        self.assertIn('ROLLBACK;', options['input'])
        self.assertNotIn('5412',repr(calls))
        self.assertEqual([c[0][1] for c in calls if c[0][0]=='systemctl'],['--no-pager'])

    def test_failure_never_reflects_stderr_or_credentials(self):
        code, rows, _ = self.run_inspection(failed='docker')
        self.assertEqual(code,1)
        self.assertEqual(rows[-1]['code'],'COMMAND_EXIT_1')
        self.assertEqual(rows[-2],{'step':'3/4','status':'START'})

    def test_timeout_is_visible_at_the_step_that_started(self):
        code, rows, _ = self.run_inspection(timeout='docker')
        self.assertEqual(code,1)
        self.assertEqual(rows[-1]['code'],'COMMAND_TIMEOUT')
        self.assertEqual(rows[-2],{'step':'3/4','status':'START'})

    def test_production_binding_cannot_receive_a_query(self):
        code, rows, calls = self.run_inspection(production=True)
        self.assertEqual(code,1)
        self.assertEqual(rows[-1]['code'],'STAGING_DATABASE_LAYOUT_CHANGED')
        self.assertFalse(any(args[:2]==['docker','exec'] for args,_ in calls))


if __name__=='__main__':
    unittest.main()
