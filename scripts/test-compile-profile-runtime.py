"""Check finite source extraction and explicit identity references, offline."""
import importlib.util,sys,unittest
sys.dont_write_bytecode=True
from pathlib import Path
s=importlib.util.spec_from_file_location('profiles',Path(__file__).with_name('compile-profile-runtime.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Profiles(unittest.TestCase):
 @classmethod
 def setUpClass(cls):cls.raw,rows=m.build();cls.rows={r['id']:r for r in rows}
 def test_complete_closed_inventory(self):
  self.assertEqual(len(self.rows),1215);self.assertTrue(all(r['forms'] and r['sourceLine']>0 and r['outcome'] for r in self.rows.values()))
 def test_only_positive_form_fields(self):
  self.assertNotIn('YouDoo',self.rows['FR01']['forms']);self.assertNotIn('do',self.rows['FR01']['forms']);self.assertNotIn('Профи',self.rows['FR02']['forms']);self.assertNotIn('салон',self.rows['BEA001']['forms']);self.assertIn('585*ЗОЛОТОЙ',self.rows['FASH093']['forms'])
 def test_explicit_cross_section_references_are_not_guessed_by_position(self):
  for ref,target in {'MP040':'HOME002','MP041':'HOME003','MP042':'HOME004','MP043':'HOME005','MP044':'HOME006','MP048':'HOME037','MP052':'HOME041'}.items():self.assertEqual(self.rows[ref]['group'],target)
  self.assertNotIn('Петрович',self.rows['HOME004']['forms']);self.assertNotIn('ВсеИнструменты.ру',self.rows['HOME005']['forms'])
 def test_owner_dispositions_close_old_pending_but_preserve_exclusions(self):
  self.assertTrue(self.rows['FASH095']['active']);self.assertTrue(self.rows['BEA049']['active']);self.assertFalse(self.rows['BEA013']['active']);self.assertFalse(self.rows['FASH071']['active']);self.assertFalse(self.rows['GFT010']['active']);self.assertFalse(self.rows['PET065']['active']);self.assertFalse(self.rows['FIN001']['active'])
 def test_determinism_and_full_guards_are_retained_as_nonexecutable_prose(self):
  self.assertEqual(m.build()[0],self.raw);self.assertIn('не сервис',self.rows['FR03']['condition']);self.assertEqual(self.rows['FR03']['target'],None)
if __name__=='__main__':unittest.main()
