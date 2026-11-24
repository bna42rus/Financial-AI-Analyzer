"""Destructive-operation guards and backup failure/retention orchestration."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from cashneuro_ops import backups, cli, common, diagnostics, installation, releases, sizing


def config():
    return {'version':'cashneuro-ops/1','endpoint':'https://s3.twcstorage.ru','bucket':'synthetic-bucket',
            'accessKey':'synthetic-access-key','secretKey':'synthetic-secret-key','password':'synthetic-recovery-password',
            'quotaBytes':10_000_000_000,'alertEmail':'owner@example.test',
            'policy':{'productionDaily':7,'predeploy':2,'stagingPredeploy':2}}


class OperationsTests(unittest.TestCase):
    def setUp(self):
        # The operator runs as root; CI fixtures belong to the unprivileged runner.
        # Preserve real modes/inodes/timestamps and emulate only fixture ownership.
        class RootStat:
            def __init__(self, value):self.value=value
            def __getattr__(self, name):return 0 if name=='st_uid' else getattr(self.value,name)
        real_stat,real_lstat,real_fstat=Path.stat,Path.lstat,os.fstat
        patches=[patch.object(Path,'stat',lambda path,*a,**kw:RootStat(real_stat(path,*a,**kw))),
                 patch.object(Path,'lstat',lambda path,*a,**kw:RootStat(real_lstat(path,*a,**kw))),
                 patch('os.fstat',lambda fd:RootStat(real_fstat(fd)))]
        for item in patches:item.start();self.addCleanup(item.stop)

    def test_keep_two_predecessors_of_running_release_not_newer_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            directories={}
            for i, name in enumerate('abcdef'):
                p=root/(name*40);p.mkdir();os.utime(p,ns=((i+1)*1_000_000_000,)*2);directories[p.name]=p
            self.assertEqual(releases.choose_predecessors(directories,'d'*40),{'b'*40,'c'*40,'d'*40})

    def test_missing_running_release_fails_closed(self):
        with self.assertRaisesRegex(common.OpsError,'CURRENT_RELEASE_MISSING'):
            releases.choose_predecessors({},'a'*40)

    def test_cross_release_dependency_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for name in 'abc':(root/(name*40)).mkdir()
            (root/('a'*40)/'dependency').symlink_to(root/('c'*40))
            self.assertEqual(releases.dependency_closure(root,{'a'*40}),{'a'*40,'c'*40})

    def test_release_regex_does_not_match_partial_or_other_roots(self):
        self.assertEqual(releases.release_names('/other/releases/'+'a'*40),set())
        self.assertEqual(releases.release_names(str(releases.BASE)+'/'+'a'*41),set())
        self.assertEqual(releases.release_names(str(releases.BASE)+'/'+'b'*40+'/apps/api'),{'b'*40})

    def release_fixture(self, root):
        directories={}
        for i,name in enumerate('abcdef'):
            p=root/(name*40);p.mkdir();os.utime(p,ns=((i+1)*1_000_000_000,)*2);directories[p.name]=p
        (root/'unexpected').mkdir()
        return directories

    def test_prune_only_unreferenced_old_releases_and_preserves_new_candidates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'releases';root.mkdir()
            self.release_fixture(root)
            state=Path(temporary)/'state';state.mkdir(mode=0o700)
            with patch.object(releases,'locked',contextlib.nullcontext),patch.object(releases,'STATE',state),\
                 patch.object(releases,'references',return_value=('d'*40,{'a'*40,'d'*40})),\
                 patch.object(releases,'run',return_value=b'stable'),contextlib.redirect_stdout(io.StringIO()):
                preview=releases.prune(base=root)
                self.assertTrue((root/('a'*40)).exists())
                self.assertEqual(preview['removed'],0)
                # a is explicitly referenced; b/c are predecessors; e/f are new candidates.
                result=releases.prune(base=root,apply=True)
                self.assertEqual(result['removed'],0)
                os.utime(root/('f'*40),ns=(0,0))
                result=releases.prune(base=root,apply=True)
                self.assertEqual(result['removed'],1)
                self.assertFalse((root/('f'*40)).exists())
                self.assertTrue((root/'unexpected').exists())

    def test_prune_aborts_when_live_configuration_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.release_fixture(root)
            with patch.object(releases,'locked',contextlib.nullcontext),\
                 patch.object(releases,'references',return_value=('f'*40,{'f'*40})),\
                 patch.object(releases,'run',side_effect=[b'a',b'b',b'changed']),contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(common.OpsError,'LIVE_CONFIGURATION_CHANGED'):
                    releases.prune(base=root,apply=True)
            self.assertEqual(len(list(root.iterdir())),7)

    def test_private_read_rejects_world_readable_symlink_and_hardlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);path=root/'secret';path.write_bytes(b'not-real');os.chmod(path,0o600)
            self.assertEqual(common.private_read(path),b'not-real')
            os.chmod(path,0o644)
            with self.assertRaises(common.OpsError):common.private_read(path)
            os.chmod(path,0o600);(root/'link').symlink_to(path)
            with self.assertRaises(OSError):common.private_read(root/'link')
            os.link(path,root/'hardlink')
            with self.assertRaises(common.OpsError):common.private_read(path)

    def test_non_root_owned_secret_is_rejected(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'secret';path.write_bytes(b'synthetic');os.chmod(path,0o600)
            with patch('os.fstat',return_value=SimpleNamespace(st_mode=0o100600,st_uid=1234,st_nlink=1,st_size=9)):
                with self.assertRaisesRegex(common.OpsError,'PRIVATE_FILE_REQUIRED'):
                    common.private_read(path)

    def test_backup_configuration_and_endpoint_are_closed(self):
        self.assertEqual(backups.validate_config(config()),config())
        for field,value in [('endpoint','http://s3.twcstorage.ru'),('endpoint','https://attacker.invalid'),
                            ('bucket','../other'),('quotaBytes',True),('quotaBytes',1),('password','short')]:
            with self.subTest(field=field,value=value),self.assertRaises(common.OpsError):
                backups.validate_config({**config(),field:value})

    def test_repository_paths_isolate_environment_and_journal_and_keep_secrets_out_of_argv(self):
        paths={backups.restic_env(config(),e,j)['RESTIC_REPOSITORY'] for e in ('staging','production') for j in (False,True)}
        self.assertEqual(len(paths),4)
        with patch.object(backups,'run',return_value=b'') as run:
            backups.restic(config(),'staging',['snapshots','--json'])
        args=run.call_args.args[0]
        self.assertNotIn(config()['password'],str(args))
        self.assertNotIn(config()['secretKey'],str(args))
        self.assertEqual(run.call_args.kwargs['env']['RESTIC_PASSWORD'],config()['password'])

    def test_initialize_never_overwrites_authentication_failure(self):
        with patch('subprocess.run',return_value=subprocess.CompletedProcess([],12)),patch.object(backups,'restic') as restic:
            with self.assertRaisesRegex(common.OpsError,'REPOSITORY_ACCESS_FAILED'):
                backups.initialize(config(),'staging')
            restic.assert_not_called()
        with patch('subprocess.run',return_value=subprocess.CompletedProcess([],10)),patch.object(backups,'restic') as restic:
            backups.initialize(config(),'staging')
            self.assertIn('init',restic.call_args.args[2])

    def test_snapshot_id_requires_success_summary(self):
        self.assertEqual(backups.snapshot_id(b'{"message_type":"status"}\n{"message_type":"summary","snapshot_id":"abcdef12"}\n'),'abcdef12')
        with self.assertRaises(common.OpsError):backups.snapshot_id(b'{"message_type":"status"}')

    def test_journal_accumulates_erased_ids_and_previous_generations(self):
        first={'erased':[{'id':'e1','userId':'synthetic-user','erasedAt':'test'}],
               'workspaces':[{'userId':'second','generation':'g1','keyVersion':'k1','revision':1}],'schema':{}}
        previous=backups.merge_journal(None,first,'staging')
        second={'erased':[],'workspaces':[{'userId':'second','generation':'g2','keyVersion':'k2','revision':9}],'schema':{}}
        current=backups.merge_journal(previous,second,'staging')
        self.assertEqual(len(current['erased']),1)
        self.assertEqual({x['generation'] for x in current['generations']},{'g1','g2'})
        self.assertNotIn('revision',current['currentWorkspaces'][0])
        with self.assertRaises(common.OpsError):backups.merge_journal(previous,second,'production')

    def test_journal_refuses_conflicting_erasure_record(self):
        a={'id':'same','userId':'synthetic','erasedAt':'a'}
        previous=backups.merge_journal(None,{'erased':[a],'workspaces':[],'schema':{}},'staging')
        with self.assertRaisesRegex(common.OpsError,'DELETION_JOURNAL_CONFLICT'):
            backups.merge_journal(previous,{'erased':[{**a,'erasedAt':'b'}],'workspaces':[],'schema':{}},'staging')

    def test_file_manifest_detects_content_changes_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'database.dump').write_bytes(b'synthetic dump')
            first=backups.snapshot_files(root)
            (root/'database.dump').write_bytes(b'changed')
            self.assertNotEqual(first,backups.snapshot_files(root))
            (root/'escape').symlink_to('/etc/passwd')
            with self.assertRaises(common.OpsError):backups.snapshot_files(root)

    def test_local_dump_rotation_keeps_two_and_does_not_remove_audit_or_unrelated_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for i in range(4):
                directory=root/('connected-release-'+str(i)*12+'-synthetic');directory.mkdir(mode=0o700)
                dump=directory/'database.dump';dump.write_bytes(b'PGDMPsynthetic');os.chmod(dump,0o600)
                os.utime(dump,ns=((i+1)*1_000_000_000,)*2)
                (directory/'rollback.json').write_text('{}')
            other=root/'unrelated';other.mkdir();(other/'database.dump').write_bytes(b'never delete')
            with contextlib.redirect_stdout(io.StringIO()):backups.prune_local_deploy_dumps(root)
            self.assertEqual(len(list(root.glob('connected-*/database.dump'))),2)
            self.assertEqual(len(list(root.glob('connected-*/rollback.json'))),4)
            self.assertTrue((other/'database.dump').exists())

    def test_bad_local_dump_aborts_before_deleting_any_old_dump(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);directory=root/('connected-release-'+'a'*12+'-synthetic');directory.mkdir(mode=0o700)
            dump=directory/'database.dump';dump.write_bytes(b'not a dump');os.chmod(dump,0o600)
            with self.assertRaisesRegex(common.OpsError,'LOCAL_DATABASE_DUMP_INVALID'):
                backups.prune_local_deploy_dumps(root,keep=0)
            self.assertTrue(dump.exists())

    def test_isolated_restore_has_no_live_mounts_ports_network_or_application_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            state=Path(temporary)/'state';state.mkdir(mode=0o700)
            commands=[]
            live={'container':'live-container','owner':'live-owner','database':'finance_staging','image':'sha256:synthetic'}
            def restic(cfg,environment,args,**kwargs):
                if args[0]=='snapshots':return b'[{"id":"abcdef12","time":"2026-01-01T00:00:00Z"}]'
                if args[0]=='restore':
                    target=Path(args[args.index('--target')+1])
                    for name in ('database.dump','roles.sql'):common.private_write(target/name,b'synthetic')
                    common.private_write(target/'manifest.json',json.dumps({'environment':'staging','database':'finance_staging','databaseBytes':1000,'files':backups.snapshot_files(target)}))
                return b''
            def query(db,value,**kwargs):
                if db['container']=='live-container':return '["finance_api","control_api"]'
                return '10' if 'count(*)' in value else '1'
            def command(args,**kwargs):
                commands.append(args)
                if args[:2]==['docker','inspect']:return b'{"Running":true}'
                if args[-2:]==['cat','/proc/1/comm']:return b'postgres\n'
                return b''
            with patch.object(backups,'STATE',state),patch.object(backups,'locked',contextlib.nullcontext),\
                 patch.object(backups,'database',return_value=live),patch.object(backups,'restic',side_effect=restic),\
                 patch.object(backups,'sql',side_effect=query),patch.object(backups,'run',side_effect=command),\
                 patch.object(common,'run',side_effect=command),patch.object(common,'sql',side_effect=query),\
                 patch.object(backups,'journal',return_value={'erased':[],'currentWorkspaces':[]}),\
                 patch.object(backups,'read_journal_source',return_value={'workspaces':[]}),\
                 patch.object(backups,'cleanup_isolated_container') as cleanup,contextlib.redirect_stdout(io.StringIO()):
                result=backups.restore_test(config(),'staging')
            create=next(x for x in commands if x[:2]==['docker','run'])
            self.assertEqual(create[create.index('--network')+1],'none')
            self.assertNotIn('--publish',create);self.assertNotIn('-p',create)
            mount=create[create.index('--mount')+1]
            self.assertIn(str(state/'restore-test'/'staging'),mount)
            self.assertNotIn('/var/lib/docker',mount)
            self.assertIn('PGDATA=/var/lib/postgresql',create)
            cleanup.assert_called_once()
            self.assertTrue(cleanup.call_args.args[0].startswith('cashneuro-restore-'))
            self.assertFalse(result['publicAccess']);self.assertFalse(result['productionRestoreAuthorized'])
            self.assertFalse((state/'restore-test'/'staging').exists())

    def test_isolated_postgres_waits_for_final_server_and_stops_on_exit_or_oom(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            queries=[];comm=iter([b'bash\n',b'postgres\n'])
            def command(args,**kwargs):
                if args[:2]==['docker','inspect']:return b'{"Running":true}'
                if args[-2:]==['cat','/proc/1/comm']:return next(comm)
                return b''
            with patch.object(common,'run',side_effect=command),patch.object(common,'sql',side_effect=lambda *a,**k:queries.append(a) or '1'),\
                 patch.object(common.time,'sleep'),contextlib.redirect_stdout(io.StringIO()):
                common.start_isolated_postgres('cashneuro-restore-'+'a'*16,root/'ready','sha256:synthetic','cashneuro_restore')
            self.assertEqual(len(queries),1)
            for suffix,state,code in [('exit',b'{"Running":false}','ISOLATED_POSTGRES_EXITED'),('oom',b'{"Running":false,"OOMKilled":true}','ISOLATED_POSTGRES_OOM')]:
                with patch.object(common,'run',side_effect=[b'',state]),contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(common.OpsError,code):
                        common.start_isolated_postgres('cashneuro-restore-'+'a'*16,root/suffix,'sha256:synthetic','cashneuro_restore')

    def backup_case(self, kind='daily', fault=None):
        with tempfile.TemporaryDirectory() as temporary:
            state=Path(temporary)/'state';state.mkdir(mode=0o700)
            calls=[];manifest={}
            def command(args,**kwargs):
                if kwargs.get('output') is not None:kwargs['output'].write(b'synthetic dump')
                return b''
            def restic(cfg,env,args,**kwargs):
                calls.append(args)
                if args[0]=='stats':return b'{"total_size":0}'
                if args[0]=='snapshots':return b'[]'
                if args[0]=='backup':
                    manifest.update(json.loads((kwargs['cwd']/'manifest.json').read_text()))
                    if fault=='upload':raise common.OpsError('UPLOAD_FAILED')
                    return b'{"message_type":"summary","snapshot_id":"abcdef12"}'
                if args[0]=='dump':return json.dumps({} if fault=='verify' else manifest).encode()
                return b''
            db={'container':'synthetic-container','owner':'synthetic','database':'finance_production'}
            with patch.object(backups,'STATE',state),patch.object(backups,'locked',contextlib.nullcontext),\
                 patch.object(backups,'database',return_value=db),patch.object(backups,'journal',return_value={'currentWorkspaces':[]}),\
                 patch.object(backups,'sql',side_effect=['1000000','[]']),patch.object(backups,'run',side_effect=command),\
                 patch.object(backups,'copy_configuration'),patch.object(backups,'restic',side_effect=restic),\
                 contextlib.redirect_stdout(io.StringIO()):
                if fault:
                    with self.assertRaises(common.OpsError):backups.backup(config(),'production',kind)
                else:backups.backup(config(),'production',kind)
            self.assertFalse((state/'work'/'production').exists())
            return calls

    def test_failed_upload_does_not_forget_old_snapshots(self):
        self.assertFalse(any(x[0]=='forget' for x in self.backup_case(fault='upload')))

    def test_failed_readback_does_not_forget_old_snapshots(self):
        self.assertFalse(any(x[0]=='forget' for x in self.backup_case(fault='verify')))

    def test_daily_retention_is_seven_and_predeploy_two_after_verified_upload(self):
        for kind,count in [('daily','7'),('predeploy','2')]:
            calls=self.backup_case(kind)
            forgotten=next(x for x in calls if x[0]=='forget')
            self.assertEqual(forgotten[forgotten.index('--keep-last')+1],count)
            self.assertLess(next(i for i,x in enumerate(calls) if x[0]=='dump'),calls.index(forgotten))
            self.assertEqual(calls[-1],['check'])

    def test_staging_daily_backup_is_not_silently_enabled(self):
        with self.assertRaisesRegex(common.OpsError,'BACKUP_KIND_INVALID'):
            backups.backup(config(),'staging','daily')

    def test_streaming_subprocess_does_not_read_entire_dump_into_ram(self):
        with tempfile.TemporaryFile() as stream,patch('subprocess.run',return_value=subprocess.CompletedProcess([],0,b'',b'')) as run:
            common.run(['synthetic-command'],input_file=stream)
            self.assertIs(run.call_args.kwargs['stdin'],stream)
            self.assertIsNone(run.call_args.kwargs['input'])

    def test_database_scope_is_loopback_port_not_container_name(self):
        entries=[{'Id':'a'*64,'Config':{'Env':['POSTGRES_USER=owner']},'Image':'sha256:synthetic',
                  'NetworkSettings':{'Ports':{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'5411'}]}},'Mounts':[]}]
        with patch.object(common,'run',side_effect=[b'a'*12+b'\n',json.dumps(entries).encode()]),patch.object(common,'sql',return_value='finance_staging\n'):
            self.assertEqual(common.database('staging')['container'],'a'*64)
        entries[0]['NetworkSettings']['Ports']['5432/tcp'][0]['HostIp']='0.0.0.0'
        with patch.object(common,'run',side_effect=[b'a'*12+b'\n',json.dumps(entries).encode()]):
            with self.assertRaises(common.OpsError):common.database('staging')

    def test_recovery_never_dispatches_or_zeroes_unknown_usage(self):
        self.assertIn('reconcileRecordedAssistantCosts',diagnostics.RECOVERY)
        self.assertIn('unknownUsageReleased:0',diagnostics.RECOVERY)
        self.assertNotIn('fetch(',diagnostics.RECOVERY)
        self.assertNotIn('executeAssistant',diagnostics.RECOVERY)
        self.assertNotIn('UPDATE',diagnostics.ACCOUNTING_SQL)
        self.assertIn('BEGIN READ ONLY',diagnostics.ACCOUNTING_SQL)

    def test_synthetic_profile_has_expected_counts_and_no_live_sql_connection(self):
        self.assertIn('generate_series(1,5000)',sizing.SEED)
        self.assertIn('generate_series(1,500)',sizing.SEED)
        self.assertNotIn('finance_staging',sizing.SEED)
        self.assertNotIn('finance_production',sizing.SEED)

    def test_isolated_cleanup_never_removes_an_unlabelled_or_live_container(self):
        with patch.object(common,'run',side_effect=[b'a'*12,b'{}']) as run:
            with self.assertRaisesRegex(common.OpsError,'ISOLATED_CONTAINER_LABEL_MISMATCH'):
                common.cleanup_isolated_container('cashneuro-restore-'+'b'*16)
            self.assertFalse(any(x.args[0][:3]==['docker','rm','-f'] for x in run.call_args_list))
        with patch.object(common,'run',side_effect=[b'a'*12,b'{"cashneuro.restore-test":"true"}',b'']) as run:
            common.cleanup_isolated_container('cashneuro-restore-'+'b'*16)
            self.assertEqual(run.call_args.args[0],['docker','rm','-f','a'*12])
        with self.assertRaisesRegex(common.OpsError,'ISOLATED_CONTAINER_NAME_INVALID'):
            common.cleanup_isolated_container('live-database')

    def test_installed_units_have_moscow_schedule_and_sandboxed_backup_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with patch.object(installation,'run') as run,contextlib.redirect_stdout(io.StringIO()):
                installation.install_units(root)
            self.assertIn('03:10:00 Europe/Moscow',(root/'cashneuro-backup-production.timer').read_text())
            self.assertIn('Persistent=false',(root/'cashneuro-backup-journal.timer').read_text())
            self.assertIn('ProtectSystem=strict',(root/'cashneuro-backup@.service').read_text())
            self.assertIn('MemoryMax=768M',(root/'cashneuro-backup@.service').read_text())
            self.assertIn('enable',run.call_args.args[0])

    def test_provider_check_uses_cloudru_without_asking_for_another_key(self):
        with patch.object(installation,'prompt',side_effect=AssertionError('No provider prompt')),\
             patch.object(diagnostics,'probe_cloudru',return_value={'provider':'cloud.ru','modelCalls':0}) as probe:
            result=diagnostics.probe_key()
        probe.assert_called_once_with()
        self.assertEqual(result['provider'],'cloud.ru')

    def test_unclassified_422_is_inconclusive_not_an_invalid_key(self):
        value={'httpStatus':422,'reason':'UNCLASSIFIED_PROVIDER_REJECTION','modelCalls':0}
        with patch.object(diagnostics,'run',return_value=json.dumps(value).encode()),\
             patch.object(diagnostics,'private_write'),contextlib.redirect_stdout(io.StringIO()):
            result=diagnostics.probe_cloudru()
        self.assertIsNone(result['keyAcceptedAtCompletionEndpoint'])

    def confirmed_fixture(self,state='unknown',atoms='2225201920'):
        return {'email':'historical-owner@example.test','reserved_atoms':atoms,'state':state,
                'settled_atoms':'0' if state=='released' else None,
                'request_state':'failed' if state=='released' else 'unknown'}

    def test_confirmed_hold_already_released_is_never_subtracted_again(self):
        cfg={'cost':{'projectId':diagnostics.CONFIRMED_PROJECT},'allowedEmails':['current-owner@example.test']}
        with patch.object(diagnostics,'private_read',return_value=json.dumps(cfg).encode()),\
             patch.object(diagnostics,'database',return_value={}),\
             patch.object(diagnostics,'sql',return_value=json.dumps(self.confirmed_fixture('released'))),\
             patch('importlib.util.spec_from_file_location',side_effect=AssertionError('Already released')),\
             contextlib.redirect_stdout(io.StringIO()):
            result=diagnostics.resolve_hold('e6b054ec-e6fb-4ae4-88e4-27a626159e45',True,expected_atoms='2225201920')
        self.assertEqual(result['status'],'ALREADY_RELEASED')

    def test_confirmed_hold_changed_amount_aborts_before_attestation_or_mutation(self):
        cfg={'cost':{'projectId':diagnostics.CONFIRMED_PROJECT},'allowedEmails':[]}
        with patch.object(diagnostics,'private_read',return_value=json.dumps(cfg).encode()),\
             patch.object(diagnostics,'database',return_value={}),\
             patch.object(diagnostics,'sql',return_value=json.dumps(self.confirmed_fixture(atoms='2225201921'))),\
             patch('importlib.util.spec_from_file_location',side_effect=AssertionError('No attestation')):
            with self.assertRaisesRegex(common.OpsError,'CONFIRMED_HOLD_AMOUNT_CHANGED'):
                diagnostics.resolve_hold('e6b054ec-e6fb-4ae4-88e4-27a626159e45',True,expected_atoms='2225201920')

    def test_confirmed_batch_is_closed_to_exact_historical_requests(self):
        with patch.object(diagnostics,'resolve_hold',return_value={'status':'READY'}) as resolve,contextlib.redirect_stdout(io.StringIO()):
            diagnostics.resolve_confirmed_holds()
        self.assertEqual(len(resolve.call_args_list),3)
        self.assertEqual({x.args[0] for x in resolve.call_args_list},set(diagnostics.CONFIRMED_UNBILLED_HOLDS))
        self.assertTrue(all(x.args[1] is False for x in resolve.call_args_list))
        self.assertEqual({x.kwargs['expected_atoms'] for x in resolve.call_args_list},{'2225201920','2152001920'})

    def test_confirmed_batch_applies_owner_declaration_only_when_explicit(self):
        with patch.object(diagnostics,'resolve_hold',side_effect=[{'status':'ALREADY_RELEASED'},{'status':'ALREADY_RELEASED'},{'status':'RELEASED'}]) as resolve,contextlib.redirect_stdout(io.StringIO()):
            diagnostics.resolve_confirmed_holds(True)
        self.assertTrue(all(x.args[1] is True for x in resolve.call_args_list))

    def terminal_case(self,raw=False,ending=b'\r',cancel=False):
        import pty,select,signal,sys,termios,time
        directory=str(Path(__file__).resolve().parent)
        program=f'''
import sys,termios
sys.path.insert(0,{directory!r})
from cashneuro_ops.installation import prompt
if {raw!r}:
    a=termios.tcgetattr(0);a[0]&=~termios.ICRNL;a[3]&=~(termios.ICANON|termios.ISIG);termios.tcsetattr(0,termios.TCSANOW,a)
before=termios.tcgetattr(0)
try:
    first=prompt('First',default='1')
    print('FIRST='+first,flush=True)
    password=prompt('Secret',secret=True)
    print('SECRET_MATCH='+str(password=='synthetic-hidden-value'),flush=True)
except KeyboardInterrupt:
    print('INTERRUPTED',flush=True)
finally:
    print('RESTORED='+str(before==termios.tcgetattr(0)),flush=True)
'''
        pid,fd=pty.fork()
        if pid==0:
            os.execl(sys.executable,sys.executable,'-u','-c',program)
        output=bytearray()
        def until(marker):
            deadline=time.monotonic()+3
            while marker not in output and time.monotonic()<deadline:
                if select.select([fd],[],[],0.1)[0]:
                    try:
                        data=os.read(fd,8192)
                    except OSError:
                        break
                    if not data:break
                    output.extend(data)
            self.assertIn(marker,output)
        try:
            until(b'First [1]: ')
            if cancel:
                os.write(fd,b'\x03');until(b'RESTORED=True')
                self.assertIn(b'INTERRUPTED',output)
            else:
                os.write(fd,b'1'+ending);until(b'Secret: ')
                os.write(fd,b'synthetic-hidden-value'+ending);until(b'RESTORED=True')
                self.assertIn(b'FIRST=1',output)
                self.assertIn(b'SECRET_MATCH=True',output)
                self.assertNotIn(b'synthetic-hidden-value',output)
        finally:
            try:os.kill(pid,signal.SIGKILL)
            except ProcessLookupError:pass
            os.waitpid(pid,0);os.close(fd)

    def test_terminal_enter_normal_mode_advances_and_secrets_are_hidden(self):
        self.terminal_case()

    def test_terminal_enter_raw_mobile_mode_advances_and_restores_original_settings(self):
        self.terminal_case(raw=True)

    def test_terminal_line_feed_is_accepted(self):
        self.terminal_case(raw=True,ending=b'\n')

    def test_terminal_control_c_in_raw_mode_restores_original_settings(self):
        self.terminal_case(raw=True,cancel=True)

    def test_confirmed_hold_preview_precedes_audit_and_apply(self):
        from types import SimpleNamespace
        events=[]
        cfg={'cost':{'projectId':diagnostics.CONFIRMED_PROJECT},'allowedEmails':[]}
        def query(email,request,atoms,apply=False):return 'APPLY' if apply else 'PREVIEW'
        helper=SimpleNamespace(query=query,attest=lambda *a:events.append('audit'))
        spec=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda *a:None))
        def sql(db,value):
            if value=='PREVIEW':events.append('preview');return '{"status":"READY"}'
            if value=='APPLY':events.append('apply');return '{"status":"RELEASED"}'
            return json.dumps(self.confirmed_fixture())
        with patch.object(diagnostics,'private_read',return_value=json.dumps(cfg).encode()),\
             patch.object(diagnostics,'database',return_value={}),patch.object(diagnostics,'sql',side_effect=sql),\
             patch('importlib.util.spec_from_file_location',return_value=spec),\
             patch('importlib.util.module_from_spec',return_value=helper),contextlib.redirect_stdout(io.StringIO()):
            result=diagnostics.resolve_hold('e6b054ec-e6fb-4ae4-88e4-27a626159e45',True,expected_atoms='2225201920')
        self.assertEqual(events,['preview','audit','apply'])
        self.assertEqual(result['status'],'RELEASED')

    def test_alert_is_throttled_before_any_network_send(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);os.chmod(root,0o700)
            with patch.object(cli,'STATE',root),patch.object(cli,'settings',return_value=config()),\
                 patch.object(backups,'alert') as alert,contextlib.redirect_stdout(io.StringIO()):
                cli.failure('SYNTHETIC_FAILURE','test')
                cli.failure('SYNTHETIC_FAILURE','test')
            alert.assert_called_once()

    def test_resolving_a_hold_is_never_part_of_setup_or_a_schedule(self):
        import inspect
        self.assertNotIn('resolve_hold',inspect.getsource(installation.setup))
        self.assertNotIn('resolve_hold',inspect.getsource(cli.scheduled))
        self.assertFalse(inspect.signature(diagnostics.resolve_hold).parameters['confirmed_unbilled'].default)

    def test_deployment_backup_failure_propagates_but_prune_failure_does_not_roll_back(self):
        import importlib.util
        from types import SimpleNamespace
        spec=importlib.util.spec_from_file_location('ops_deployment_test',Path(__file__).with_name('update-staging-release.py'))
        update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)
        with patch.object(Path,'exists',return_value=True),patch.object(Path,'is_file',return_value=True),\
             patch.object(Path,'stat',return_value=SimpleNamespace(st_uid=0,st_mode=0o100755)),\
             patch.object(update.m,'run',side_effect=RuntimeError('synthetic failure')),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):update.operator_maintenance('backup')
            update.operator_maintenance('prune')


if __name__=='__main__':
    unittest.main()
