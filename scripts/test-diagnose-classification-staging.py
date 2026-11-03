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

    def test_all_unresolved_account_requests_are_visible_even_outside_the_smoke_period(self):
        _, _, calls = self.run_inspection()
        sql = calls[-1][1]['input']
        blockers = sql.split('blockers AS (', 1)[1].split(')\nSELECT json_build_object', 1)[0]
        self.assertIn("r.state='sent' OR r.usage_state='unknown'", blockers)
        self.assertIn('r.user_id=(SELECT id FROM test_account)', blockers)
        self.assertNotIn('r.provider=', blockers)
        self.assertNotIn('r.created_at>=', blockers)
        self.assertIn('missing_cost_receipt', blockers)
        self.assertIn('LIMIT 30', sql)
        self.assertIn("state IN ('reserved','unknown')", sql)
        self.assertIn("'blockingCount'", sql)

    def test_query_whitelists_configuration_and_keeps_money_exact(self):
        sql = m.receipt_query({'apiKey':'API_KEY_NOT_FOR_SQL', 'unrelated':'OTHER_SECRET',
                              'allowedEmails':["o'connor@example.test"],
                              'cost':{'projectId':'test/reconciliation',
                                      'projectPeriodStart':'2026-10-30T12:00:00.123456Z',
                                      'private':'COST_SECRET'}})
        self.assertNotIn('API_KEY_NOT_FOR_SQL', sql)
        self.assertNotIn('OTHER_SECRET', sql)
        self.assertNotIn('COST_SECRET', sql)
        self.assertIn("o''connor@example.test", sql)
        self.assertIn('reserved_atoms::text', sql)
        self.assertIn('settled_atoms::text', sql)
        self.assertIn('BEGIN READ ONLY;', sql)
        self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
        for verb in ['UPDATE ', 'DELETE ', 'INSERT ', 'TRUNCATE ', 'ALTER ']:
            self.assertNotIn(verb, sql)

    def test_invalid_or_unbounded_account_scope_is_rejected(self):
        for emails in [None, [], ['a@example.test']*101, [123], ['x'*255]]:
            with self.assertRaisesRegex(m.InspectionError,'CONFIGURATION_SCOPE_INVALID'):
                m.receipt_query({'allowedEmails':emails})


if __name__=='__main__':
    unittest.main()
