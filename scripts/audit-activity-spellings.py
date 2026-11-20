#!/usr/bin/env python3
"""Offline audit of a finite ACT vocabulary: literal boundaries and containment.

This is a document audit, not the product classifier, sanitizer, semantic parser,
model benchmark or deployment acceptance. No network/DB/model requests.
"""
from pathlib import Path
from collections import defaultdict
import argparse
import hashlib
import json
import re
import subprocess
import unicodedata

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'docs/architecture/activity-vocabulary-20261028.json'
BASE='061085a12be5804e28e4facca7a032db0d117f26'
BASE_BLOB='1d7249fd625a855b0beec5fc26d3b9a9cd447489'

def require(condition,message):
    if not condition: raise ValueError(message)

def normalize(text):
    value=re.sub(r'\s+',' ',unicodedata.normalize('NFKC',text).casefold().replace('ё','е')).strip()
    chars=list(value)
    for i,ch in enumerate(chars):
        if ch in '\u2010\u2011' and 0<i<len(chars)-1 and chars[i-1].isalpha() and chars[i+1].isalpha():
            chars[i]='-'
    return ''.join(chars)

def token_character(ch):
    # Unknown underscores and formatting controls must not manufacture boundaries.
    return bool(ch) and (unicodedata.category(ch)[0] in 'LMN' or ch=='_' or unicodedata.category(ch)=='Cf')

def literal_contains(text,form):
    text=normalize(text);form=normalize(form);start=0
    while True:
        i=text.find(form,start)
        if i<0:return False
        end=i+len(form)
        if (i==0 or not token_character(text[i-1])) and (end==len(text) or not token_character(text[end])):return True
        start=i+1

def inspect_vocabulary(data):
    occurrences=defaultdict(set);by_initial=defaultdict(list)
    for entry in data['entries']:
        for form in entry['forms']:
            normalized=normalize(form['text'])
            occurrences[normalized].add(entry['id'])
    for form,ids in occurrences.items():
        by_initial[form[0]].append((form,ids))
    # Extract whole-boundary substrings, then look them up. No arbitrary stemmer/fuzzy match.
    relations=defaultdict(set)
    for outer,outer_ids in occurrences.items():
        for start in range(len(outer)):
            if start and token_character(outer[start-1]):continue
            for inner,inner_ids in by_initial.get(outer[start],[]):
                end=start+len(inner)
                if inner==outer or not outer.startswith(inner,start):continue
                if end<len(outer) and token_character(outer[end]):continue
                for aid in outer_ids:
                    for bid in inner_ids:
                        if aid!=bid:relations[(aid,bid)].add((outer,inner))
    return occurrences,relations

# Hand-written boundary oracles are separate from automatically enumerated inventory probes.
# They deliberately do NOT claim semantic assignment or privacy behavior.
BOUNDARY_PROBES=[
 ('Аптека','аптека',True),('АПТЕКА','аптека',True),('в аптеках','аптеках',True),
 ('аптекою','аптекою',True),('аптеками','аптеками',True),('aptekom','apteka',False),
 ('в оптике','оптике',True),('optikoy','optikoy',True),('optika','apteka',False),
 ('apтека','apтека',True),('0птика','оптика',False),('аптeка','аптeка',True),
 ('CAFÉ','café',True),('в столовой','столовой',True),('stolovoi','stolovoi',True),
 ('APTEKA777','apteka',False),('777APTEKA','apteka',False),('APTEKA_777','apteka',False),
 ('prefix_APTEKA','apteka',False),('супераптека','аптека',False),('аптекарь','аптека',False),
 ('аптека\u200bРомашка','аптека',False),('ап\u200bтека','аптека',False),('аптека\u0301','аптека',False),
 ('кафе\u00a0Роза','кафе',True),('фитнес\u2011клуб','фитнес-клуб',True),
 ('фитнес\u2010клуб','фитнес-клуб',True),('фитнес\u2014клуб','фитнес-клуб',False),
 ('фитнес\u2212клуб','фитнес-клуб',False),('сушибар','бар',False),('суши-бар','бар',True),
 ('онлайн-кинотеатр','кинотеатр',True),('онлайн-кинотеатр','онлайн-кинотеатр',True),
 ('pet hotel','hotel',True),('ветеринарная клиника','клиника',True),
 ('ветклиника','клиника',False),('ветаптека','аптека',False),
 ('Ж/Д БИЛЕТ','ж/д билет',True),('ЖД-БИЛЕТ','жд-билет',True),
 ('IP-телефонии','ip-телефонии',True),('co-working','co-working',True),
 ('minimarketplace','marketplace',False),('market','marketplace',False),
 ('гостиницах','гостиницах',True),('ремонта обуви','обуви',True),
 ('СТО рублей','сто',True),('5 bar','bar',True),
 # Full-width Latin folds under NFKC, unlike OCR zero or unregistered script guesses.
 ('ＡＰＴＥＫＡ','apteka',True),('аптека_служба','аптека',False),
 ('кафе-пекарня','кафе-пекарня',True),('кафе\u2011пекарня','кафе-пекарня',True),
 ('буфетом','буфетом',True),('врачом','врачом',True),('ветврач','врач',False),
]

def run_audit(data,old):
    entries={e['id']:e for e in data['entries']};old_entries={e['id']:e for e in old['entries']}
    require(entries.keys()==old_entries.keys(),'Activity identity set changed during spelling audit')
    preserved=0
    for key,entry in old_entries.items():
        current=entries[key]
        for field in ['activity','domain','required_context','category','source_effect','runtime_activation','model_usage']:
            require(current[field]==entry[field],'Existing activity contract changed: '+key+' '+field)
        require(set(entry['negative_contexts'])<=set(current['negative_contexts']),'Lost old negative context')
        newforms={(f['kind'],f['text']) for f in current['forms']}
        for form in entry['forms']:
            require((form['kind'],form['text']) in newforms,'Lost old spelling: '+key+' '+form['text']);preserved+=1
    for key in ['specific_senses','category_name_candidates','retained_inputs']:
        require(data[key]==old[key],'Changed retained contract: '+key)
    require(data['rules'][:len(old['rules'])]==old['rules'],'Old rule text changed')
    require(data['scenario_families'][:len(old['scenario_families'])]==old['scenario_families'],'Old future oracle changed')
    occurrences,relations=inspect_vocabulary(data)
    declared={(p['outer_activity'],p['inner_activity']):p for p in data['containment_intersections']}
    require(set(declared)==set(relations),'Missing/extraneous containment group')
    for pair,examples in relations.items():
        record=declared[pair]
        require(record['decision'] and record['mode'],'Unresolved lexical group')
        require(set(tuple(v) for v in record['examples'])==examples,'Containment example drift')
        require(record['status']=='RESOLVED_DESIGN_CONTEXT_NOT_RUNTIME_PASS','Invalid collision status')
    literal={form:sorted(ids) for form,ids in occurrences.items() if len(ids)>1}
    require(literal=={v['form']:sorted(v['activity_refs']) for v in data['normalized_literal_collisions']},'Literal collision drift')
    guard_map={g['id']:g for g in data['form_context_guards']}
    require(len(guard_map)==len(data['form_context_guards']),'Duplicate guard')
    for entry in data['entries']:
        for f in entry['forms']:
            if 'guard_id' in f:
                require(f['guard_id'] in guard_map and entry['id'] in guard_map[f['guard_id']]['activity_refs'],'Foreign/missing guard')
            if 'derivation' in f:
                origin=f['derivation']['source_form']
                require(any(z['text']==origin and z['kind']=='cyrillic' for z in entry['forms']),'Transliteration origin lost')
                actual=''.join(data['materialized_transliteration']['map'].get(c,c) for c in normalize(origin))
                require(actual==f['text'],'Transliteration candidate not from finite source')
    for guard in guard_map.values():
        require(guard['condition'],'Guard without context')
        for form in guard['forms']:
            require(any(normalize(f['text'])==normalize(form) and f.get('guard_id')==guard['id'] for aid in guard['activity_refs'] for f in entries[aid]['forms']),'Guard form not registered: '+guard['id']+' '+form)
    probe_count=0
    for text,form,expected in BOUNDARY_PROBES:
        require(literal_contains(text,form)==expected,'Boundary probe failed: '+repr((text,form,expected)));probe_count+=1
    for form in occurrences:
        require(literal_contains('('+form+')',form),'Registered literal not found')
        require(literal_contains('('+form.swapcase()+')',form),'Case normalization failed')
        for left,right in [('ж',''),('','ж'),('7',''),('','7'),('_',''),('','_'),('','\u200b')]:
            require(not literal_contains(left+form+right,form),'Embedded token false boundary: '+repr(form))
    require(len(data['composition_rules'])==8,'Composition rule loss')
    # These are metadata checks of future semantic oracles, NOT execution of semantic assignment.
    require(all(v['status']=='NOT_RUN' for v in data['scenario_families']),'Semantic future cases falsely passed')
    additions=[]
    actual_additions={}
    for key,entry in entries.items():
        previous={(f['kind'],f['text']) for f in old_entries[key]['forms']}
        new=[f for f in entry['forms'] if (f['kind'],f['text']) not in previous]
        if new: actual_additions[key]={f['text'] for f in new}
        additions.extend(new)
    require(actual_additions=={e['activity_id']:set(e['forms']) for e in data['spelling_additions']},'Addition references differ from actual baseline delta')
    from collections import Counter
    return {
        'audit':'cashneuro-activity-spelling-audit/2','status':'PASS_LEXICAL_DATA_ONLY',
        'baseline_commit':BASE,'scope':'Finite spelling data, retention, raw literal boundaries, normalization and fully recorded containment. NOT product semantic classification.',
        'activities':len(entries),'old_forms_preserved':preserved,'forms_within_records':sum(len(e['forms']) for e in entries.values()),
        'distinct_normalized_forms':len(occurrences),'new_forms':len(additions),
        'new_form_types':dict(Counter('materialized_transliteration' if f.get('derivation') else f['kind'] for f in additions)),
        'exact_cross_activity_collision_groups':len(literal),'containment_groups':len(relations),
        'containment_examples':sum(len(v) for v in relations.values()),'all_containment_groups_have_design_resolution':True,
        'hand_written_literal_boundary_probes_passed':probe_count,'registered_literals_checked':len(occurrences),
        'inventory_checks_per_literal':{'enclosed_literal':1,'case_variant':1,'forbidden_attached_boundary':7},
        'context_guards':len(guard_map),'composition_rules':len(data['composition_rules']),
        'future_semantic_scenario_families':len(data['scenario_families']),
        'data_sha256':hashlib.sha256(DATA.read_bytes()).hexdigest(),
        'runtime_tests':'NOT_RUN','ui_tests':'NOT_RUN','model_tests':'NOT_RUN','paid_calls':0,
        'limitations':'No morphological exhaustiveness, observed banking-alias evidence, semantic parser implementation, category accuracy, sanitizer or Staging acceptance is claimed by literal checks.',
    }

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--baseline-vocabulary',type=Path);args=parser.parse_args()
    if args.baseline_vocabulary:raw=args.baseline_vocabulary.read_bytes()
    else:raw=subprocess.check_output(['git','show',BASE+':docs/architecture/activity-vocabulary-20261028.json'],cwd=ROOT)
    require(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==BASE_BLOB,'Unverified previous vocabulary snapshot')
    print(json.dumps(run_audit(json.loads(DATA.read_text()),json.loads(raw)),ensure_ascii=False,indent=2))

if __name__=='__main__':main()
