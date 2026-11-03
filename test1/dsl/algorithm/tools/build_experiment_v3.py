"""Freeze newly computed evidence before any tested-algorithm experiment."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

BASE = Path(__file__).resolve().parents[1]
from build_standard_answers import Case, RefError, logical_proofs, queries, read, write, sha
from sequential_reference import SequentialReference, profile_for, certify
from success_projection_v3 import SuccessProjection, check_certificate, digest
from reference_handoff_v3 import suite
from reference_channel_v2 import fixtures, enumerate_channel


def build(workspace, output):
    root = workspace / 'datasets/ac-path-v1'
    spec = read(BASE / 'specs/method1-semantics-v2.json')
    ids = read(root / 'manifest.json')['cases']
    static = read(root / 'oracle/standard-answers-v1/static-answers.json')['records']
    write(output / 'static.json', {'expected_by_case': {x['case_id']:
          'VALID' if x['verdict'] == 'WELL_FORMED_FOR_REFERENCE_SUBSET' else x['verdict'] for x in static}})
    core = []; coverage = []; failed = []; evidence_index = {}; projections = {}; conflicts = []
    for cid in ids:
        if '-DS' in cid: continue
        case = Case(root, cid)
        labels = {}; evidence = {}
        logical = logical_proofs(case)
        projection = None
        try:
            projection = SuccessProjection(case).run()
            projection['checking'] = check_certificate(case, projection)
            projections[cid] = projection['conclusions']
        except (RefError, KeyError) as error:
            failed.append({'case_id': cid, 'stage': 'projection', 'reason': str(error)})
        for pid in ('V09', 'V10a'):
            if pid in logical:
                labels[pid] = logical[pid]['verdict']
                evidence[pid] = {'basis': 'recomputed_logical_certificate', 'certificate': logical[pid]}
            if projection and pid in projection['conclusions']:
                value = projection['conclusions'][pid]
                if pid in labels and labels[pid] != value: conflicts.append([cid, pid, labels[pid], value])
                labels[pid] = value
                evidence[pid] = {'basis': 'successful_poststate_overapproximation', 'certificate': projection}
        try:
            witness = SequentialReference(case, profile_for(case,
                'nominal' if case.descriptor['schema_type'] == 'PilotCase' else 'nominal@0.1')).run()
            checked = certify(case, witness)
            if witness['completion_tick'] <= 3000:
                pid, value = ('V10a', 'REACHABLE') if witness['independent_goal'] else ('V09', 'VIOLATED')
                if pid in labels and labels[pid] != value: conflicts.append([cid, pid, labels[pid], value])
                labels[pid] = value
                evidence[pid] = {'basis': 'independent_sequential_timed_witness', 'witness': witness, 'checking': checked}
        except (RefError, KeyError) as error:
            failed.append({'case_id': cid, 'stage': 'timed_witness', 'reason': str(error)})
        for pid, value in labels.items():
            if pid not in ('V09', 'V10a'): continue
            record = {'case_id': cid, 'profile': 'nominal', 'bound': 3000, 'property': pid,
                      'expected': value, 'input_hashes': case.hashes, 'semantics_hash': digest(spec),
                      **evidence[pid]}
            path = output / 'evidence' / cid / (pid + '.json')
            write(path, record)
            evidence_index[cid + '|' + pid] = {'path': path.relative_to(output).as_posix(), 'sha256': sha(path)}
            core.append({k: record[k] for k in ('case_id', 'profile', 'bound', 'property', 'expected', 'basis')})
        for env, bound, prop in queries(case):
            pid = prop['id']; applicable = prop.get('applicable', True)
            # Only the explicitly certified experiment slice is admitted here.
            admitted = env.split('@')[0] == 'nominal' and bound == 3000 and pid in labels
            coverage.append({'case_id': cid, 'profile': env.split('@')[0], 'bound': bound, 'property': pid,
                'status': 'NOT_APPLICABLE' if not applicable else 'CERTIFIED' if admitted else 'UNRESOLVED',
                'expected': labels[pid] if applicable and admitted else None,
                'missing_obligation': None if admitted or not applicable else
                    'whole_line_timed_concurrency_fault_reference_or_property_certificate'})
    if conflicts: raise ValueError('Independent evidence conflicts: ' + repr(conflicts))
    old = read(workspace / 'experiments/method1-v2/core.json')
    replaced = []
    for row in old['cases']:
        for q in row['properties']:
            if q['basis'] == 'unique_successful_sequential_goal_projection':
                ok = projections.get(row['case_id'], {}).get(q['property']) == q['expected']
                replaced.append({'case_id': row['case_id'], 'property': q['property'], 'proved': ok})
    write(output / 'core.json', {'id': 'method1-evidence-core/0.3', 'semantics_hash': digest(spec),
        'queries': core, 'query_count': len(core), 'case_count': len({q['case_id'] for q in core}),
        'boundary': 'Reference evidence under declared symbolic semantics; not real-equipment or full timed refinement proof'})
    write(output / 'evidence-index.json', evidence_index)
    write(output / 'coverage.json', {'records': coverage, 'counts': dict(Counter(x['status'] for x in coverage)),
          'construction_failures': failed, 'whole_line_truth_complete': False})
    write(output / 'projection-replacements.json', {'records': replaced, 'all_47_reproved': len(replaced) == 47 and all(x['proved'] for x in replaced)})
    write(output / 'handoff-kernel.json', suite())
    write(output / 'protocol-core.json', {'fixtures': [{'input': c, 'expected': enumerate_channel(c)} for c in fixtures()]})
    files = {p.relative_to(output).as_posix(): sha(p) for p in output.rglob('*.json') if p.name != 'freeze.json'}
    write(output / 'freeze.json', {'schema': 'method1-freeze/0.3', 'semantics_hash': digest(spec),
          'files': files, 'input_locks': {cid: sha(root / 'cases' / cid / 'dependencies.lock.json') for cid in ids},
          'reference_sources': {p.name: sha(p) for p in [Path(__file__),
             BASE/'tools/success_projection_v3.py', BASE/'tools/reference_handoff_v3.py',
             BASE/'tools/build_standard_answers.py', BASE/'tools/sequential_reference.py', BASE/'tools/reference_channel_v2.py']},
          'reviewer_type': 'AI_technical_review', 'external_human_review_claimed': False})
    print(json.dumps({'queries': len(core), 'cases': len({q['case_id'] for q in core}),
          'reproved': sum(x['proved'] for x in replaced), 'coverage': dict(Counter(x['status'] for x in coverage))}))


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--workspace', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args(); build(a.workspace, a.output)
