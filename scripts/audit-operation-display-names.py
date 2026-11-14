#!/usr/bin/env python3
"""Audit NAME design/evidence files only. No product, model, DB or network calls."""
from pathlib import Path
import hashlib
import json
import re

ROOT=Path(__file__).resolve().parents[1]
D=ROOT/'docs/architecture'
DATA=D/'operation-display-names-20261028.json'
DOC=DATA.with_suffix('.md')
BASELINE=D/'operation-display-name-baseline-20261028.json'
BASE='55f2f92832b44d1a75c48d87c02bb1b514a2e0c7'

def require(condition,message):
    if not condition:raise ValueError(message)

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def sequence(rows,key,prefix,count,width):
    require([v[key] for v in rows]==[prefix+str(i).zfill(width) for i in range(1,count+1)],'ID drift: '+prefix)

def main():
    data=json.loads(DATA.read_text());text=DOC.read_text();baseline=json.loads(BASELINE.read_text())
    require(data['baseline_commit']==baseline['baseline_commit']==BASE,'Wrong source baseline')
    require(data['schema']=='cashneuro-operation-name-design/1','Unknown schema')
    require(data['status']=='PREPARED_FOR_OWNER_REVIEW_NOT_DEPLOYED','Misrepresented approval/runtime')
    require(data['default_policy']=='SOURCE_SCRIPT_SAFE_READ_ONLY_VIEW','Unsafe default policy')
    require(data['new_paid_calls']==baseline['new_paid_calls']==0,'Unexpected paid-call claim')
    require(data['runtime_product_tests']==data['model_tests']=='NOT_RUN','Unexpected product/model acceptance')
    fields=data['projection_fields']
    require({v['field'] for v in fields}=={'title','eventLabel','serviceQualifier','fulfillmentQualifier','viaLabel','compositeLabel','safeBankDescriptionRef','explanationCode'},'Missing/extra projection field')
    require(all(v['write_authority']=='NONE_READ_ONLY' for v in fields),'Presentation may write source')
    require(data['immutable_fields'] and all(s in data['immutable_fields'] for s in ['source','semantics for matching','amountMinor','operation ID','HMAC/dedupe/alias identity','user rules']),'Missing protected-data boundary')
    sequence(data['rules'],'id','NAME-R',48,2)
    sequence(data['transformations'],'id','NAME-P',12,2)
    sequence(data['style_bindings'],'id','NAME-S',36,2)
    sequence(data['future_scenarios'],'id','NAME-T',86,3)
    sequence(data['implementation_findings'],'id','NAME-I',6,2)
    require(len({s['profile_label'] for s in data['style_bindings']})==36,'Duplicate profile style')
    for rule in data['rules']:
        require(rule['contract'] in text and rule['id'] in text,'Rule missing from document')
    for v in data['transformations']:
        require(v['action'] and v['guard'] and v['id'] in text,'Transformation missing guard')
    previous=[]
    for style in data['style_bindings']:
        require(style['mode'] in ['EXPLICIT_OWNER_OVERRIDE','SAME_SCRIPT_STYLE'],'Implicit language policy')
        require(style['default_for_unlisted_script']=='RETAIN_MATCHED_SAFE_SOURCE_SPELLING','Unlisted script has no final fallback')
        require(style['identity_matching']=='USE_PRIOR_CATALOG_IDENTITY_ONLY_NO_NEW_ALIASES' and style['period_required'] is True,'Style is improperly a new recognizer')
        require(style['context_guard'] and style['labels'] and style['id'] in text,'Incomplete style')
        require((D/style['source_document']).is_file(),'Missing source architecture')
        if style['status']=='PREVIOUS_OWNER_EXCEPTION':previous.append(style)
        else:require(style['status']=='PROPOSED_STYLE_FOR_OWNER_REVIEW_NOT_ACTIVE','New style falsely approved')
    require(len(previous)==1 and previous[0]['profile_label']=='TimeWeb' and set(previous[0]['labels'].values())=={'TimeWeb'},'Owner TimeWeb exception drift')
    for case in data['future_scenarios']:
        require(case['status']=='NOT_RUN_PRODUCT_OR_MODEL' and case['source_write'] is False,'Future scenario falsely executed/writes facts')
        require(case['preconditions'] and case['expected_title'] and case['expected_explanation'],'Incomplete future oracle')
        require(case['id'] in text and case['expected_explanation'] in text,'Future oracle not in document')
        require('expected_event_label' in case,'Financial event mixed with merchant title')
    require(data['composition_contract']['matching'] and data['composition_contract']['ordering'],'No read-only matching/composition boundary')
    require(baseline['status']=='BASELINE_OBSERVATIONS_RECORDED_NOT_A_NAME_IMPLEMENTATION','Baseline probe falsely claims NAME acceptance')
    require(baseline['source_or_database_writes']==0 and baseline['synthetic_inputs']==15 and baseline['source_files_verified']==12,'Baseline execution scope drift')
    sequence(baseline['observations'],'id','NAME-B',15,2)
    checkmap={v['id']:v for v in baseline['baselineChecks']}
    require(set(checkmap)=={f'NAME-I{i:02d}' for i in range(1,6)},'Baseline evidence coverage drift')
    require(all(c['observed_risk'] is True for c in checkmap.values()),'Recorded reproduced drift unsupported by observations')
    ids={v['id'] for v in baseline['observations']}
    for c in checkmap.values():require(set(c['observation_refs'])<=ids,'Dangling observation evidence')
    for issue in data['implementation_findings']:
        require(issue['rules'] and all(any(r['id']==ref for r in data['rules']) for ref in issue['rules']),'Issue has no contract rule')
        require(issue['status']==('INTEGRATION_REQUIREMENT_NOT_FIXED' if issue['id']=='NAME-I06' else 'REPRODUCED_NOT_FIXED'),'Issue falsely closed by document')
        require(issue['id'] in text and issue['required'] in text,'Issue result absent from document')
    frozen=data['frozen_sources']
    require(len(frozen)==12 and len({v['path'] for v in frozen})==12,'Incomplete frozen input manifest')
    require(all(re.fullmatch(r'[0-9a-f]{40}',v['blob']) for v in frozen),'Invalid source hash')
    require(data['pdf_basis']['sha256']=='5255d758534e74c9329cb8437e8a862f4bf989999172903a862462294b4ce9c8' and data['pdf_basis']['fresh_binary_read'] is False,'Misrepresented primary-source review')
    retained=data['retained_inputs']
    for row in retained:
        q=ROOT/row['path'];require(q.is_file() and digest(q)==row['sha256'],'Retained input changed: '+row['path'])
    counts={'rules':len(data['rules']),'projection_fields':len(fields),'transformations':len(data['transformations']),'style_bindings':len(data['style_bindings']),'future_scenario_families':len(data['future_scenarios']),'implementation_findings':len(data['implementation_findings']),'frozen_source_files':len(frozen),'retained_inputs':len(retained)}
    require(counts==data['counts'],'Count drift')
    print(json.dumps({'audit':'cashneuro-name-document-audit/1','status':'PASS_DOCUMENT_CONTRACT_ONLY','baseline_commit':BASE,'counts':counts,'retained_inputs_verified':len(retained),'data_sha256':digest(DATA),'document_sha256':digest(DOC),'baseline_observations_sha256':digest(BASELINE),'existing_functions_observed_on_synthetic_inputs':15,'reproduced_implementation_items_not_fixed':5,'separate_compatibility_item_not_fixed':1,'new_name_product_scenarios':'NOT_RUN','ui_tests':'NOT_RUN','model_tests':'NOT_RUN','new_paid_calls':0,'warning':'Structural PASS and baseline observations do not implement/fix/accept NAME, financial behavior or deployment.'},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
