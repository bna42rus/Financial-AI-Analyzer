#!/usr/bin/env python3
"""Read-only structural audit of the ACT design, not a classifier or product test.

Run in a full checkout, or pass a verified --baseline-starter snapshot.
No network, credentials, model calls, DB writes or deployment operations.
"""
import argparse
import hashlib
import json
import re
import subprocess
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'docs/architecture/activity-vocabulary-20261028.json'
DOC = DATA.with_suffix('.md')
BASE = 'af6a2c997f47caf215eedb9840f70333d5a577f9'
STARTER_BLOB = 'f67d375dd00854fe2126d399a00673402f479019'
EXPECTED_DOMAINS = {'GRO','DEL','FOOD','TRN','PB','HEALTH','SPORT','FREELANCE','HOME','FASHION','BEAUTY','NET','DIG','MP','ENT','EDU','TRAVEL','PET','GIFT','FIN','LOG','SVC','PRF','OFF'}
PLANNED = {
    'Связь и интернет / Аренда пауэрбанков',
    'Здоровье и спорт / Спортивное питание',
    'Техника и электроника',
    'Здоровье и спорт / Стоматология',
    'Здоровье и спорт / Оптика',
    'Здоровье и спорт / Медицинские изделия',
}

def require(condition, message):
    if not condition:
        raise ValueError(message)

def norm(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value).casefold().replace('ё', 'е')).strip()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-starter', type=Path)
    args = parser.parse_args()
    if args.baseline_starter:
        starter = args.baseline_starter.read_bytes()
    else:
        starter = subprocess.check_output(['git', 'show', BASE + ':packages/finance-core/src/starter.ts'], cwd=ROOT)
    blob = hashlib.sha1(b'blob ' + str(len(starter)).encode() + b'\0' + starter).hexdigest()
    require(blob == STARTER_BLOB, 'Unverified baseline starter input')
    expense_part = starter.decode('utf-8').split('expense:[', 1)[1].split('],income:', 1)[0]
    baseline_paths = set()
    for row in re.findall(r'\[([^\[\]]+)\]', expense_part):
        names = re.findall(r"'([^']*)'", row)
        require(names, 'Invalid starter row')
        baseline_paths.add(names[0])
        baseline_paths.update(names[0] + ' / ' + child for child in names[1:])
    data = json.loads(DATA.read_text())
    text = DOC.read_text()
    require(data['baseline_commit'] == BASE, 'Wrong pinned base')
    require(data['status'] == 'PREPARED_FOR_OWNER_REVIEW_NOT_DEPLOYED', 'Misrepresented approval/runtime state')
    require(data['paid_calls'] == 0 and data['runtime_tests'] == 'NOT_RUN', 'Misrepresented execution state')
    require({g['id'] for g in data['groups']} == EXPECTED_DOMAINS, 'Domain coverage changed')
    entries = data['entries']
    ids = {e['id'] for e in entries}
    require(len(ids) == len(entries), 'Duplicate activity ID')
    require(len({e['activity'] for e in entries}) == len(entries), 'Duplicate activity label')
    occurrence = defaultdict(list)
    targets = {}
    for entry in entries:
        require(entry['domain'] in EXPECTED_DOMAINS, 'Unknown domain')
        require(entry['id'] in text, 'Activity absent from human-readable document')
        require(entry['source_effect'] == 'NONE' and entry['runtime_activation'] is False, 'Unexpected activation/write contract')
        require(entry['model_usage'] == 'NOT_RUN', 'Unexpected model test claim')
        require(entry['required_context'] and entry['negative_contexts'], 'Missing positive/negative context')
        require(all(isinstance(s, str) and s.strip() for s in entry['negative_contexts']), 'Empty negative context')
        forms = entry['forms']
        require(len(forms) >= 3, 'Insufficient explicit forms')
        require(len({norm(f['text']) for f in forms}) == len(forms), 'Duplicate normalized form within activity')
        for form in forms:
            require(form['kind'] in {'cyrillic','latin','explicit_mixed'}, 'Unknown form type')
            require(form['evidence'] == 'DESIGN_CANDIDATE_NOT_OBSERVED_BANK_ALIAS', 'Candidate represented as bank observation')
            require(form['text'] in text, 'Form missing in human-readable document')
            require(not re.search(r'https?://|@|\[скрыто\]', form['text'], re.I), 'Unexpected URL/identifier form')
            occurrence[norm(form['text'])].append(entry['id'])
        c = entry['category']
        require(c['mode'] in {'SEMANTIC_TARGET','CONTEXT_ROUTER'}, 'Unknown resolution mode')
        require(c['resolution'].strip(), 'Missing final resolution')
        if c['mode'] == 'SEMANTIC_TARGET':
            path = c['preferred_path']
            if c['availability'] == 'PREVIOUSLY_CHOSEN_NOT_ROLLED_OUT':
                require(path in PLANNED, 'New unapproved planned path')
            else:
                require(c['availability'] == 'BASELINE_PATH_NOT_AN_ID' and path in baseline_paths, 'Non-baseline target misrepresented as baseline')
            targets[c['key']] = path
    require({c['semantic_key']:c['preferred_path'] for c in data['category_name_candidates']} == targets, 'Category-name registry drift')
    for candidate in data['category_name_candidates']:
        require(candidate['condition'] and candidate['candidate_labels'], 'Missing mapping guard')
    overlaps = {f:sorted(set(refs)) for f,refs in occurrence.items() if len(set(refs)) > 1}
    declared = {c['form']:sorted(c['activity_refs']) for c in data['normalized_literal_collisions']}
    require(overlaps == declared, 'Unrecorded literal collision')
    require(all(c['resolution'] for c in data['normalized_literal_collisions']), 'Collision without resolution')
    edges = data['specific_senses']
    require(len({(c['specific'],c['broad']) for c in edges}) == len(edges), 'Duplicate precedence edge')
    for edge in edges:
        require(edge['specific'] in ids and edge['broad'] in ids and edge['specific'] != edge['broad'], 'Invalid sense reference')
        require(edge['condition'], 'Unconditional precedence')
    rule_ids = [v['id'] for v in data['rules']]
    require(rule_ids == [f'ACT-U{i:02d}' for i in range(1,41)], 'Rule sequence drift')
    for rule in data['rules']:
        require(rule['contract'] in text, 'Rule text differs from JSON')
    scenarios = data['scenario_families']
    require([v['id'] for v in scenarios] == [f'ACT-T{i:03d}' for i in range(1,len(scenarios)+1)], 'Scenario sequence drift')
    for case in scenarios:
        require(case['status'] == 'NOT_RUN', 'Future oracle presented as passed')
        require(case['expected'] and case['preconditions'] and case['activity_refs'], 'Incomplete future oracle')
        require(set(case['activity_refs']) <= ids, 'Invalid scenario ref')
        require(case['id'] in text and case['expected'] in text, 'Scenario absent/changed in document')
    by_name = {e['activity']:e for e in entries}
    # Previously approved non-obvious defaults must survive this new document.
    require(by_name['Пекарня и булочная']['category']['preferred_path'] == 'Еда вне дома / Рестораны и кафе', 'Bakery P04 regression')
    require('P10/T16' in by_name['Вендинг']['category']['resolution'] and 'не Рестораны и кафе' in by_name['Вендинг']['category']['resolution'], 'Food-vending P10/T16 regression')
    require('PET-U06' in by_name['Ветаптека']['category']['resolution'] and 'Питомцы/Ветеринар' in by_name['Ветаптека']['category']['resolution'], 'Veterinary-pharmacy policy regression')
    require('DIG066' in by_name['Домен']['category']['resolution'] and 'Облачные сервисы' in by_name['Домен']['category']['resolution'], 'Domain policy regression')
    require(by_name['Оптика']['category']['key'] != by_name['Аптека']['category']['key'], 'Optika/apteka conflation')
    require('apтека' in {f['text'] for f in by_name['Аптека']['forms']}, 'Lost explicit owner mixed-script case')
    require({e['category']['preferred_path'] for e in entries if e['category'].get('availability') == 'PREVIOUSLY_CHOSEN_NOT_ROLLED_OUT'} == PLANNED, 'Previously selected health/other nodes lost')
    for key in ['Проценты','Погашение кредита','Возврат','Собственный перевод','Биржа фриланса','Пункт выдачи','Административный канал']:
        require(by_name[key]['category']['mode'] == 'CONTEXT_ROUTER', 'Protected context given unconditional assignment')
    counts = {
        'domains':len(data['groups']), 'activities':len(entries),
        'forms_within_records':sum(len(e['forms']) for e in entries),
        'globally_distinct_normalized_forms':len(occurrence), 'rules':len(data['rules']),
        'semantic_category_targets':len(targets),
        'conditional_routers':sum(e['category']['mode']=='CONTEXT_ROUTER' for e in entries),
        'normalized_literal_collisions':len(overlaps), 'specific_sense_edges':len(edges),
        'future_scenario_families':len(scenarios),
    }
    require(counts == data['counts'], 'Count drift')
    retained = data['retained_inputs']
    require(retained, 'No retained source corpus evidence')
    for record in retained:
        path = ROOT / record['path']
        require(path.is_file() and digest(path) == record['sha256'], 'Retained input modified: ' + record['path'])
    result = {
        'audit':'cashneuro-activity-document-audit/1', 'status':'PASS_DOCUMENT_STRUCTURE_ONLY',
        'as_of':'2026-10-28', 'baseline_commit':BASE, 'baseline_starter_blob_sha':blob,
        'counts':counts, 'retained_inputs_verified':len(retained),
        'data_sha256':digest(DATA), 'document_sha256':digest(DOC),
        'paid_calls':0, 'runtime_tests':'NOT_RUN', 'ui_tests':'NOT_RUN', 'model_tests':'NOT_RUN',
        'warning':'Literal-collision count and structural checks are not semantic/product accuracy or implementation acceptance.',
    }
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__ == '__main__':
    main()
