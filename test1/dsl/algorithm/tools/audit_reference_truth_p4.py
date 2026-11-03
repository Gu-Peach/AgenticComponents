"""Recheck P4 evidence and independently aggregate against the frozen P3 ledger."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import shutil
import sys
import time

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from reference.frontend import load
from reference.transition import ReferenceModel
from reference.common import digest
from certification.binding import make_query
from certification.io import read, write, sha
from certification.policy import check_workspace
from certification_p4.binding import resolve_many


def verify_package(root):
    manifest = read(root / 'manifest.json')
    for relative, expected in manifest['files'].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root.resolve()) or sha(path) != expected:
            raise ValueError('Package drift: ' + str(path))
    return manifest


def decide(query, records):
    """No builder aggregation or saved final label is used here."""
    if query['applicability'] == 'NOT_APPLICABLE':
        return dict(truth_status='NOT_APPLICABLE', verdict=None, vacuous=None,
                    trigger_reachability='UNKNOWN', evidence_refs=[])
    proved = [r for r in records if r.get('verdict') is not None]
    reached = [r for r in records if r.get('trigger_reachability') == 'REACHABLE']
    if len({r['verdict'] for r in proved}) > 1:
        raise ValueError('Opposite checked verdicts')
    if reached and any(r.get('vacuous') is True for r in proved):
        raise ValueError('Unreachable trigger contradicted by a witness')
    common = dict(trigger_evidence_refs=sorted({r['evidence'] for r in reached}))
    if not proved:
        return dict(truth_status='UNRESOLVED', verdict=None, vacuous=None,
                    trigger_reachability='REACHABLE' if reached else 'UNKNOWN', evidence_refs=[],
                    unresolved_reason='NO_FULL_RESPONSE_WINDOW' if query['property_id'] == 'V10b'
                    and query.get('covered_trigger_cutoff', 0) < 1 else 'NO_CHECKED_EVIDENCE', **common)
    primary = sorted(proved, key=lambda r: (
        r.get('trigger_reachability') in ('REACHABLE', 'UNREACHABLE'),
        r.get('vacuous') is not None), reverse=True)[0]
    result = {k: v for k, v in primary.items() if k not in ('evidence', 'trigger_basis')}
    result.update(truth_status='CERTIFIED', primary_evidence=primary['evidence'],
                  evidence_refs=sorted({r['evidence'] for r in proved + reached}), **common)
    if reached:
        result['trigger_reachability'] = 'REACHABLE'
        if result['verdict'] == 'HOLDS':
            result['vacuous'] = False
    return result


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding='utf8').splitlines()]


def main(a):
    check_workspace(a.workspace)
    if a.output.exists() and any(a.output.iterdir()):
        raise ValueError('Choose a fresh admission directory')
    p1 = a.workspace / 'datasets/ac-path-v1/oracle/whole-line-v1'
    p3 = a.workspace / 'datasets/ac-path-v1/oracle/whole-line-p3-v1'
    verify_package(p1)
    p3_manifest = verify_package(p3)
    manifest = verify_package(a.candidates)
    plan = read(a.candidates / 'construction-plan.json')
    if sha(p3 / 'manifest.json') != plan['P3_manifest_sha256'] or sha(p1 / 'manifest.json') != plan['P1_manifest_sha256']:
        raise ValueError('Parent scope changed')
    if sha(BASE / 'tools/build_reference_truth_p4.py') != plan['builder_sha256']:
        raise ValueError('Construction source changed')
    supplement = plan.get('supplement')
    if supplement:
        if supplement['tool'] != 'tools/complete_reference_truth_p4.py' or sha(BASE / supplement['tool']) != supplement['sha256']:
            raise ValueError('Supplement source changed')
        if sha(a.candidates / 'provenance/supplement-input-manifest.json') != supplement['input_manifest_sha256']:
            raise ValueError('Supplement source manifest changed')
    for relative, expected in manifest['source_hashes'].items():
        if sha(BASE / relative) != expected:
            raise ValueError('P4 checker/kernel changed: ' + relative)
    for relative, expected in p3_manifest['source_hashes'].items():
        if sha(BASE / relative) != expected:
            raise ValueError('Frozen P3 source changed: ' + relative)
    originals = read(p1 / 'query-inventory.json')['queries']
    extensions = read(p1 / 'proposed-query-extensions.json')['queries']
    sources = {q['query_id']: q for q in originals + extensions}
    queries = read(a.candidates / 'query-registry.json')['queries']
    if len(sources) != len(queries) or len({q['query_id'] for q in queries}) != len(queries) or {q['source_query_id'] for q in queries} != set(sources):
        raise ValueError('Missing or duplicate query')
    p3_queries = {q['query_id']: q for q in read(p3 / 'query-registry.json')['queries']}
    p3_answers = {r['query_id']: r for r in rows(p3 / 'answers.jsonl')}
    inherited = read(p3 / 'evidence-checks.json')
    if inherited != read(a.candidates / 'inherited-evidence-checks.json'):
        raise ValueError('Inherited receipts altered')
    inherited_results = defaultdict(list)
    for path, entry in inherited.items():
        if sha(a.candidates / path) != entry['sha256'] or sha(p3 / path) != entry['sha256']:
            raise ValueError('Inherited evidence changed')
        for result in entry['query_results']:
            inherited_results[result['query_id']].append({**result, 'evidence': path, 'evidence_kind': entry['kind']})
    groups = defaultdict(list)
    for q in queries:
        groups[q['case_id'], q['profile']].append(q)
    new_checks = read(a.candidates / 'evidence-checks.json')
    grouped_checks = defaultdict(list)
    for path, record in new_checks.items():
        grouped_checks[record['case_id'], record['profile']].append((path, record))
    if set(grouped_checks) - set(groups):
        raise ValueError('Orphan evidence group')
    inputs = read(p1 / 'case-inputs.json')
    spec = digest(read(BASE / 'reference/specs/property-spec.json'))
    started = time.monotonic()
    answers, receipts, features = [], {}, []
    for number, ((cid, profile), group) in enumerate(groups.items(), 1):
        model = ReferenceModel(load(a.workspace, cid, profile))
        if any(inputs[cid]['input_hashes'].get(k) != v for k, v in model.d.input_hashes.items()):
            raise ValueError('Input drift: ' + cid)
        for q in group:
            if q != make_query(sources[q['source_query_id']], model, spec):
                raise ValueError('Changed query scope')
            if q['query_id'] in p3_queries and q != p3_queries[q['query_id']]:
                raise ValueError('Original query changed')
        evaluated = {q['query_id']: list(inherited_results.get(q['query_id'], [])) for q in group}
        for path, record in grouped_checks[cid, profile]:
            if sha(a.candidates / path) != record['sha256']:
                raise ValueError('Evidence digest mismatch')
            results, receipt = resolve_many(model, group, read(a.candidates / path))
            checked = [{**r, 'query_id': q['query_id']} for q, r in zip(group, results)]
            if receipt != record['receipt'] or checked != record['query_results']:
                raise ValueError('Receipt did not reproduce: ' + path)
            receipts[path] = {**record, 'receipt': receipt, 'query_results': checked}
            for q, result in zip(group, results):
                evaluated[q['query_id']].append({**result, 'evidence': path, 'evidence_kind': record['kind']})
        for q in group:
            selected = decide(q, evaluated[q['query_id']])
            old = p3_answers.get(q['query_id'])
            if old and old['truth_status'] == 'CERTIFIED' and selected['verdict'] != old['verdict']:
                raise ValueError('P3 certified verdict changed')
            row = {k: q[k] for k in ('query_id', 'source_query_id', 'case_id', 'profile', 'property_id', 'bound_ticks',
                   'model_digest', 'input_digest', 'property_version', 'tail_policy', 'response_window_ticks',
                   'covered_trigger_cutoff', 'checked_until')}
            row.update(reference_semantics=q['timing_scope'], sut_comparison_eligible=False,
                       query_set='original' if q['query_id'] in p3_queries else 'extended_response', **selected)
            row['nonvacuous_reference_answer'] = row['truth_status'] == 'CERTIFIED' and row.get('vacuous') is False
            answers.append(row)
        features.append({'case_id': cid, 'profile': profile,
            'node_kinds': dict(Counter(n[0] for n in model.d.nodes.values())),
            'external_event_count': len(model.d.profile['events']), 'max_faults': model.d.profile['max_faults'],
            'feedback_delay': model.d.profile['feedback'], 'max_age': model.d.profile['max_age'],
            'new_evidence_kinds': dict(Counter(r['kind'] for _, r in grouped_checks[cid, profile]))})
        if number % 120 == 0:
            print(json.dumps({'rechecked_groups': number, 'total': len(groups), 'seconds': round(time.monotonic() - started, 1)}), flush=True)
    # Check physical input bytes again, including early groups and dependency locks.
    cache = {}
    for cid, info in inputs.items():
        folder = a.workspace / 'datasets/ac-path-v1/cases' / cid
        descriptor = read(folder / 'case.json')
        for name, expected in info['input_hashes'].items():
            path = (folder / descriptor['inputs'][name] if name in descriptor['inputs'] else
                    folder / 'case.json' if name == 'case_descriptor' else
                    folder / descriptor['dependency_lock'] if name == 'dependency_lock' else
                    a.workspace / 'datasets/ac-path-v1' / name).resolve()
            if path not in cache:
                cache[path] = sha(path)
            if cache[path] != expected:
                raise ValueError('Final input drift: ' + str(path))
    proposed_answers = {r['query_id']: r for r in rows(a.candidates / 'answers.jsonl')}
    for r in answers:
        if any(r.get(k) != proposed_answers[r['query_id']].get(k) for k in ('truth_status', 'verdict', 'vacuous', 'trigger_reachability')):
            raise ValueError('Independent aggregation differs')
    for relative, expected in manifest['source_hashes'].items():
        if sha(BASE / relative) != expected:
            raise ValueError('Kernel/checker changed during admission: ' + relative)
    if sha(BASE / 'tools/build_reference_truth_p4.py') != plan['builder_sha256']:
        raise ValueError('Builder changed during admission')
    by_id = {r['query_id']: r for r in answers}
    view = read(a.candidates / 'benchmark-view.json')
    by_source = {q['source_query_id']: q['query_id'] for q in queries}
    ext_by_origin = {q['origin_query_id']: q for q in extensions}
    expected_view, replacements = [], []
    for q in originals:
        old_id = by_source[q['query_id']]
        if q['property_id'] == 'V10b' and q.get('covered_trigger_cutoff', 0) < 1:
            new_id = by_source[ext_by_origin[q['query_id']]['query_id']]
            expected_view.append(new_id)
            replacements.append((old_id, new_id))
        else:
            expected_view.append(old_id)
    if view['query_ids'] != expected_view or [(r['original_query_id'], r['extended_query_id']) for r in view['replacements']] != replacements:
        raise ValueError('Benchmark view changed query selection')
    if view['counts'] != dict(Counter(by_id[q]['truth_status'] for q in expected_view)):
        raise ValueError('View counts differ')
    a.output.mkdir(parents=True)
    for path in list(inherited) + list(receipts):
        target = a.output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(a.candidates / path, target)
    for name in ('query-registry.json', 'construction-plan.json', 'benchmark-view.json', 'attempts.json'):
        write(a.output / name, read(a.candidates / name))
    if supplement:
        write(a.output / 'residual-graph-attempts.json', read(a.candidates / 'residual-graph-attempts.json'))
    write(a.output / 'source-scope-notes.json', read(p3 / 'source-scope-notes.json'))
    write(a.output / 'inherited-evidence-checks.json', inherited)
    write(a.output / 'evidence-checks.json', receipts)
    write(a.output / 'conflicts.json', [])
    with (a.output / 'answers.jsonl').open('w', encoding='utf8') as stream:
        for row in answers:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
    dimensions = {}
    for field in ('property_id', 'profile', 'query_set'):
        dimensions[field] = {v: dict(Counter(r['truth_status'] for r in answers if r[field] == v)) for v in sorted({r[field] for r in answers})}
    dimensions['scene'] = {s: dict(Counter(r['truth_status'] for r in answers if r['case_id'].split('-')[0] == s)) for s in sorted({r['case_id'].split('-')[0] for r in answers})}
    summary = dict(stage='P4', queries=len(queries), cases=len({q['case_id'] for q in queries}), model_groups=len(groups),
        counts=dict(Counter(r['truth_status'] for r in answers)), by_dimension=dimensions,
        verdicts=dict(Counter(r['verdict'] for r in answers if r['truth_status'] == 'CERTIFIED')),
        vacuity=dict(Counter(str(r['vacuous']) for r in answers if r['truth_status'] == 'CERTIFIED')),
        trigger_reachability=dict(Counter(r['trigger_reachability'] for r in answers if r['truth_status'] == 'CERTIFIED')),
        evidence_kinds=dict(Counter(r['kind'] for r in receipts.values())),
        new_evidence_rechecked=len(receipts), inherited_sealed_evidence=len(inherited), conflicts=0,
        independent_aggregation_differences=0, elapsed_recheck_seconds=time.monotonic() - started,
        original_scope_complete=all(r['truth_status'] in ('CERTIFIED', 'NOT_APPLICABLE') for r in answers if r['query_set'] == 'original'),
        proposed_window_explicit_view=view['counts'], proposed_view_query_count=len(expected_view), replaced_windows=len(replacements),
        sut_alignment_complete=False, reviewer_type='AI_technical_review',
        proof_boundary='Reviewed proof schemas and checked instance premises under the pinned reference kernel; not a machine-checked proof of Python semantics or arbitrary PLC programs.')
    write(a.output / 'summary.json', summary)
    write(a.output / 'coverage.json', {'dimensions': dimensions, 'original_scope_complete': summary['original_scope_complete'],
        'vacuity_by_property': {pid: dict(Counter(str(r['vacuous']) for r in answers if r['property_id']==pid and r['truth_status']=='CERTIFIED'))
                               for pid in sorted({r['property_id'] for r in answers})}})
    write(a.output / 'construction-features.json', {'groups': features, 'diagnostic_tests_counted_as_dataset_cases': False})
    write(a.output / 'phase-run-manifest.json', {'scope': 'Overlapping feature groups, never sum their sizes as a dataset denominator.',
        'phases': {
            'A_sequential_pilot': [{'case_id': f['case_id'], 'profile': f['profile']} for f in features if f['case_id'].startswith('S04-P01')],
            'B_parallel': [{'case_id': f['case_id'], 'profile': f['profile']} for f in features if f['node_kinds'].get('par')],
            'C_fault_or_external': [{'case_id': f['case_id'], 'profile': f['profile']} for f in features if f['max_faults'] or f['external_event_count']],
            'D_twelve_scenes': [{'case_id': f['case_id'], 'profile': f['profile']} for f in features],
            'E_large_bounds': [q['query_id'] for q in queries if q['bound_ticks']>=10000]},
        'diagnostics': 'tests/certification_p4/test_extensions.py; small-model checks are separate from formal case counts.'})
    remaining = [{'query_id': r['query_id'], 'case_id': r['case_id'], 'profile': r['profile'], 'property_id': r['property_id'],
                  'reason': r.get('unresolved_reason'), 'next_step': 'Use explicitly versioned full-window query; retain original unresolved label.'
                  if r.get('unresolved_reason')=='NO_FULL_RESPONSE_WINDOW' else 'Construct an additional checked proof or counterexample without changing the query.'}
                 for r in answers if r['truth_status'] == 'UNRESOLVED']
    nonvacuity = [{'query_id': r['query_id'], 'case_id': r['case_id'], 'profile': r['profile'], 'property_id': r['property_id'],
                  'verdict': r['verdict'], 'reason': 'Property proved; trigger reachability not decided.',
                  'next_step': 'Construct a trigger witness or an unreachability proof before claiming exercised coverage.'}
                 for r in answers if r['truth_status']=='CERTIFIED' and r['vacuous'] is None]
    write(a.output / 'remaining-obligations.json', {'queries': remaining, 'nonvacuity_queries': nonvacuity, 'cross_cutting': [
        'SUT/reference semantic alignment and common query mapping before accuracy evaluation.',
        'Explicit temporal formulas required for additional task metadata obligations.',
        'Construction invariant results are not a substitute for malformed-controller detection experiments.',
        'Reviewed proof schemas still rely on trusted kernel and checker implementation.']})
    provenance = a.output / 'provenance'
    provenance.mkdir()
    for name in ('build_reference_truth_p4.py', 'audit_reference_truth_p4.py'):
        shutil.copyfile(BASE / 'tools' / name, provenance / name)
    if supplement:
        shutil.copyfile(BASE / supplement['tool'], provenance / 'complete_reference_truth_p4.py')
        shutil.copyfile(a.candidates / 'provenance/supplement-input-manifest.json', provenance / 'supplement-input-manifest.json')
    write(a.output / 'manifest.json', dict(schema='whole-line-reference-p4/0.1',
        admission='Every new artifact rechecked; immutable P3 receipts reused after package/kernel hash verification; independent aggregation.',
        source_hashes=manifest['source_hashes'], auditor_sha256=sha(__file__),
        construction_manifest_sha256=sha(a.candidates / 'manifest.json'), P3_manifest_sha256=sha(p3 / 'manifest.json'),
        files={p.relative_to(a.output).as_posix(): sha(p) for p in a.output.rglob('*') if p.is_file() and p.name != 'manifest.json'},
        reviewer_type='AI_technical_review', SUT_alignment_required=True))
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--candidates', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    main(parser.parse_args())
