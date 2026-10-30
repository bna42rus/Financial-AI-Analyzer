import importlib.util
import ast
import inspect
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('update', Path(__file__).with_name('update-staging-release.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class UpdateTests(unittest.TestCase):
    def test_upgrade_accepts_previous_workflow_only_before_switch(self):
        function = ast.parse(inspect.getsource(m.install)).body[0]
        calls = sorted([n for n in ast.walk(function) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id == 'm' and n.func.attr == 'wait_health'], key=lambda n:n.lineno)
        self.assertGreaterEqual(len(calls), 2)
        self.assertFalse(calls[0].args[0].value)
        self.assertTrue(all(call.args[0].value is True for call in calls[1:]))
        for version, expected in [('cashneuro-assistant-workflow/6', False), ('cashneuro-assistant-workflow/7', True)]:
            payload = json.dumps({'status':'ok','profile':'finance','assistant':version}).encode()
            with patch.object(m.m.urllib.request,'urlopen',side_effect=lambda *a,**k:io.BytesIO(payload)):
                self.assertTrue(m.m.health(False))
                self.assertEqual(m.m.health(True), expected)

    def test_renewed_rollback_and_candidate_share_one_carried_budget_and_cannot_expand_authority(self):
        previous = {'realm':'staging/finance','apiKey':'synthetic-only','allowedEmails':['owner@example.test'],'modelMetadataSha256':'b'*64,'tariffSource':'fixed',
                    'maximumCalls':14,'admission':{'stageCapAtoms':'10000000000','stageMaximumCalls':60,'spentAtoms':'100','calls':46},'cost':{'projectId':'staging/test','price':{'input':'15.86'}}}
        candidate = json.loads(json.dumps(previous))
        candidate.update(sourceSha256='d'*64,maximumCalls=10)
        candidate['admission'].update(spentAtoms='200',calls=50)
        fallback = {**candidate,'sourceSha256':'a'*64}
        m.validate_admission_pair(previous,candidate,fallback,'a'*64,'d'*64)
        for field,value in [('apiKey','foreign-key'),('allowedEmails',['other@example.test']),('maximumCalls',15)]:
            bad={**candidate,field:value}
            with self.assertRaises(m.m.InstallationError):
                m.validate_admission_pair(previous,bad,{**bad,'sourceSha256':'a'*64},'a'*64,'d'*64)
        with self.assertRaises(m.m.InstallationError):
            m.validate_admission_pair(previous,candidate,{**fallback,'maximumCalls':14},'a'*64,'d'*64)

    def test_classification_rebind_preserves_key_call_ceiling_expiry_and_accounting(self):
        previous = {'sourceSha256': 'a'*64, 'apiKey': 'synthetic-only', 'maximumCalls': 14, 'admission': {'calls': 46}, 'expiresAt': '2026-10-17T16:35:30Z', 'cost': {'projectLimitRub': '5.5'}}
        changed = m.rebind_classification_settings(previous, 'a'*64, 'b'*64)
        self.assertEqual({**changed, 'sourceSha256': 'a'*64}, previous)
        changed['admission']['calls'] = 0
        self.assertEqual(previous['admission']['calls'], 46)
        with self.assertRaises(m.m.InstallationError):
            m.rebind_classification_settings(previous, 'c'*64, 'b'*64)

    def test_only_the_finance_staging_origin_is_admitted(self):
        self.assertEqual(m.validate_origin('https://test.cashneuro.ru/'), 'https://test.cashneuro.ru')
        self.assertEqual(m.validate_origin('https://test.cashneuro.ru/api'), 'https://test.cashneuro.ru/api')
        for value in ['https://cashneuro.ru', 'http://test.cashneuro.ru', 'https://secret@test.cashneuro.ru', 'https://test.cashneuro.ru/?token=private']:
            with self.assertRaises(m.m.InstallationError):
                m.validate_origin(value)

    def test_a_demo_artifact_or_different_revision_cannot_replace_connected_ui(self):
        sha = 'a' * 40
        manifest = {'schema':'cashneuro-web-build/1','revision':sha,'profile':'finance','mode':'connected','apiOrigin':'https://test.cashneuro.ru'}
        m.validate_manifest(manifest, sha, manifest['apiOrigin'])
        for change in [{'mode':'demo'}, {'revision':'b'*40}, {'apiOrigin':'https://foreign.example'}]:
            with self.assertRaises(m.m.InstallationError):
                m.validate_manifest({**manifest, **change}, sha, manifest['apiOrigin'])

    def test_import_worker_uses_scoped_environment_without_ai_or_kms_files(self):
        unit = m.worker_unit(Path('/srv/cashneuro/staging/backend-releases') / ('a' * 40))
        self.assertIn('src/import-main.ts', unit)
        self.assertIn('DynamicUser=yes', unit)
        self.assertIn('SupplementaryGroups=cashneuro-staging-code\n', unit)
        self.assertNotIn('LoadCredential', unit)
        self.assertNotIn('AUTH_SECRET', unit)
        self.assertNotIn('assistant-cloud', unit)

    def test_root_inspection_does_not_leave_bytecode_in_the_users_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['update-staging-release.py', 'install-assistant-staging.py']:
                shutil.copyfile(Path(__file__).with_name(name), root / name)
            result = subprocess.run([sys.executable, '-c', 'import runpy,sys; runpy.run_path(sys.argv[1],run_name="cache_inspection")', str(root / 'update-staging-release.py')], capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertFalse((root / '__pycache__').exists())

    def test_rollback_after_early_failure_still_restores_api_when_worker_was_not_created(self):
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory)
            (backup/'rollback.json').write_text(json.dumps({'workerManaged':True,'workerWasEnabled':False,'workerWasActive':False,'workerUnit':None,'workerEnv':None}))
            calls=[]
            with patch.object(m,'WORKER_UNIT',backup/'missing-unit'), patch.object(m,'WORKER_ENV',backup/'missing-env'), patch.object(m.m,'run',side_effect=lambda args,**kw:calls.append(args) or b''), patch.object(m.m,'restore') as restore:
                m.restore(backup)
                restore.assert_called_once_with(backup)
            self.assertEqual(calls,[])


if __name__=='__main__':
    unittest.main()
