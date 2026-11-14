import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('gate',Path(__file__).with_name('staging-gate-config.py'));gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
class GateConfig(unittest.TestCase):
 def test_scoped_idempotent_conversion_preserves_credentials_and_webhook(self):
  admin=b'admin.test.cashneuro.ru {\n basic_auth {\n admin synthetic_admin_hash\n }\n}\n'
  webhook=b'test.cashneuro.ru/api/payments/yookassa/webhook {\n reverse_proxy 127.0.0.1:3000\n}\n'
  data=b'test.cashneuro.ru {\n root * /srv/frontend\n basic_auth {\n owner synthetic_owner_hash\n }\n file_server\n}\n'+admin+webhook
  result=gate.configure(data);self.assertNotIn(admin,result);self.assertIn(b'admin synthetic_admin_hash',result);self.assertEqual(result.count(b'forward_auth @staging_protected'),2);self.assertIn(webhook,result);self.assertIn(b'owner synthetic_owner_hash',result);self.assertIn(b'forward_auth @staging_protected',result);self.assertIn(b'respond @external 404',result);self.assertEqual(gate.configure(result),result)
 def test_missing_or_duplicate_auth_fails_closed(self):
  for data in [b'cashneuro.ru {}',b'test.cashneuro.ru {}',b'test.cashneuro.ru { basic_auth { a b } basic_auth { a b } }']:
   with self.assertRaises(ValueError):gate.configure(data)
 def test_existing_web_gate_also_converts_admin(self):
  web=b'test.cashneuro.ru {\n basic_auth { owner hash }\n}\n'
  web=gate.configure_site(web,b'test.cashneuro.ru')
  result=gate.configure(web+b'admin.test.cashneuro.ru {\n basic_auth { admin adminhash }\n}\n')
  self.assertEqual(result.count(gate.START),2);self.assertEqual(gate.configure(result),result)
if __name__=='__main__':unittest.main()
