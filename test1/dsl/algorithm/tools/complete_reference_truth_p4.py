"""Try complete reference graphs for residual queries, preserving prior evidence."""
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
from certification.construct import graph
from certification.io import read, write, sha
from certification.policy import check_workspace
from certification_p4.binding import resolve_many
from build_reference_truth_p4 import merge


def main(a):
    check_workspace(a.workspace)
    if a.output.exists():
        raise ValueError('Supplement output must be a new directory')
    manifest = read(a.candidates / 'manifest.json')
    for name, expected in manifest['files'].items():
        path = (a.candidates / name).resolve()
        if not path.is_relative_to(a.candidates.resolve()) or sha(path) != expected:
            raise ValueError('Candidate drift')
    for name, expected in manifest['source_hashes'].items():
        if sha(BASE / name) != expected:
            raise ValueError('Kernel/checker changed')
    queries = read(a.candidates / 'query-registry.json')['queries']
    prior = [json.loads(line) for line in (a.candidates / 'answers.jsonl').read_text(encoding='utf8').splitlines()]
    wanted = {(r['case_id'], r['profile']) for r in prior if r['truth_status'] == 'UNRESOLVED'
              and r.get('unresolved_reason') != 'NO_FULL_RESPONSE_WINDOW'}
    groups = defaultdict(list)
    for q in queries:
        groups[q['case_id'], q['profile']].append(q)
    shutil.copytree(a.candidates, a.output)
    checks = read(a.candidates / 'evidence-checks.json')
    inherited = read(a.candidates / 'inherited-evidence-checks.json')
    attempts = []
    started = time.monotonic()
    for cid, profile in sorted(wanted):
        model = ReferenceModel(load(a.workspace, cid, profile))
        qs = groups[cid, profile]
        payload, statistics = graph(model, bound=max(q['checked_until'] for q in qs), seconds=a.seconds)
        attempts.append(dict(case_id=cid, profile=profile, enumeration=statistics))
        if payload is None:
            continue
        results, receipt = resolve_many(model, qs, payload)
        path = f'evidence-p4/{cid}/{profile}-residual-graph.json.gz'
        if (a.output / path).exists():
            raise ValueError('Residual evidence already exists')
        checks[path] = dict(sha256=write(a.output / path, payload), kind=payload['kind'], case_id=cid, profile=profile,
                            model_digest=model.model_digest, receipt=receipt,
                            query_results=[{**r, 'query_id': q['query_id']} for q, r in zip(qs, results)])
        print(json.dumps({'case_id': cid, 'profile': profile, 'closed': receipt.get('closed'),
                          'states': statistics['states'], 'edges': statistics['edges']}), flush=True)
    evaluated = defaultdict(list)
    for path, entry in {**inherited, **checks}.items():
        for r in entry['query_results']:
            evaluated[r['query_id']].append({**r, 'evidence': path, 'evidence_kind': entry['kind']})
    by_query = {q['query_id']: q for q in queries}
    answers = []
    for old in prior:
        q = by_query[old['query_id']]
        chosen = merge(q, evaluated[q['query_id']])
        if old['truth_status'] == 'CERTIFIED' and chosen['verdict'] != old['verdict']:
            raise ValueError('Supplement conflicts with prior evidence')
        row = {k: old[k] for k in ('query_id', 'source_query_id', 'case_id', 'profile', 'property_id', 'bound_ticks',
            'model_digest', 'input_digest', 'property_version', 'tail_policy', 'response_window_ticks',
            'covered_trigger_cutoff', 'checked_until', 'reference_semantics', 'sut_comparison_eligible', 'query_set')}
        row.update(chosen)
        row['nonvacuous_reference_answer'] = row['truth_status'] == 'CERTIFIED' and row['vacuous'] is False
        answers.append(row)
    with (a.output / 'answers.jsonl').open('w', encoding='utf8') as stream:
        for row in answers:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
    write(a.output / 'evidence-checks.json', checks)
    write(a.output / 'residual-graph-attempts.json', attempts)
    plan = read(a.candidates / 'construction-plan.json')
    plan['supplement'] = dict(tool='tools/complete_reference_truth_p4.py', sha256=sha(__file__),
        input_manifest_sha256=sha(a.candidates / 'manifest.json'), seconds_per_graph=a.seconds,
        selection='Every residual query except explicitly inadequate response windows; no SUT output used.',
        groups_attempted=len(wanted), elapsed_seconds=time.monotonic() - started)
    write(a.output / 'construction-plan.json', plan)
    write(a.output / 'provenance/supplement-input-manifest.json', manifest)
    view = read(a.candidates / 'benchmark-view.json')
    by_id = {r['query_id']: r for r in answers}
    view['counts'] = dict(Counter(by_id[q]['truth_status'] for q in view['query_ids']))
    write(a.output / 'benchmark-view.json', view)
    summary = read(a.candidates / 'summary.json')
    summary.update(counts=dict(Counter(r['truth_status'] for r in answers)),
        by_query_set={s: dict(Counter(r['truth_status'] for r in answers if r['query_set'] == s)) for s in ('original', 'extended_response')},
        verdicts=dict(Counter(r['verdict'] for r in answers if r['truth_status'] == 'CERTIFIED')),
        vacuity=dict(Counter(str(r['vacuous']) for r in answers if r['truth_status'] == 'CERTIFIED')),
        new_evidence_files=len(checks), extension_view_complete=not view['counts'].get('UNRESOLVED'),
        supplement=plan['supplement'])
    write(a.output / 'summary.json', summary)
    write(a.output / 'manifest.json', {**manifest,
        'files': {p.relative_to(a.output).as_posix(): sha(p) for p in a.output.rglob('*') if p.is_file() and p.name != 'manifest.json'},
        'supplement_sha256': sha(__file__)})
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--candidates', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=float, default=10)
    main(parser.parse_args())
