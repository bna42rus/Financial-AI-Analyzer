import importlib.util
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
