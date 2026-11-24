import contextlib
import fcntl
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('extractor_install',Path(__file__).with_name('install-tariff-extractor.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class InstallTests(unittest.TestCase):
    def test_ready_binaries_skip_apt_and_lock_wait(self):
        with patch.object(os,'geteuid',return_value=0),patch.object(m,'ready',return_value=True),\
             patch.object(m,'wait_for_package_manager') as wait,patch.object(m.subprocess,'run') as run,contextlib.redirect_stdout(io.StringIO()):
            m.install()
        wait.assert_not_called();run.assert_not_called()

    def test_only_signed_official_sources_for_the_current_release_are_used(self):
        value=m.official_sources('resolute','amd64')
        self.assertIn('https://archive.ubuntu.com/ubuntu resolute ',value)
        self.assertIn('https://security.ubuntu.com/ubuntu resolute-security ',value)
        self.assertEqual(value.count('signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg'),3)
        self.assertNotIn('timeweb',value)
        self.assertIn('https://ports.ubuntu.com/ubuntu-ports',m.official_sources('resolute','arm64'))
        for release,arch in [('resolute\nmalicious','amd64'),('resolute','unknown')]:
            with self.assertRaises(RuntimeError):m.official_sources(release,arch)

    def test_install_waits_and_uses_temporary_sources_without_disabling_signature_checks(self):
        commands=[];paths=[]
        def run(args,**kwargs):
            commands.append(args)
            path=Path(next(x.split('=',1)[1] for x in args if x.startswith('Dir::Etc::sourcelist=')))
            paths.append(path);self.assertTrue(path.exists());self.assertIn('resolute-updates',path.read_text())
            self.assertEqual(kwargs['env']['DEBIAN_FRONTEND'],'noninteractive')
            self.assertNotIn('timeout',kwargs)
            return SimpleNamespace(returncode=0)
        with patch.object(os,'geteuid',return_value=0),patch.object(m,'ready',side_effect=[False,True]),\
             patch.object(m,'wait_for_package_manager') as wait,\
             patch.object(Path,'read_text',autospec=True,side_effect=lambda path,*a,**k:'ID=ubuntu\nVERSION_CODENAME=resolute\n' if str(path)=='/etc/os-release' else original_read(path,*a,**k)),\
             patch.object(Path,'is_file',return_value=True),patch.object(m.subprocess,'check_output',return_value='amd64\n'),\
             patch.object(m.subprocess,'run',side_effect=run),contextlib.redirect_stdout(io.StringIO()):
            m.install()
        wait.assert_called_once();self.assertEqual(len(commands),2)
        self.assertTrue(all('DPkg::Lock::Timeout=300' in args for args in commands))
        self.assertTrue(all('APT::Get::List-Cleanup=false' in args for args in commands))
        self.assertTrue(all('Dir::Etc::sourceparts=-' in args for args in commands))
        self.assertFalse(any('allow-unauthenticated' in x or 'trusted=yes' in x for args in commands for x in args))
        self.assertEqual(commands[1][-5:],['install','-y','--no-install-recommends','poppler-utils','util-linux'])
        self.assertFalse(any(path.exists() for path in paths))

    def test_real_package_lock_is_waited_for_and_never_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'lock';path.touch();fd=os.open(path,os.O_RDWR)
            try:
                fcntl.lockf(fd,fcntl.LOCK_EX)
                pid=os.fork()
                if pid==0:
                    try:
                        with contextlib.redirect_stdout(io.StringIO()):m.wait_for_package_manager([path],timeout=2,interval=0.01)
                        os._exit(0)
                    except Exception:os._exit(1)
                time.sleep(0.05)
                fcntl.lockf(fd,fcntl.LOCK_UN)
                self.assertEqual(os.waitpid(pid,0)[1],0)
                self.assertTrue(path.exists())
            finally:os.close(fd)


original_read=Path.read_text
if __name__=='__main__':unittest.main()
