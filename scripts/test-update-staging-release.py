import importlib.util
from datetime import datetime, timezone
import ast
import inspect
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('update', Path(__file__).with_name('update-staging-release.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class UpdateTests(unittest.TestCase):
    def test_monthly_mode_requires_explicit_100_rub_authorization_and_cannot_reset_history(self):
        before = {'realm':'staging/finance','apiKey':'synthetic','allowedEmails':['owner@example.test'],
                  'sourceSha256':'a'*64,'modelMetadataSha256':'b'*64,'tariffSource':'fixed',
                  'admission':{'stageCapAtoms':'10000000000','stageMaximumCalls':70,'spentAtoms':'12000000','calls':58},
                  'maximumCalls':12,'expiresAt':'2026-11-02T13:34:00Z',
                  'cost':{'projectId':'staging/test','price':{'synthetic':True}}}
        monthly = {'version':'cashneuro-staging-monthly/1','limitRub':'100','activatedAt':'2026-11-01T14:00:00Z'}
        after = {**before,'sourceSha256':'d'*64,'monthly':monthly}
        m.validate_admission_pair(before,after,before,'a'*64,'d'*64,'100')
        with self.assertRaisesRegex(m.m.InstallationError,'MONTHLY_AUTHORIZATION_REQUIRED'):
            m.validate_admission_pair(before,after,{**after,'sourceSha256':'a'*64},'a'*64,'d'*64)
        for key in ['calls','spentAtoms']:
            changed = {**after,'admission':{**after['admission'],key:0 if key=='calls' else '0'}}
            with self.assertRaisesRegex(m.m.InstallationError,'MONTHLY_HISTORY_CHANGED'):
                m.validate_admission_pair(before,changed,before,'a'*64,'d'*64,'100')
        with self.assertRaisesRegex(m.m.InstallationError,'MONTHLY_AUTHORIZATION_CHANGED'):
            m.validate_admission_pair(before,{**after,'monthly':{**monthly,'limitRub':'101'}},before,'a'*64,'d'*64,'100')
        self.assertFalse(m.admission_expired(after,datetime(2028,1,1,tzinfo=timezone.utc)))

    def test_paused_rollback_uses_real_snapshot_files_without_recreating_an_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {name: root/name for name in ['caddy','dropin','workerUnit','workerEnv','assistantConfig']}
            original = b'[Service]\nExecStart=/usr/bin/env CREDENTIALS_DIRECTORY=/run/private ASSISTANT_ENABLED=1 AI_ENABLED=0 /usr/bin/node --import tsx src/main.ts\n'
            settings = {'expiresAt':'2000-01-01T00:00:00Z','sourceSha256':'a'*64,'admission':{'calls':69,'stageMaximumCalls':70},'cost':{'reservedAtoms':'2328657920'}}
            contents = {'caddy':b'synthetic caddy','dropin':original,'workerUnit':b'synthetic worker','workerEnv':b'synthetic env','assistantConfig':json.dumps(settings).encode()}
            for name,path in paths.items():
                path.write_bytes(contents[name])
            backup = m.create_backup_directory(root,'a'*40)
            paused = m.pause_expired_ai(settings,original)
            with patch.object(m.m,'CADDY',paths['caddy']), patch.object(m.m,'DROPIN',paths['dropin']), patch.object(m.m,'CONFIG',paths['assistantConfig']), patch.object(m,'WORKER_UNIT',paths['workerUnit']), patch.object(m,'WORKER_ENV',paths['workerEnv']), patch.object(m.m,'run',side_effect=AssertionError('No service or paid call in preparation')):
                metadata = m.rollback_files(backup,True,False,original,paused)
            self.assertTrue(metadata['expiredAiPaused'])
            self.assertEqual((backup/'dropin').read_bytes(),paused)
            self.assertEqual((backup/'dropin.original').read_bytes(),original)
            self.assertEqual((backup/'assistantConfig').read_bytes(),contents['assistantConfig'])
            for name,path in paths.items():
                self.assertEqual(path.read_bytes(),contents[name],name+' must stay unchanged')
            for path in backup.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode),0o700)
            self.assertFalse(list(backup.glob('*.assistant-*')))

    def test_repeated_preparation_keeps_existing_backups_and_allocates_a_private_new_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = m.create_backup_directory(root,'b'*40)
            (first/'original').write_bytes(b'keep this backup')
            second = m.create_backup_directory(root,'b'*40)
            self.assertNotEqual(first,second)
            self.assertEqual((first/'original').read_bytes(),b'keep this backup')
            self.assertEqual(stat.S_IMODE(second.stat().st_mode),0o700)
            self.assertEqual(list(second.iterdir()),[])

    def test_expired_ai_pause_disables_explicit_exec_environment_without_renewing_the_private_settings(self):
        previous = {'expiresAt':'2026-10-30T15:25:53.579Z','sourceSha256':'a'*64,'admission':{'calls':69,'stageMaximumCalls':70},'cost':{'projectId':'staging/original'}}
        original = json.loads(json.dumps(previous))
        command = b'[Service]\nWorkingDirectory=/srv/test/apps/api\nEnvironment=ASSISTANT_ENABLED=1\nExecStart=\nExecStart=/usr/bin/env CREDENTIALS_DIRECTORY=/run/private ASSISTANT_ENABLED=1 AI_ENABLED=0 /usr/bin/node --import tsx src/main.ts\n'
        result = m.pause_expired_ai(previous,command,datetime(2026,10,31,tzinfo=timezone.utc))
        self.assertIn(b'CREDENTIALS_DIRECTORY=/run/private ASSISTANT_ENABLED=0 AI_ENABLED=0',result)
        self.assertIn(b'Environment=CLASSIFICATION_ENABLED=0',result)
        self.assertNotIn(b'ASSISTANT_ENABLED=1',result)
        self.assertEqual(previous,original)
        self.assertNotIn(b'ASSISTANT_ENABLED=1',m.pause_expired_ai(previous,result,datetime(2026,10,31,tzinfo=timezone.utc)))
        self.assertIn(b'WorkingDirectory=/srv/test/apps/api',result)
        with self.assertRaises(m.m.InstallationError):
            m.pause_expired_ai(previous,command,datetime(2026,10,29,tzinfo=timezone.utc))
        for settings in [{}, {'expiresAt':'not a timestamp'}, {'expiresAt':'2026-10-30T00:00:00'}]:
            with self.assertRaises(m.m.InstallationError):
                m.pause_expired_ai(settings,command,datetime(2026,10,31,tzinfo=timezone.utc))
        with self.assertRaises(m.m.InstallationError):
            m.pause_expired_ai(previous,b'ExecStart=unexpected',datetime(2026,10,31,tzinfo=timezone.utc))

    def test_paused_install_cannot_combine_with_a_paid_probe_or_evidence_renewal(self):
        for enable,evidence,tested in [(True,None,None),(False,'archive',None),(False,None,'a'*64)]:
            with self.assertRaisesRegex(m.m.InstallationError,'PAUSED_AI_ARGUMENTS_CONFLICT'):
                m.install(Path('/does-not-exist'),'a'*40,enable,evidence,tested,True)

    def test_upgrade_verifies_candidate_directory_and_health_for_the_selected_ai_mode(self):
        release=Path('/srv/cashneuro/staging/backend-releases')/('c'*40)
        for paused,payload in [(True,{'status':'ok','profile':'finance'}),(False,{'status':'ok','profile':'finance','assistant':'cashneuro-assistant-workflow/7'})]:
            with patch.object(m.m,'run',return_value=str(release/'apps/api').encode()), patch.object(m.m.urllib.request,'urlopen',side_effect=lambda *a,**k:io.BytesIO(json.dumps(payload).encode())), patch.object(m.m.time,'sleep',side_effect=AssertionError('Healthy API must pass immediately')):
                m.wait_release_health(release,paused)
        with patch.object(m.m,'run',return_value=b'/srv/previous/apps/api'), patch.object(m.m,'wait_health') as health:
            with self.assertRaisesRegex(m.m.InstallationError,'API_RELEASE_DIRECTORY_MISMATCH'):
                m.wait_release_health(release,True)
            health.assert_not_called()

    def test_paused_api_is_not_required_to_load_the_assistant_and_enabled_health_stays_strict(self):
        for payload,enabled,paused in [({'status':'ok','profile':'finance'},False,True),({'status':'ok','profile':'finance','assistant':'cashneuro-assistant-workflow/6'},False,False),({'status':'ok','profile':'finance','assistant':'cashneuro-assistant-workflow/7'},True,False),({'status':'ok','profile':'control'},False,False),({'status':'error','profile':'finance'},False,False)]:
            with patch.object(m.m.urllib.request,'urlopen',side_effect=lambda *a,**k:io.BytesIO(json.dumps(payload).encode())):
                self.assertEqual(m.m.health(True),enabled)
                self.assertEqual(m.m.health(False,assistant_enabled=False),paused)
        function=ast.parse(inspect.getsource(m.install)).body[0]
        checks=[n for n in ast.walk(function) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='wait_release_health']
        self.assertEqual(len(checks),2)
        self.assertTrue(all(isinstance(c.args[1],ast.Name) and c.args[1].id=='keep_ai_paused' for c in checks))

    def test_admission_refusal_keeps_its_public_code_without_printing_private_output(self):
        for code in ['CLASSIFICATION_RECONCILIATION_REQUIRED','CLASSIFICATION_ORIGINAL_LIMIT_EXHAUSTED']:
            def refuse(args,**kw):
                kw['output'].write(json.dumps({'status':'STOP','code':code}).encode())
                raise m.m.InstallationError('COMMAND_FAILED:node')
            with patch.object(m.m,'run',side_effect=refuse):
                with self.assertRaisesRegex(m.m.InstallationError,code):
                    m.prepare_admission(['synthetic-helper'])
        def private_failure(args,**kw):
            kw['output'].write(b'private non-JSON provider response')
            raise m.m.InstallationError('COMMAND_FAILED:node')
        with patch.object(m.m,'run',side_effect=private_failure):
            with self.assertRaisesRegex(m.m.InstallationError,'COMMAND_FAILED:node'):
                m.prepare_admission(['synthetic-helper'])

    def test_resume_removes_old_pause_flags_and_does_not_duplicate_conflicting_environment(self):
        old=b'[Service]\nWorkingDirectory=/srv/test/apps/api\nEnvironment=ASSISTANT_ENABLED=0\nExecStart=\nExecStart=/usr/bin/env CREDENTIALS_DIRECTORY=/run/private ASSISTANT_ENABLED=0 AI_ENABLED=0 /usr/bin/node --import tsx src/main.ts\nEnvironment=CLASSIFICATION_ENABLED=0\n'
        active=m.activate_ai(m.pause_expired_ai({'expiresAt':'2000-01-01T00:00:00Z'},old))
        self.assertNotIn(b'ASSISTANT_ENABLED=0',active)
        self.assertNotIn(b'CLASSIFICATION_ENABLED=0',active)
        self.assertIn(b'WorkingDirectory=/srv/test/apps/api',active)
        self.assertEqual(active.count(b'Environment=CLASSIFICATION_ENABLED=1'),1)
        self.assertEqual(m.activate_ai(active),active)
        with self.assertRaisesRegex(m.m.InstallationError,'AI_RESUME_DROPIN_CHANGED'):
            m.activate_ai(b'ExecStart=unexpected')

    def test_full_install_with_real_backup_and_switch_files_handles_paused_blocked_and_renewed_modes(self):
        # Run the actual installer orchestration. Only external processes/HTTP
        # and the receipt helper are substituted; snapshots, config/dropin
        # replacements, Caddy selection and release copies use real files.
        from contextlib import ExitStack, redirect_stdout
        for mode in ['paused','blocked','renewed']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                root=Path(directory);base=root/'staging';current=base/'backend-releases'/('a'*40);source=root/'build';release=base/'backend-releases'/('b'*40)
                current.mkdir(parents=True);(source/'apps/web/dist').mkdir(parents=True);(source/'apps/api').mkdir(parents=True);(root/'backups').mkdir()
                origin='https://test.cashneuro.ru';(source/'apps/web/dist/release.json').write_text(json.dumps({'schema':'cashneuro-web-build/1','revision':'b'*40,'profile':'finance','mode':'connected','apiOrigin':origin}))
                cfg=root/'settings';dropin=root/'dropin';caddy=root/'Caddyfile';worker=root/'worker';worker_env=root/'worker-env'
                old={'realm':'staging/finance','apiKey':'synthetic-only','allowedEmails':['owner@example.test'],'modelMetadataSha256':'c'*64,'tariffSource':'fixed','sourceSha256':'a'*64,'expiresAt':'2000-01-01T00:00:00Z','maximumCalls':14,'admission':{'stageCapAtoms':'10000000000','stageMaximumCalls':70,'spentAtoms':'100','calls':56},'cost':{'projectId':'staging/synthetic','price':{'input':'15.86'}}}
                cfg.write_text(json.dumps(old));cfg.chmod(0o600)
                old_dropin=('[Service]\nWorkingDirectory='+str(current/'apps/api')+'\nExecStart=\nExecStart=/usr/bin/env CREDENTIALS_DIRECTORY=/run/private ASSISTANT_ENABLED=0 AI_ENABLED=0 /usr/bin/node --import tsx src/main.ts\nEnvironment=CLASSIFICATION_ENABLED=0\n').encode();dropin.write_bytes(old_dropin)
                old_root=str(current/'web');caddy.write_text(old_root);worker.write_text('old worker');worker_env.write_text('old scoped env')
                calls=[];sql_calls=[]
                def run(args,**kw):
                    args=list(map(str,args));calls.append(args)
                    if args[0]=='/usr/bin/node':
                        self.assertEqual(args[-1],'--prepare','No live model command is allowed')
                        return json.dumps({'sourceSha256':'a'*64 if args[-2].startswith(str(current)) else 'b'*64}).encode()
                    if args[:2]==['caddy','adapt']:return json.dumps({'root':caddy.read_text()}).encode()
                    if args[:2]==['systemctl','show']:
                        if '--property=WorkingDirectory' in args:return re.search(rb'(?m)^WorkingDirectory=(.+)$',dropin.read_bytes())[1]
                        return b'enabled'
                    if args[:2]==['systemctl','list-units']:return (m.WORKER+' loaded active running synthetic').encode()
                    if args[:2]==['systemctl','is-active']:return b'active'
                    if 'pg_dump' in args:kw['output'].write(b'synthetic backup')
                    return b''
                def sql(query):sql_calls.append(query);self.assertTrue(query.startswith('SELECT'));return 't'
                def admit(args):
                    if mode=='blocked':raise m.m.InstallationError('CLASSIFICATION_RECONCILIATION_REQUIRED')
                    candidate=json.loads(json.dumps(old));candidate.update(sourceSha256='b'*64,maximumCalls=13,expiresAt='2099-01-01T00:00:00Z');candidate['admission'].update(calls=57,spentAtoms='200')
                    m.m.private_write(Path(args[-4]),json.dumps(candidate).encode());m.m.private_write(Path(args[-3]),json.dumps({**candidate,'sourceSha256':'a'*64}).encode())
                original_create=m.create_backup_directory
                for target,key,value in [(m.m,'BASE',base),(m.m,'CONFIG',cfg),(m.m,'DROPIN',dropin),(m.m,'CADDY',caddy),(m,'WORKER_UNIT',worker),(m,'WORKER_ENV',worker_env)]:stack.enter_context(patch.object(target,key,value))
                stack.enter_context(patch.object(m,'settings',return_value={'API_BASE_URL':origin,'DATABASE_URL':'synthetic scoped database'}));stack.enter_context(patch.object(m.m,'run',side_effect=run));stack.enter_context(patch.object(m.m,'docker_database',return_value=('synthetic','owner',sql)));stack.enter_context(patch.object(m.m,'frontend_root',side_effect=lambda v:v['root']));stack.enter_context(patch.object(m,'create_backup_directory',side_effect=lambda parent,sha:original_create(root/'backups',sha)));stack.enter_context(patch.object(m,'prepare_admission',side_effect=admit));stack.enter_context(patch.object(m.time,'sleep'))
                def health_response(*a,**kw):
                    value={'status':'ok','profile':'finance'}
                    if b'ASSISTANT_ENABLED=1' in dropin.read_bytes():value['assistant']='cashneuro-assistant-workflow/7'
                    return io.BytesIO(json.dumps(value).encode())
                stack.enter_context(patch.object(m.m.urllib.request,'urlopen',side_effect=health_response))
                output=io.StringIO()
                with redirect_stdout(output):m.install(source,'b'*40,evidence='synthetic-archive' if mode!='paused' else None,tested_sha='b'*64 if mode!='paused' else None,keep_ai_paused=mode=='paused',resume_ai=mode!='paused')
                result=json.loads(output.getvalue().splitlines()[-1]);self.assertEqual(result['status'],'UPDATED');self.assertEqual(result['paidCalls'],0)
                self.assertEqual(caddy.read_text(),str(release/'apps/web/dist'));self.assertIn(str(release/'apps/api'),dropin.read_text());self.assertTrue((release/'apps/api').is_dir())
                settings=json.loads(cfg.read_text());self.assertEqual(settings['sourceSha256'],'b'*64)
                if mode=='renewed':self.assertEqual(settings['admission']['calls'],57);self.assertNotIn('ASSISTANT_ENABLED=0',dropin.read_text())
                else:self.assertEqual({**settings,'sourceSha256':'a'*64},old);self.assertNotIn('ASSISTANT_ENABLED=1',dropin.read_text())
                backup=next((root/'backups').iterdir());self.assertEqual((backup/'assistantConfig.original').read_text(),json.dumps(old)) if mode!='paused' else None
                self.assertFalse(any('classification-smoke-main.ts' in ' '.join(c) for c in calls))
                if mode=='blocked':self.assertEqual(result['assistantAdmission'],'blocked_reconciliation');self.assertEqual(result['aiResumeBlocker'],'CLASSIFICATION_RECONCILIATION_REQUIRED')

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
