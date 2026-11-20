#!/usr/bin/env python3
"""Read-only integrity/traceability check of a plan, not a runtime test runner."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
D = ROOT / 'docs/architecture'
DATA = D / 'catalog-implementation-contract-20261028.json'
DOC = DATA.with_suffix('.md')
BASE = '89e2619ef9f013ec5773680404dbcbbcfc13d5bf'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    x = json.loads(DATA.read_text())
    text = DOC.read_text()
    act = json.loads((D / 'activity-vocabulary-20261028.json').read_text())
    name = json.loads((D / 'operation-display-names-20261028.json').read_text())
    index = json.loads((D / 'merchant-catalog-consolidation-index-20261027.json').read_text())
    dispositions = json.loads((D / 'merchant-catalog-source-dispositions-20261027.json').read_text())
    require(x['schema'] == 'cashneuro-catalog-implementation-contract/1', 'Unknown schema')
    require(x['status'] == 'IMPLEMENTATION_CONTRACT_PREPARED_NOT_IMPLEMENTED', 'False implementation status')
    require(x['baseline_commit'] == BASE, 'Source baseline changed')
    require(x['baseline_tree'] == 'ec1437968b727e002b929ad481c50002c688588a', 'Wrong source tree')
    require(x['product_source']['fresh_binary_read_this_step'] is False, 'False PDF reading claim')
    require(x['product_source']['sha256'] == index['source_pdf_sha256'], 'PDF basis drift')
    require(x['measured_this_step'] == {
        'contract_structure': 'AUDIT_TO_RUN', 'new_product_tests': 'NOT_RUN',
        'new_model_tests': 'NOT_RUN', 'paid_posts': 0, 'runtime_changes': False,
        'database_changes': False, 'deployment_changes': False,
    }, 'Plan is claiming runtime/model/deployment results')

    packages = x['work_packages']
    ids = [v['id'] for v in packages]
    require(ids == [f'IMPL-{i:02d}' for i in range(12)], 'Missing/duplicate work package')
    seen = set()
    planned_new = set()
    for p in packages:
        require(set(p['depends_on']) <= seen, 'Cycle/forward/unknown dependency: ' + p['id'])
        require(p['state'] == 'NOT_STARTED_PRODUCT_IMPLEMENTATION', 'False implemented package')
        require(p['id'] in text and p['title'] in text, 'Package absent from document')
        require(p['deliverables'] and p['required_checks'] and p['closes_only_after_checks'], 'Unreviewable package')
        require(all(s in text for s in p['deliverables'] + p['required_checks']), 'Document omits deliverable/check')
        for path in p['existing_paths'] + p['new_paths_proposed']:
            require(path in text and not path.startswith('/') and '..' not in Path(path).parts, 'Unsafe/missing source path')
        planned_new.update(p['new_paths_proposed'])
        seen.add(p['id'])
    require(packages[0]['write_authority'] == 'READ_ONLY', 'Source preflight may mutate')
    require(packages[5]['write_authority'] == 'PURE_READ_ONLY', 'NAME may mutate graph')
    require(packages[3]['write_authority'] == 'PURE_READ_ONLY', 'Matcher may mutate graph')
    require('IMPL-06' in packages[7]['depends_on'], 'FIN gate bypassed by runtime activation')
    require(set(packages[9]['depends_on']) == set(ids[1:9]), 'Offline check skips implementation package')
    require(packages[10]['depends_on'] == ['IMPL-09'], 'Model before offline checks')
    require(packages[11]['depends_on'] == ['IMPL-09', 'IMPL-10'], 'Staging skips required checks')

    groups = {
        'ACT_RULE': act['rules'], 'ACT_CONTEXT_GUARD': act['form_context_guards'],
        'ACT_COMPOSITION': act['composition_rules'], 'ACT_CONTAINMENT': act['containment_intersections'],
        'ACT_ACTIVITY': act['entries'], 'ACT_SCENARIO': act['scenario_families'],
        'ACT_TARGET': [{'id': v['semantic_key']} for v in act['category_name_candidates']],
        'ACT_SPECIFIC_SENSE': [{'id': v['specific'] + '->' + v['broad']} for v in act['specific_senses']],
        'ACT_ROUTER': [{'id': v['id']} for v in act['entries'] if v['category']['mode'] == 'CONTEXT_ROUTER'],
        'NAME_RULE': name['rules'], 'NAME_TRANSFORM': name['transformations'],
        'NAME_STYLE': name['style_bindings'], 'NAME_SCENARIO': name['future_scenarios'],
        'NAME_FINDING': name['implementation_findings'],
        'FIN_FINDING': [{'id': f'FIN-I{i:02d}'} for i in range(1, 5)],
    }
    expected = {(kind, row['id']) for kind, rows in groups.items() for row in rows}
    actual = [(row['kind'], row['id']) for row in x['traceability']]
    require(len(actual) == len(set(actual)) and set(actual) == expected, 'Missing/duplicate/foreign traceability')
    for row in x['traceability']:
        require(row['runtime_result'] == 'NOT_RUN', 'Trace row falsely executed')
        require(row['implementation_work'] and set(row['implementation_work']) <= seen, 'Orphan trace row')
        require('IMPL-09' in row['implementation_work'], 'Trace row has no acceptance check')
    require(len(expected) == 755, 'Traceability input drift requires explicit contract update')
    sections = x['merchant_sections']
    require([s['id'] for s in sections] == [s['section'] for s in index['coverage']], 'Section coverage drift')
    require(len(sections) == 24 and len({s['id'] for s in sections}) == 24, 'Missing catalogue section')
    for s in sections:
        require((ROOT / s['source_document']).is_file() and s['locator'], 'No detailed section source')
        require(s['runtime_result'] == 'NOT_RUN' and set(s['work']) <= seen, 'False section acceptance')
    corpus = index['compiled_corpus']
    require(digest(ROOT / corpus['path']) == corpus['sha256'], 'Frozen merchant corpus changed')
    require(x['source_dispositions']['count'] == len(dispositions['records']) == 129, 'Dispositions missing')
    require(x['source_dispositions']['counts'] == dispositions['counts'], 'Disposition states drift')

    issues = x['implementation_findings']
    require(len(issues) == 10 and len({v['id'] for v in issues}) == 10, 'Missing findings')
    for issue in issues:
        require(issue['current_status'] in {'REPRODUCED_NOT_FIXED', 'INTEGRATION_REQUIREMENT_NOT_FIXED', 'OPEN_INTEGRATION_NOT_FIXED'}, 'Issue falsely closed by plan')
        require(issue['work'] in seen and issue['acceptance'], 'No issue implementation/acceptance')
    node_paths = {v['path'] for v in x['selected_category_nodes']}
    require(len(node_paths) == 6 and {'Здоровье и спорт / Стоматология', 'Здоровье и спорт / Оптика', 'Здоровье и спорт / Медицинские изделия'} <= node_paths, 'Earlier selected healthcare nodes lost')
    require(all(v in text for v in node_paths), 'Selected node omitted from document')
    require(x['node_rollout']['existing_workspace'] == 'EXPLICIT_SETTINGS_PREVIEW_COMMIT_ONLY_REUSE_OWN_NODES', 'Implicit category mutation')
    require(x['node_rollout']['hidden_deleted'] == 'DO_NOT_RESURRECT', 'Category resurrection')
    require(x['node_rollout']['marketplace_0030'] == 'UNCHANGED_ONCE_ONLY', 'Marketplace initialization reset')
    compatibility = x['matching_compatibility']
    require(compatibility['name_is_identity'] is False and compatibility['persisted_universal_merchant_id_migration'] is False, 'Display becomes identity')
    require(compatibility['v1_key'] == 'EXISTING_SEMANTIC_MERCHANT_KEY' and compatibility['rule_migration'] == 'NONE_AUTOMATIC', 'Implicit matching migration')
    require(compatibility['query_exact_group_sort'] == 'LEGACY_SEMANTICS_UNCHANGED', 'Query selection silently changed')
    display = next(v for v in x['integration_interfaces'] if v['name'] == 'OperationDisplay')
    require(display['fields'] == [v['field'] for v in name['projection_fields']] and display['authority'] == 'NONE', 'Display fields/authority drift')
    require([v['id'] for v in x['invariants']] == [f'INV-{i:02d}' for i in range(1, 11)], 'Missing invariant')
    gates = x['release_gates']
    require([v['id'] for v in gates] == [f'GATE-{i:02d}' for i in range(1, 6)], 'Missing release gate')
    for gate in gates:
        require(gate['state'] == 'NOT_RUN' and set(gate['requires_work']) <= seen and gate['pass_evidence'], 'False/undefined release gate')
    require(set().union(*(set(g['requires_work']) for g in gates)) == seen, 'Package has no release gate')

    retained = x['retained_inputs']
    require(len(retained) == len({v['path'] for v in retained}) == 47, 'Retained input set drift')
    for row in retained:
        p = ROOT / row['path']
        require(p.is_file() and digest(p) == row['sha256'], 'Retained input changed: ' + row['path'])
    pins = x['inspected_source_files']
    require(len(pins) == len({v['path'] for v in pins}) == 23, 'Source inspection manifest drift')
    require(all(re.fullmatch('[0-9a-f]{40}', p['git_blob_sha']) for p in pins), 'Invalid source blob')
    require(not planned_new.intersection(p['path'] for p in pins), 'New module misrepresented as inspected old source')
    for link in re.findall(r'\]\(\./([^#)]+)(?:#[^)]*)?\)', text):
        require((D / link).is_file(), 'Broken local document link: ' + link)
    print(json.dumps({
        'audit': 'cashneuro-implementation-contract-audit/1', 'status': 'PASS_PLAN_INTEGRITY_ONLY',
        'baseline_commit': BASE, 'work_packages': len(packages),
        'traceability_rows': len(expected), 'trace_counts': dict(Counter(v['kind'] for v in x['traceability'])),
        'merchant_sections': len(sections), 'explicit_source_dispositions': 129,
        'retained_inputs_verified': len(retained), 'inspected_source_pins': len(pins),
        'selected_nodes': len(node_paths), 'findings_not_fixed': len(issues), 'release_gates_not_run': len(gates),
        'data_sha256': digest(DATA), 'document_sha256': digest(DOC),
        'product_tests': 'NOT_RUN', 'model_tests': 'NOT_RUN', 'paid_posts': 0,
        'warning': 'Plan completeness/integrity only; no product implementation, runtime acceptance, issue fix, paid call or deployment.',
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
