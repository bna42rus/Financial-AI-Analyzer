#!/usr/bin/env python3
import copy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('authorize_calls', Path(__file__).with_name('authorize-assistant-staging-calls.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)


def settings():
    return {'realm': 'staging/finance', 'apiKey': 'synthetic-only', 'allowedEmails': ['owner@example.test'],
            'sourceSha256': 'a' * 64, 'maximumCalls': 2, 'expiresAt': '2026-10-30T15:25:53.579Z',
            'admission': {'stageMaximumCalls': 60, 'calls': 58, 'spentAtoms': '5314762860', 'stageCapAtoms': '10000000000', 'budgetSha256': 'b' * 64},
            'cost': {'projectId': m.PROJECT, 'projectPeriodEnd': '2026-10-30T15:25:53.579Z', 'projectLimitRub': '4.685237140'}}


class Tests(unittest.TestCase):
    def test_only_call_ceiling_changes_and_the_59th_dispatch_still_counts(self):
        old = settings()
        original = copy.deepcopy(old)
        new = m.planned_settings(old, NOW)
        self.assertEqual(old, original)
        self.assertEqual(new['maximumCalls'], 12)
        self.assertEqual(new['admission']['stageMaximumCalls'] - new['admission']['calls'] - 1, 11)
        new['maximumCalls'] = old['maximumCalls']
        new['admission']['stageMaximumCalls'] = 60
        self.assertEqual(new, old)

    def test_repeated_authorization_is_idempotent(self):
        authorized = m.planned_settings(settings(), NOW)
        self.assertEqual(m.planned_settings(authorized, NOW), authorized)

    def test_active_foreign_or_inconsistent_configuration_is_rejected(self):
        for change in (lambda s: s.update(maximumCalls=3), lambda s: s.update(realm='production/finance'),
                       lambda s: s['cost'].update(projectId='another-project'),
                       lambda s: s.update(expiresAt='2026-11-02T00:00:00Z'),
                       lambda s: s['cost'].update(projectPeriodEnd='2026-11-02T00:00:00Z'),
                       lambda s: s['admission'].update(stageCapAtoms='100000000000'),
                       lambda s: s['admission'].update(calls=True)):
            old = settings()
            change(old)
            with self.assertRaises(ValueError):
                m.planned_settings(old, NOW)

    @unittest.skipUnless(os.geteuid() == 0, 'private Staging files must be root-owned')
    def test_preview_and_apply_keep_private_recovery_copy_and_never_renew_expiry(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / 'assistant.json'
            raw = (json.dumps(settings()) + '\n').encode()
            m.private_write(config, raw)
            attestation = {'requestId': m.REQUEST, 'status': 'OPERATOR_ATTESTATION', 'scope': 'staging only', 'reservationAtoms': '2328657920'}
            m.private_write(root / ('ai-unbilled-reconciliation-' + m.REQUEST + '.json'), json.dumps(attestation).encode())
            self.assertEqual(m.authorize(config, root, False, NOW)['status'], 'PREVIEW')
            self.assertEqual(config.read_bytes(), raw)
            result = m.authorize(config, root, True, NOW)
            backup = Path(result['privateBackup'])
            self.assertEqual((backup / 'assistant-staging.before.json').read_bytes(), raw)
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            updated = json.loads(config.read_text())
            self.assertEqual(updated['expiresAt'], settings()['expiresAt'])
            self.assertEqual(updated['admission']['spentAtoms'], settings()['admission']['spentAtoms'])
            self.assertEqual(m.authorize(config, root, True, NOW)['status'], 'ALREADY_AUTHORIZED')
            self.assertEqual(len(list(root.glob('assistant-call-limit-70-*'))), 1)
            config.unlink()
            config.symlink_to(backup / 'assistant-staging.before.json')
            with self.assertRaises(OSError):
                m.authorize(config, root, True, NOW)


if __name__ == '__main__':
    unittest.main()
