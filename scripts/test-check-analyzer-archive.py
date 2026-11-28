import contextlib
import importlib.util
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('archive_check', Path(__file__).with_name('check-analyzer-archive.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ArchiveTests(unittest.TestCase):
    cases = [{'name': 'loan-prepayment', 'id': '11111111-1111-4111-8111-111111111111'}]

    def test_invalid_requests_cannot_reach_database_or_child(self):
        for value in [[], [{'name': [], 'id': 'bad'}], [{'name': 'loan-prepayment', 'id': "';DROP"}], self.cases * 2]:
            with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.sys, 'stdin', io.StringIO(json.dumps(value))), patch.object(m.subprocess, 'run') as child:
                with self.assertRaises(ValueError):
                    m.main()
                child.assert_not_called()

    def test_private_values_and_environment_do_not_reach_output_or_a_provider(self):
        output = io.StringIO()
        saved = json.dumps([{'name': 'loan-prepayment', 'question': 'SYNTHETIC_PRIVATE_MARKER', 'calls': []}])
        db = types.SimpleNamespace(database=lambda: 'synthetic-container', run=lambda *args: saved)
        captured = []
        db.run = lambda args, sql: (captured.append(sql), saved)[1]
        loader = types.SimpleNamespace(exec_module=lambda module: None)
        child_output = 'PASS archived-loan-prepayment: CHECKED\nARCHIVE_RESULT: 1/1; 0 model calls, 0 RUB\n'
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.sys, 'stdin', io.StringIO(json.dumps(self.cases))), patch.object(m.importlib.util, 'spec_from_file_location', return_value=types.SimpleNamespace(loader=loader)), patch.object(m.importlib.util, 'module_from_spec', return_value=db), patch.object(m.subprocess, 'run', return_value=types.SimpleNamespace(stdout=child_output, stderr='SYNTHETIC_PRIVATE_MARKER', returncode=0)) as child, contextlib.redirect_stdout(output):
            self.assertEqual(m.main(), 0)
        self.assertEqual(output.getvalue(), child_output)
        self.assertNotIn('SYNTHETIC_PRIVATE_MARKER', output.getvalue())
        self.assertTrue(captured[0].startswith('BEGIN TRANSACTION READ ONLY;'))
        self.assertTrue(captured[0].endswith('ROLLBACK;'))
        self.assertIn('LEFT JOIN finance.assistant_run', captured[0])
        self.assertNotIn('finance.operation', captured[0])
        self.assertEqual(set(child.call_args.kwargs['env']), {'PATH', 'LANG'})
        self.assertEqual(child.call_args.args[0], ['node', '--import', 'tsx', '../../scripts/check-analyzer-archive.ts'])

    def test_root_is_required_before_any_database_access(self):
        with patch.object(m.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(RuntimeError, 'ROOT_REQUIRED'):
                m.main()


if __name__ == '__main__':
    unittest.main()
