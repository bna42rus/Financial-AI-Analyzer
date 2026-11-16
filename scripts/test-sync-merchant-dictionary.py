import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('dictionary_sync', Path(__file__).with_name('sync-merchant-dictionary.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
ROOT = Path(__file__).resolve().parents[1]
RAW = (ROOT / sync.DATA_PATH).read_bytes()
TARGETS = json.loads((ROOT / 'scripts/merchant-dictionary-targets.json').read_text())

class DictionarySyncTests(unittest.TestCase):
    def test_current_snapshot_is_valid_and_update_does_not_execute_fields(self):
        value = sync.validate(RAW, TARGETS)
        self.assertEqual(len(value['entries']), 30)
        bad = json.loads(RAW)
        bad['entries'][0]['pattern'] = '.*'
        with self.assertRaises(ValueError):
            sync.validate(json.dumps(bad).encode(), TARGETS)

    def test_invalid_update_leaves_the_last_snapshot_intact(self):
        with tempfile.TemporaryDirectory() as directory:
            active = Path(directory) / 'active.json'
            with patch.object(sync, 'ACTIVE', active):
                self.assertTrue(sync.publish(RAW, TARGETS))
                self.assertFalse(sync.publish(RAW, TARGETS))
                before = active.read_bytes()
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    sync.publish(b'not-json', TARGETS)
                self.assertEqual(active.read_bytes(), before)
                self.assertEqual(active.stat().st_mode & 0o777, 0o644)

    def test_alias_collisions_and_unknown_semantic_targets_are_rejected(self):
        for change in ('collision', 'target'):
            bad = json.loads(RAW)
            if change == 'collision':
                bad['entries'].append({**bad['entries'][0], 'id': 'unrelated'})
            else:
                bad['entries'][0]['target'] = 'unknown'
            with self.assertRaises(ValueError):
                sync.validate(json.dumps(bad).encode(), TARGETS)

    def test_timer_installs_only_data_sync_without_application_restart(self):
        writes, commands = {}, []
        with patch.object(sync, 'atomic', lambda path, raw, mode=0o644: writes.update({str(path): raw})), patch.object(sync, 'publish'), patch.object(sync, 'run', lambda command: commands.append(command)):
            sync.install(ROOT)
        service = writes['/etc/systemd/system/cashneuro-merchant-dictionary.service'].decode()
        timer = writes['/etc/systemd/system/cashneuro-merchant-dictionary.timer'].decode()
        self.assertIn('--pull', service)
        self.assertIn('OnUnitActiveSec=1min', timer)
        self.assertTrue(any('enable' in command for command in commands))
        self.assertFalse(any('restart' in command for command in commands))

if __name__ == '__main__':
    unittest.main()
