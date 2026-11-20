#!/usr/bin/env python3
"""Regenerate the browser/default snapshot of the independently updated dictionary."""
import json
from pathlib import Path

def compile_dictionary(root):
    value = json.loads((root / 'packages/finance-core/src/catalog/merchant-dictionary.json').read_text())
    result = '// Generated from merchant-dictionary.json; use scripts/compile-merchant-dictionary.py.\nexport const defaultMerchantDictionary=' + json.dumps(value, ensure_ascii=False, separators=(',', ':')) + ' as const;\n'
    (root / 'packages/finance-core/src/catalog/merchant-dictionary-data.ts').write_text(result)

if __name__ == '__main__':
    compile_dictionary(Path(__file__).resolve().parents[1])
