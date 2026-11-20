#!/usr/bin/env python3
"""Compiler correctness tests; these do not test product classification."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('catalog_compiler',ROOT/'scripts/compile-merchant-catalog.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

class CompilerTests(unittest.TestCase):
    def test_escaped_pipes_inline_code_and_fenced_tables_keep_exact_source(self):
        source='## Еда вне дома: состав\n\n| ID | Значение |\n|---|---|\n| F01 | `a|b` и a\\|b |\n\n```markdown\n## Транспорт и автомобиль: пример\n| Fake | Table |\n|---|---|\n| R99 | Not data |\n```\n'
        blocks=c.document_blocks('merchant-catalog-master-20261025.md',source,'COMMON')
        self.assertEqual(''.join(b['text'] for b in blocks),source)
        tables=[b for b in blocks if b['kind']=='table'];self.assertEqual(len(tables),1)
        self.assertEqual(tables[0]['section'],'FOOD');self.assertEqual(tables[0]['rows'][0]['cells'],['F01','`a|b` и a\\|b'])
        self.assertEqual(blocks[-1]['section'],'FOOD')
        with self.assertRaisesRegex(ValueError,'Bad table width'):
            c.document_blocks('example.md','| A | B |\n|---|---|\n| 1 | 2 | 3 |\n','COMMON')

    def test_complete_build_roundtrips_every_document_and_preserves_inactive_oracles(self):
        x=c.compile_catalog();self.assertEqual(c.encode(x),c.encode(c.compile_catalog()))
        self.assertEqual((ROOT/c.MANIFEST).read_bytes(),c.encode(c.manifest_for(x,c.encode(x))))
        if (ROOT/c.OUTPUT).exists():self.assertEqual((ROOT/c.OUTPUT).read_bytes(),c.encode(x))
        for doc in x['documents']:
            self.assertEqual(''.join(b['text'] for b in doc['blocks']).encode(),(ROOT/doc['path']).read_bytes())
        self.assertEqual({s['id'] for s in x['sections']},{s['section'] for s in json.loads((ROOT/c.D/'merchant-catalog-consolidation-index-20261027.json').read_text())['coverage']})
        self.assertEqual(len(x['grocery_profiles']),50)
        refs=x['merchant_profile_references'];self.assertEqual(len(refs),len({r['key'] for r in refs}))
        net=[r for r in refs if r['source_profile_id']=='NET001']
        self.assertGreater(len({r['source_document'] for r in net}),1)
        self.assertTrue(all(not r['runtime_activation'] and not r['observed_bank_aliases_proven'] for r in refs+x['grocery_profiles']))
        self.assertEqual(x['model_context_authority'],'NONE');self.assertEqual(x['activation'],'INACTIVE_REQUIRES_TYPED_RUNTIME_GUARDS')
        self.assertTrue(all(r['status']=='NOT_RUN' for r in x['activity']['scenario_families']))
        self.assertTrue(all(r['status']=='NOT_RUN_PRODUCT_OR_MODEL' for r in x['name']['future_scenarios']))
        self.assertEqual(len(x['activity_literal_index']),4282)
        self.assertEqual(len({p['source_profile_id'] for p in refs if p['section']=='HOME'}),61)

    def test_foreign_disposition_and_cross_activity_alias_fail_closed(self):
        index=json.loads((ROOT/c.D/'merchant-catalog-consolidation-index-20261027.json').read_text())
        needed={r['path'] for r in index['compiled_corpus']['sources']}|{index['compiled_corpus']['path']}|{str(c.D/p) for p in ['merchant-catalog-consolidation-index-20261027.json','merchant-catalog-source-dispositions-20261027.json','activity-vocabulary-20261028.json','operation-display-names-20261028.json']}
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for path in needed:
                target=root/path;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/path,target)
            p=root/c.D/'merchant-catalog-source-dispositions-20261027.json';original=p.read_bytes();x=json.loads(original);x['records'][0]['id']='FOREIGN999';p.write_text(json.dumps(x))
            with self.assertRaisesRegex(ValueError,'Disposition without source row'):c.compile_catalog(root)
            p.write_bytes(original)
            p=root/c.D/'activity-vocabulary-20261028.json';x=json.loads(p.read_text());x['entries'][1]['forms'].append(x['entries'][0]['forms'][0]);p.write_text(json.dumps(x))
            with self.assertRaisesRegex(ValueError,'Cross-activity literal collision'):c.compile_catalog(root)

if __name__=='__main__':unittest.main()
