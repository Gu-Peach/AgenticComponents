"""Resumable frozen matrix, fresh serial workers, no oracle access in workers."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import random
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE/'src'))


def read(p): return json.loads(Path(p).read_text(encoding='utf-8-sig'))
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def canonical(v): return json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def write(p, v):
    p = Path(p); p.parent.mkdir(parents=True, exist_ok=True)
    temporary = p.with_suffix(p.suffix + '.tmp')
    temporary.write_text(json.dumps(v, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    temporary.replace(p)


def sources(): return {p.name: sha(p) for p in (BASE/'src/acverify').glob('*.py')}


def plan(workspace, definition, coverage_seconds, budgets):
    from build_standard_answers import Case
    root = workspace/'datasets/ac-path-v1'
    ids = [cid for cid in read(root/'manifest.json')['cases'] if '-DS' not in cid]
    selected = []
    for scene in sorted({cid.split('-')[0] for cid in ids}):
        parents = [cid for cid in ids if cid.startswith(scene+'-') and '-DV' not in cid]
        ranked = sorted(parents, key=lambda cid: (len(Case(root, cid).nodes), cid))
        parent = ranked[len(ranked)//2]
        selected.extend([parent, parent+'-DV04'])
    jobs = []
    def add(cid, profile, method, seconds, repeat, role):
        item = {'case_id': cid, 'profile': profile, 'method': method, 'seconds': seconds,
                'repeat': repeat, 'role': role, 'bound': 3000, 'states': 20000, 'memory_mb': 512}
        item['id'] = hashlib.sha256(canonical(item).encode()).hexdigest()[:20]
        jobs.append(item)
    for cid in ids:
        pilot = read(root/'cases'/cid/'case.json')['schema_type'] == 'PilotCase'
        for profile in ('nominal', 'delayed', 'stop_unknown_c1' if pilot else 'fault'):
            add(cid, profile, 'auto', coverage_seconds, 0, 'coverage')
    measured = []
    for cid in selected:
        for seconds in budgets:
            for repeat in range(3):
                for method in ('full', 'compact', 'auto'):
                    add(cid, 'nominal', method, seconds, repeat, 'ablation')
    # Randomization is fixed before reading results; coverage precedes timings.
    coverage_jobs = [j for j in jobs if j['role'] == 'coverage']
    measured = [j for j in jobs if j['role'] == 'ablation']
    random.Random(20261102).shuffle(measured)
    return {'schema': 'method1-run-plan/0.3', 'jobs': coverage_jobs + measured,
            'selected_cases': selected, 'selection_rule': 'median AST-node-count parent in each scene plus its DV04; no solver outcomes',
            'definition_freeze_sha256': sha(definition/'freeze.json'), 'algorithm_hashes': sources(),
            'runner_sha256': sha(__file__), 'budgets': budgets, 'repeats': 3, 'workers': 1,
            'coverage_seconds': coverage_seconds, 'python': sys.version, 'platform': platform.platform(),
            'clock': 'wall time; fresh serial subprocess; sampled process RSS',
            'watchdog_seconds': 'max(15, search budget + 15)'}


def worker(a):
    from acverify.pipeline import verify
    job = read(a.job)
    started = time.perf_counter()
    result, traces, _ = verify(a.workspace/'datasets/ac-path-v1/cases'/job['case_id']/'case.json', a.workspace,
        profile=job['profile'], bound=job['bound'], states=job['states'], seconds=job['seconds'],
        memory_mb=job['memory_mb'], reduction=job['method'], search='complete')
    # Preserve witnesses separately so result tables remain manageable.
    paths = {}
    for name, trace in traces.items():
        path = a.output.parent/'traces'/job['id']/(name+'.json')
        write(path, trace); paths[name] = {'path': str(path.relative_to(a.output.parent)), 'sha256': sha(path)}
    write(a.output, {'job': job, 'result': result, 'trace_files': paths,
                     'worker_seconds': time.perf_counter()-started})


def main(a):
    from acverify.pipeline import check
    a.output.mkdir(parents=True, exist_ok=True)
    current = plan(a.workspace, a.definition, a.coverage_seconds, a.budgets)
    manifest_path = a.output/'plan.json'
    if manifest_path.exists():
        if canonical(read(manifest_path)) != canonical(current):
            raise ValueError('Run plan/source/freeze differs; use a new output directory')
    else: write(manifest_path, current)
    static_path = a.output/'static-results.json'
    if not static_path.exists():
        rows = []
        for cid, expected in read(a.definition/'static.json')['expected_by_case'].items():
            r = check(a.workspace/'datasets/ac-path-v1/cases'/cid/'case.json', a.workspace)
            actual = 'VALID' if r['status'] == 'VALID_INPUT' else r.get('details', {}).get('frontend_code', r['status'])
            rows.append({'case_id': cid, 'expected': expected, 'actual': actual, 'match': actual == expected})
        write(static_path, {'records': rows, 'matches': sum(x['match'] for x in rows), 'total': len(rows)})
    begun = time.monotonic(); skipped = 0
    for index, job in enumerate(current['jobs'], 1):
        final = a.output/'jobs'/(job['id']+'.json')
        if final.exists():
            if read(final)['job'] != job: raise ValueError('Existing job differs')
            skipped += 1; continue
        spec = a.output/'job-specs'/(job['id']+'.json'); write(spec, job)
        temp_result = a.output/'worker-output'/(job['id']+'.json')
        cmd = [sys.executable, '-B', '-X', 'utf8', str(Path(__file__).resolve()), '--worker',
               '--workspace', str(a.workspace), '--job', str(spec), '--output', str(temp_result)]
        begin = time.monotonic()
        try:
            completed = subprocess.run(cmd, capture_output=True, timeout=max(15, job['seconds']+15))
            if completed.returncode == 0 and temp_result.exists():
                row = read(temp_result)
            else:
                row = {'job': job, 'result': {'status':'WORKER_ERROR', 'message': completed.stderr.decode('utf-8', errors='replace')[-2000:]}}
        except subprocess.TimeoutExpired:
            row = {'job': job, 'result': {'status':'WORKER_TIMEOUT'}}
        row['wall_seconds'] = time.monotonic()-begin
        row['plan_sha256'] = sha(manifest_path)
        write(final, row)
        if index % 30 == 0 or index == len(current['jobs']):
            print(json.dumps({'done': index, 'total': len(current['jobs']), 'elapsed_seconds': round(time.monotonic()-begun, 1)}), flush=True)
    unchanged = sources() == current['algorithm_hashes'] and sha(__file__) == current['runner_sha256']
    write(a.output/'completion.json', {'planned':len(current['jobs']), 'recorded':sum((a.output/'jobs'/(j['id']+'.json')).exists() for j in current['jobs']),
        'resumed_jobs':skipped, 'source_unchanged':unchanged, 'elapsed_this_invocation_seconds':time.monotonic()-begun,
        'truth_complete':False, 'note':'Terminal job records do not imply decided properties.'})


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--workspace', type=Path, required=True)
    p.add_argument('--definition', type=Path, default=BASE/'experiments/method1-v3')
    p.add_argument('--output', type=Path, required=True); p.add_argument('--worker', action='store_true')
    p.add_argument('--job', type=Path); p.add_argument('--coverage-seconds', type=float, default=0.5)
    p.add_argument('--budgets', type=float, nargs='+', default=[0.1, 0.5, 2.0])
    a = p.parse_args(); worker(a) if a.worker else main(a)
