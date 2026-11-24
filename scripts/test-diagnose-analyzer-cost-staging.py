import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import stat
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cost_diagnostic', Path(__file__).with_name('diagnose-analyzer-cost-staging.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CostTests(unittest.TestCase):
    def settings(self):
        return {'realm':'staging/finance','apiKey':'SYNTHETIC_SECRET','monthly':{'limitRub':'100'},
            'allowedEmails':['synthetic@example.test'],'cost':{'projectId':'staging/test',
                'price':{'currency':'RUB','inputRubPerMillion':'15.86','outputRubPerMillion':'61'}}}

    def test_monthly_ledger_and_requested_costs_are_read_only_and_include_prior_trial_buckets(self):
        text = m.query(self.settings(), ['11111111-1111-1111-1111-111111111111'], datetime.datetime(2026,12,31,20,tzinfo=datetime.timezone(datetime.timedelta(hours=3))))
        self.assertTrue(text.startswith('BEGIN READ ONLY;'))
        self.assertTrue(text.endswith('ROLLBACK;\n'))
        self.assertIn('created_at >=', text)
        self.assertIn('created_at <', text)
        self.assertNotIn('c.project_period_start=', text)
        for value in ['SYNTHETIC_SECRET','synthetic@example.test','UPDATE ','INSERT ','DELETE ','DROP ']:
            self.assertNotIn(value,text)
        self.assertIn("'heldAtoms'",text)
        self.assertIn("'previousDiagnostic'",text)
        self.assertIn('reported_input_tokens',text)
        self.assertIn('owners',text)

    def test_invalid_scope_or_ids_cannot_be_interpolated(self):
        for ids in [["';DROP TABLE example"], ['a']*129]:
            with self.assertRaisesRegex(ValueError,'REQUEST_IDS_INVALID'):
                m.query(self.settings(),ids)
        for settings in [{**self.settings(),'realm':'production/finance'}, {**self.settings(),'monthly':{'limitRub':'101'}}]:
            with self.assertRaises(ValueError):m.query(settings,[])

    def test_output_contains_only_costs_and_public_prices_not_the_private_configuration(self):
        report={'version':'analyzer-cost-diagnostic/1','paidCalls':0,'spentAtoms':'20000000000','heldAtoms':'0','requests':[]}
        output=io.StringIO()
        with patch.object(m.os,'geteuid',return_value=0),patch.object(m.sys,'argv',['cost']),patch.object(Path,'lstat',return_value=types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_size=100)),patch.object(Path,'read_text',return_value=json.dumps(self.settings())),patch.object(m.account,'database',return_value='synthetic-container'),patch.object(m.account,'run',return_value=json.dumps(report)) as run,contextlib.redirect_stdout(output):
            m.main()
        self.assertNotIn('SYNTHETIC_SECRET',output.getvalue())
        self.assertNotIn('synthetic@example.test',output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['price'],self.settings()['cost']['price'])
        self.assertIn('finance_staging',run.call_args.args[0][-1])
        self.assertTrue(run.call_args.args[1].startswith('BEGIN READ ONLY;'))


if __name__=='__main__':unittest.main()
