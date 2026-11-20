#!/usr/bin/env python3
"""Generate finite NAME styles and the four agreed catalog blocks, not prose rules."""
import argparse,hashlib,importlib.util,json,sys
sys.dont_write_bytecode=True
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def encode(v):return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def build():
 spec=importlib.util.spec_from_file_location('catalog_build',ROOT/'scripts/compile-merchant-catalog.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);ir=module.compile_catalog()
 rows=[]
 for d in ir['documents']:
  if not any(k in d['path'] for k in ['-logistics-','-household-services-','-professional-services-','-office-advertising-']):continue
  tables=[b for b in d['blocks'] if b['kind']=='table'];sources=tables[0]['rows'];forms=tables[1]['rows'];categories=tables[2]['rows']
  assert len(sources)==len(forms)==len(categories)
  for a,b,c in zip(sources,forms,categories):
   pid,name,source,condition=a['cells'];assert b['cells'][0].startswith(pid+' ') and c['cells'][0].startswith(pid+' ')
   if pid.startswith('LOG'):guard='logistics';target='logistics'
   elif pid.startswith('SVC'):guard='household';target='household_service'
   elif pid.startswith('PRF'):guard='professional';target=None
   else:
    n=int(pid[3:]);guard='retail' if n<=4 else 'printing' if n<=10 else 'workspace' if n<=18 else 'advertising';target='work_expense' if 11<=n<=18 else None
   active=pid not in ['LOG022','PRF001','PRF002','PRF016']
   rows.append({'id':pid,'name':name,'forms':[f.strip() for f in b['cells'][1].split(';') if f.strip()],'guard':guard,'target':target,'active':active,'source':source,'sourceDocument':d['path'],'sourceLine':a['from_line'] if 'from_line' in a else tables[0]['from_line'],'identityCondition':condition,'categoryCondition':c['cells'][1]})
 assert len(rows)==81 and len({r['id'] for r in rows})==81
 name_raw=(ROOT/'docs/architecture/operation-display-names-20261028.json').read_bytes();name=json.loads(name_raw);assert len(name['style_bindings'])==36
 styles=[{'id':v['id'],'profile':v['profile_label'],'mode':v['mode'],'labels':v['labels']} for v in name['style_bindings']]
 out="// Generated finite data. Names/forms are candidates, not observed bank aliases.\n"
 out+="export const nameDataSha256='"+hashlib.sha256(name_raw).hexdigest()+"';\n"
 out+="export type ExtendedProfile={id:string;name:string;forms:readonly string[];guard:'logistics'|'household'|'professional'|'retail'|'printing'|'workspace'|'advertising';target:string|null;active:boolean;source:string;sourceDocument:string;sourceLine:number;identityCondition:string;categoryCondition:string};\n"
 out+='export const extendedProfiles:readonly ExtendedProfile[]='+encode(rows)+';\n'
 out+="export const extendedCatalogSha256='"+hashlib.sha256(encode(rows).encode()).hexdigest()+"';\n"
 out+="export type NameStyle={id:string;profile:string;mode:string;labels:Readonly<Partial<Record<'Latin'|'Cyrillic'|'Mixed',string>>>};\n"
 out+='export const nameStyles:readonly NameStyle[]='+encode(styles)+';\n'
 return out.encode()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--check',action='store_true');a=p.parse_args();raw=build();out=ROOT/'packages/finance-core/src/catalog/generated/name-v1.ts'
 if a.check:
  if not out.exists() or out.read_bytes()!=raw:raise ValueError('NAME/runtime catalog drift')
 else:out.write_bytes(raw)
 print(json.dumps({'status':'PASS_FINITE_NAME_DATA','profiles':81,'styles':36,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'semantic_accuracy_claim':False,'paidCalls':0}))
if __name__=='__main__':main()
