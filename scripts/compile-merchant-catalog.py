#!/usr/bin/env python3
"""Compile the complete design into a lossless, INACTIVE build intermediate.

This is not a markdown-to-runtime-rule interpreter. Exact guards, exclusions,
periods and oracles remain attached; no prose or alias is silently executable.
No network, model, DB, time-dependent output or user financial data.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ROOT=Path(__file__).resolve().parents[1]
D=Path('docs/architecture')
OUTPUT=Path('packages/finance-core/src/catalog/generated/catalog-v1.json')
MANIFEST=OUTPUT.with_name('catalog-v1.manifest.json')

def require(ok,message):
    if not ok:raise ValueError(message)

def sha(raw):return hashlib.sha256(raw).hexdigest()

def norm(s):return re.sub(r'\s+',' ',unicodedata.normalize('NFKC',s).casefold().replace('ё','е')).strip()

def cells(line):
    """Pipes escaped or enclosed by backticks are cell content, not separators."""
    text=line.strip();out=[];part='';code=0;i=0
    while i<len(text):
        c=text[i]
        if c=='\\' and i+1<len(text):part+=text[i:i+2];i+=2;continue
        if c=='`':
            j=i
            while j<len(text) and text[j]=='`':j+=1
            count=j-i
            if code==0:code=count
            elif code==count:code=0
            part+=text[i:j];i=j;continue
        if c=='|' and code==0:out.append(part.strip());part=''
        else:part+=c
        i+=1
    out.append(part.strip())
    if text.startswith('|'):out=out[1:]
    if text.endswith('|'):out=out[:-1]
    return out

MASTER_MARKERS=[('Межраздельный реестр бирж','FREELANCE'),('Обязательные проверки','COMMON'),('Реестр разделов','COMMON'),('Продуктовые магазины:','GROCERY'),('Полный список вариантов','GROCERY'),('Доставка продуктов и универсальные','DELIVERY'),('Еда вне дома:','FOOD'),('Транспорт и автомобиль:','TRANSPORT'),('Аренда пауэрбанков:','POWERBANK'),('Здоровье:','HEALTH'),('Фитнес, спорт','SPORT'),('Жильё, ремонт','HOME'),('Одежда, обувь','FASHION'),('Красота, косметика','BEAUTY')]

def document_blocks(path,text,section):
    lines=text.splitlines(keepends=True);blocks=[];context=[];start=1;headings=[];i=0;table=0;fence=None
    def flush(end):
        nonlocal context
        if context:blocks.append({'kind':'context','section':section,'heading_path':[h['text'] for h in headings],'from_line':start,'through_line':end,'text':''.join(context)});context=[]
    while i<len(lines):
        line=lines[i]
        marker=re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$',line.rstrip('\r\n'))
        if fence or marker:
            if not context:start=i+1
            context.append(line)
            if fence and marker and marker[1][0]==fence[0] and len(marker[1])>=len(fence) and not marker[2].strip():fence=None
            elif not fence and marker:fence=marker[1]
            i+=1;continue
        if line.startswith('#'):
            m=re.match(r'^(#{1,6}) (.+?)\s*$',line)
            if m:
                flush(i)
                level=len(m[1]);headings=[h for h in headings if h['level']<level]+[{'level':level,'text':m[2]}]
                if path.endswith('merchant-catalog-master-20261025.md') and level==2:
                    for marker,value in MASTER_MARKERS:
                        if m[2].startswith(marker):section=value;break
        header=cells(line) if line.lstrip().startswith('|') else []
        separator=cells(lines[i+1]) if i+1<len(lines) and lines[i+1].lstrip().startswith('|') else []
        if header and separator and all(re.fullmatch(r':?-{3,}:?',s) for s in separator):
            require(len(header)==len(separator),f'Bad table header: {path}:{i+1}')
            flush(i);table+=1;first=i;rows=[];i+=2
            while i<len(lines) and lines[i].lstrip().startswith('|'):
                values=cells(lines[i]);require(len(values)==len(header),f'Bad table width: {path}:{i+1}: {len(values)} != {len(header)}')
                rows.append({'key':f'{section}:{path}:table-{table}:row-{len(rows)+1}','line':i+1,'cells':values,'source_ids':re.findall(r'(?<![A-Z0-9-])(?:[A-Z]{1,12}-)?[A-Z]{1,8}-?\d{1,3}(?![A-Z0-9])',values[0])})
                i+=1
            blocks.append({'kind':'table','section':section,'table':table,'heading_path':[h['text'] for h in headings],'from_line':first+1,'through_line':i,'text':''.join(lines[first:i]),'header':header,'rows':rows});start=i+1
        else:
            if not context:start=i+1
            context.append(line);i+=1
    flush(len(lines));require(''.join(b['text'] for b in blocks)==text,'Source reconstruction failed: '+path)
    return blocks

def compile_catalog(root=ROOT):
    root=Path(root)
    def read(p):return (root/p).read_bytes()
    def load(p):return json.loads(read(p))
    index=load(D/'merchant-catalog-consolidation-index-20261027.json')
    dispositions=load(D/'merchant-catalog-source-dispositions-20261027.json')
    act=load(D/'activity-vocabulary-20261028.json')
    name=load(D/'operation-display-names-20261028.json')
    corpus=index['compiled_corpus'];require(sha(read(corpus['path']))==corpus['sha256'],'Frozen corpus mismatch')
    section_documents={}
    for row in index['coverage']:
        p=D/row['document']
        if p.name!='merchant-catalog-master-20261025.md':section_documents[str(p)]=row['section']
    # List/spelling/category/check companions belong to the same domain.
    for row in corpus['sources']:
        p=row['path']
        for prefix,section in [('merchant-catalog-connectivity-','CONNECTIVITY'),('merchant-catalog-telecom-','CONNECTIVITY'),('merchant-catalog-digital-','DIGITAL'),('merchant-catalog-beauty-','BEAUTY')]:
            if Path(p).name.startswith(prefix):section_documents[p]=section
    documents=[]
    for source in corpus['sources']:
        p=source['path'];raw=read(p);text=raw.decode('utf-8')
        documents.append({'path':p,'sha256':sha(raw),'frozen_source_sha256':source['sha256'],'blocks':document_blocks(p,text,section_documents.get(p,'COMMON'))})
    rows=[r for doc in documents for b in doc['blocks'] if b['kind']=='table' for r in b['rows']]
    require(len(rows)==len({r['key'] for r in rows}),'Row key collision')
    sections=[]
    for section in index['coverage']:
        tables=[b for doc in documents for b in doc['blocks'] if b['kind']=='table' and b['section']==section['section']]
        contexts=[b for doc in documents for b in doc['blocks'] if b['kind']=='context' and b['section']==section['section']]
        require(tables or contexts,'Section not compiled: '+section['section'])
        sections.append({'id':section['section'],'tables':len(tables),'context_blocks':len(contexts),'rows':sum(len(b['rows']) for b in tables),'detail_document':str(D/section['document']),'locator':section['locator']})
    entries=act['entries'];require(len(entries)==194,'ACT activity count drift')
    forms={}
    for e in entries:
        require(e['required_context'] and e['category'] and e['source_effect'],'ACT lacks context/category/source boundary: '+e['id'])
        for form in e['forms']:
            key=norm(form['text']);require(key not in forms or forms[key]==e['id'],'Cross-activity literal collision: '+key);forms[key]=e['id']
    require(len(forms)==4282,'ACT spelling count drift')
    require(all(e['status']=='NOT_RUN' for e in act['scenario_families']),'False ACT runtime result')
    require(all(e['status']=='NOT_RUN_PRODUCT_OR_MODEL' for e in name['future_scenarios']),'False NAME runtime result')
    records=dispositions['records'];require(len(records)==129 and len({r['id'] for r in records})==129,'Disposition coverage drift')
    # Each explicit disposition resolves a real old document ID; no invented ID.
    referenced={v for r in rows for v in r['source_ids']}
    require(all(r['id'] in referenced for r in records),'Disposition without source row')
    prefixes={'FOOD':'F','TRANSPORT':'R','POWERBANK':'PB','HEALTH':'H','SPORT':'FS','FREELANCE':'FR','HOME':'HOME','FASHION':'FASH','BEAUTY':'BEA','CONNECTIVITY':'(?:NET|TEL)','DIGITAL':'DIG','MARKETPLACES':'MP','ENTERTAINMENT':'ENT','EDUCATION':'EDU','TRAVEL':'TRV','PETS':'PET','GIFTS':'GFT','FINANCIAL':'FIN','LOG':'LOG','SVC':'SVC','PRF':'PRF','OFF':'OFF'}
    profiles={}
    by_disposition={r['id']:r for r in records}
    for doc in documents:
        for block in doc['blocks']:
            if block['section'] not in prefixes:continue
            pattern=re.compile(r'(?<![A-Z0-9-])'+prefixes[block['section']]+r'\d{2,3}(?![A-Z0-9-])')
            values=[(r['cells'][0],r['key']) for r in block['rows']] if block['kind']=='table' else [(block['heading_path'][-1] if block['heading_path'] else '',f"{block['section']}:{doc['path']}:context-{block['from_line']}")]
            for value,ref in values:
                for pid in pattern.findall(value):
                    # A legacy NET001 and a later NET001 are not automatically
                    # the same profile. Canonical/REF binding is a matcher task.
                    key=block['section']+':'+doc['path']+':'+pid
                    applicable=pid in by_disposition and any(Path(v['document']).name==Path(doc['path']).name for v in by_disposition[pid]['previous_sources'])
                    entry=profiles.setdefault(key,{'key':key,'source_profile_id':pid,'source_document':doc['path'],'section':block['section'],'source_refs':[],'source_disposition_id':pid if applicable else None,'eligibility_contract':'EXPLICIT_SOURCE_DISPOSITION_AND_PROFILE_ROWS' if applicable else 'PROFILE_CONDITIONS_IN_SOURCE_ROWS','runtime_activation':False,'observed_bank_aliases_proven':False})
                    if ref not in entry['source_refs']:entry['source_refs'].append(ref)
    # The grocery list uses numbered prose profiles, not a markdown table. Keep
    # their finite spelling lines typed without pretending all other prose is code.
    groceries=[]
    for doc in documents:
        if not doc['path'].endswith('merchant-catalog-master-20261025.md'):continue
        for b in doc['blocks']:
            if b['kind']!='context' or b['section']!='GROCERY' or not b['heading_path']:continue
            match=re.fullmatch(r'(\d+)\. (.+)',b['heading_path'][-1])
            if not match:continue
            profile_forms=[]
            for line in b['text'].splitlines():
                if line.startswith(('- Кириллица','- Латинские формы')):profile_forms.extend(re.findall(r'`([^`]+)`',line))
            if not profile_forms:continue
            groceries.append({'key':'GROCERY:'+match[1],'name':match[2],'forms':profile_forms,'source_document':doc['path'],'source_from_line':b['from_line'],'source_through_line':b['through_line'],'context_contract':b['text'],'runtime_activation':False,'observed_bank_aliases_proven':False})
    require(len(groceries)==50 and len({g['key'] for g in groceries})==50,'Grocery profile coverage drift')
    inputs=[str(D/'merchant-catalog-consolidation-index-20261027.json'),str(D/'merchant-catalog-source-dispositions-20261027.json'),str(D/'activity-vocabulary-20261028.json'),str(D/'operation-display-names-20261028.json')]
    output={
        'schema':'cashneuro-catalog-build-ir/1','version':'catalog-build/1','activation':'INACTIVE_REQUIRES_TYPED_RUNTIME_GUARDS','write_authority':'NONE','model_context_authority':'NONE',
        'policy':'Lossless build intermediate, not executable rules. Context/period/source disposition/REF/negative evidence must be compiled into typed matcher guards before runtime activation. A source profile is not proof of every bank alias.',
        'inputs':[{'path':p,'sha256':sha(read(p))} for p in inputs],
        'frozen_corpus':{'path':corpus['path'],'sha256':corpus['sha256'],'source_count':len(documents)},
        'sections':sections,'documents':documents,'merchant_profile_references':[profiles[k] for k in sorted(profiles)],'grocery_profiles':groceries,'source_dispositions':dispositions,
        'activity':{k:act[k] for k in ['schema','entries','rules','specific_senses','category_name_candidates','scenario_families','form_context_guards','materialized_transliteration','composition_rules','fulfillment_lexicon','containment_intersections']},
        'activity_literal_index':[{'normalized_form':f,'activity_id':forms[f]} for f in sorted(forms)],
        'name':{k:name[k] for k in ['default_policy','projection_fields','priority','rules','transformations','style_bindings','future_scenarios','immutable_fields','composition_contract']},
        'counts':{'sections':len(sections),'source_documents':len(documents),'tables':sum(b['kind']=='table' for doc in documents for b in doc['blocks']),'source_rows':len(rows),'qualified_profile_reference_groups':len(profiles),'grocery_profiles':len(groceries),'context_blocks':sum(b['kind']=='context' for doc in documents for b in doc['blocks']),'source_dispositions':len(records),'activity_entries':len(entries),'activity_forms':len(forms),'activity_context_guards':len(act['form_context_guards']),'activity_containments':len(act['containment_intersections']),'activity_scenarios':len(act['scenario_families']),'name_rules':len(name['rules']),'name_styles':len(name['style_bindings']),'name_scenarios':len(name['future_scenarios'])},
        'runtime_scenarios':'NOT_RUN','paid_posts':0,
    }
    return output

def encode(x):return (json.dumps(x,ensure_ascii=False,separators=(',',':'),sort_keys=True)+'\n').encode()

def manifest_for(result,raw):
    return {'schema':'cashneuro-catalog-build-manifest/1','artifact_path':str(OUTPUT),'artifact_sha256':sha(raw),'artifact_bytes':len(raw),'activation':result['activation'],'counts':result['counts'],'inputs':result['inputs'],'source_documents':[{'path':d['path'],'sha256':d['sha256']} for d in result['documents']],'frozen_corpus':result['frozen_corpus']}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');parser.add_argument('--output',type=Path,default=ROOT/OUTPUT);args=parser.parse_args()
    result=compile_catalog();raw=encode(result)
    manifest=encode(manifest_for(result,raw));manifest_path=ROOT/MANIFEST
    if args.check:
        require(manifest_path.is_file() and manifest_path.read_bytes()==manifest,'Generated catalogue manifest drift; run compiler')
        if args.output.is_file():require(args.output.read_bytes()==raw,'Generated catalogue drift; run compiler')
    else:
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(raw)
        manifest_path.parent.mkdir(parents=True,exist_ok=True);manifest_path.write_bytes(manifest)
    print(json.dumps({'status':'PASS_BUILD_IR_ONLY','mode':'check' if args.check else 'compile','activation':result['activation'],'counts':result['counts'],'bytes':len(raw),'sha256':sha(raw),'product_tests':'NOT_RUN','paid_posts':0},ensure_ascii=False))

if __name__=='__main__':main()
