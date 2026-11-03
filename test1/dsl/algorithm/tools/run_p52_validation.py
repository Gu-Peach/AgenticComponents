"""Validate the new engine without changing legacy code or reference answers."""
import argparse
import ast
from collections import Counter
from pathlib import Path
import sys
import time
BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from alignment_p52.models import setup,pair,fixture
from alignment_p52.input_bridge import compare_inputs
from alignment_p52.relation import canonical,diff,walk
from alignment_p52.fixtures import definitions,compare_queries
from alignment_p52.closed import compare
from alignment_p52.probes import run as repaired_probes
from alignment_p52.mutations import run as mutations


def implementation_hashes():
    from alignment_p5.io import sha
    return {p.relative_to(BASE).as_posix():sha(p) for folder in ('src/acverify_v3','alignment_p52','tools')
            for p in (BASE/folder).rglob('*') if p.suffix in ('.py','.json')}


def dependency_boundary():
    forbidden={'reference','certification','certification_p4','alignment_p5','alignment_p52','acverify'}
    violations=[]
    for path in (BASE/'src/acverify_v3').glob('*.py'):
        for n in ast.walk(ast.parse(path.read_text(encoding='utf8'))):
            names=[a.name for a in n.names] if isinstance(n,ast.Import) else [n.module] if isinstance(n,ast.ImportFrom) and n.level==0 and n.module else []
            for name in names:
                if name.split('.')[0] in forbidden:violations.append(dict(file=path.name,module=name))
    return dict(status='PASS' if not violations else 'FAIL',violations=violations,
                scope='Static imports; raw case parsing still uses the frozen legacy syntax/binding helpers, not legacy transitions or oracle verdicts.')


def main(a):
    a.workspace=setup(a.workspace);a.output=a.output.resolve()
    from alignment_p5.io import read,write,sha,digest,verify_files,sources
    from acverify_v3.query import validate
    from acverify_v3.pipeline import verify
    if a.output.exists():raise ValueError('Use a fresh P5.2 validation directory')
    oracle=a.workspace/'datasets/ac-path-v1/oracle/whole-line-p4-v1'
    prior=a.workspace/'artifacts/reference-p5/alignment-v2'
    verify_files(oracle,read(oracle/'manifest.json')['files']);verify_files(prior,read(prior/'manifest.json')['files'])
    verify_files(a.workspace,read(oracle/'manifest.json')['source_hashes'])
    scope=read(prior/'evaluation-scope.json');queries=scope['records'];groups={}
    for q in queries:groups.setdefault((q['case_id'],q['profile']),[]).append(q)
    frozen=implementation_hashes();legacy=sources(a.workspace);a.output.mkdir(parents=True)
    started=time.monotonic()
    write(a.output/'plan.json',dict(stage='P5.2',queries=len(queries),groups=len(groups),query_records_digest=scope['records_digest'],
        p4_manifest_sha256=sha(oracle/'manifest.json'),p51_manifest_sha256=sha(prior/'manifest.json'),
        source_hashes=frozen,legacy_source_hashes=legacy,
        corpus_trace_selection='Every base parent case in the frozen view, nominal lower/upper singleton timing, no optional faults, bound 512.',
        diagnostics='20 separately declared finite fixtures; bound 256, 20s per relation check and reference/solver query check.',
        tests_do_not_score_original_queries=True))
    bindings=[];parents=set();capabilities=set();node_kinds=set()
    for number,((cid,profile),qs) in enumerate(sorted(groups.items()),1):
        sut,ref=pair(a.workspace,cid,profile)
        if any(q['model_digest']!=ref.model_digest or q['input_digest']!=ref.d.input_digest for q in qs):raise ValueError('Frozen reference binding differs')
        validate(sut,qs);checks=compare_inputs(sut,ref);initial=diff(canonical(sut.initial),canonical(ref.initial,True))
        bindings.append(dict(case_id=cid,profile=profile,status='MATCH' if all(checks.values()) and not initial else 'DIFFERENT',
            checks=checks,initial_differences=initial,sut_model_digest=sut.model_digest,reference_model_digest=ref.model_digest))
        capabilities.update(a['model_ref'] for a in sut.actions.values());node_kinds.update(n['kind'] for n in sut.nodes.values())
        if '-DV' not in cid and '-DS' not in cid:parents.add(cid)
        if number%180==0:print({'bindings':number,'total':len(groups)},flush=True)
    write(a.output/'binding-audit.json',dict(records=bindings,capabilities=sorted(capabilities),node_kinds=sorted(node_kinds)))
    traces=[]
    for i,cid in enumerate(sorted(parents),1):
        for upper in (False,True):
            sut,ref=fixture(a.workspace,case=cid,upper=upper);result=walk(sut,ref,512)
            row={k:v for k,v in result.items() if k!='trace'}
            row.update(case_id=cid,timing='upper' if upper else 'lower',trace_digest=digest(result['trace']),
                       sut_model_digest=sut.model_digest,reference_model_digest=ref.model_digest)
            if result['status']=='DIVERGED':
                path=f'evidence/corpus/{cid}-{upper}.json.gz';write(a.output/path,result);row['evidence']=path
            traces.append(row)
        if i%12==0:print({'parent_traces':i,'total':len(parents)},flush=True)
    write(a.output/'corpus-traces.json',dict(records=traces,scope='Singleton schedules; PREFIX_ONLY remains incomplete. Not a universal corpus proof.'))
    small=[]
    for plan,sut,ref in definitions(a.workspace):
        relation=compare(sut,ref,bound=256,seconds=20);answers=compare_queries(sut,ref,seconds=20)
        row=dict(definition=plan,relation=relation,query_check=answers,
            sut_model_digest=sut.model_digest,reference_model_digest=ref.model_digest,
            environment=sut.profile,policies=sut.data['environment']['policies'],response_window=sut.data['queries']['response_window_ticks'])
        write(a.output/('evidence/finite/'+plan['id']+'.json.gz'),row);small.append(row)
        print({'fixture':plan['id'],'relation':relation['status'],'queries':answers['status']},flush=True)
    write(a.output/'finite-model-checks.json',dict(records=small,not_original_dataset_queries=True))
    probes=repaired_probes(a.workspace);probe_index=[]
    for row in probes:
        path='evidence/repaired/'+row['id']+'.json.gz';write(a.output/path,row)
        probe_index.append(dict(id=row['id'],status=row['status'],scope=row['scope'],evidence=path))
    write(a.output/'p51-probe-replay.json',dict(records=probe_index))
    negative=mutations(a.workspace);write(a.output/'mutation-checks.json',negative)
    rows=[q for q in queries if q['case_id']=='S10-P03-DV04' and q['profile']=='nominal']
    strategy=[]
    for mode in ('none','storage','portfolio'):
        report,ws=verify(a.workspace/'datasets/ac-path-v1/cases/S10-P03-DV04/case.json',a.workspace,rows,seconds=2,optimization=mode)
        write(a.output/f'evidence/strategies/{mode}.json.gz',dict(report=report,witnesses=ws))
        strategy.append(dict(mode=mode,answers=[(r['query_id'],r['verdict'],r['vacuous']) for r in report['results']],replays=report['replays']))
    strategies_match=all(r['answers']==strategy[0]['answers'] for r in strategy)
    write(a.output/'strategy-sanity.json',dict(records=strategy,match=strategies_match,not_a_performance_benchmark=True))
    if implementation_hashes()!=frozen or sources(a.workspace)!=legacy:raise ValueError('Sources changed during validation')
    boundary=dependency_boundary();write(a.output/'dependency-boundary.json',boundary)
    checks=dict(input_mapping=all(r['status']=='MATCH' for r in bindings),corpus_traces=all(r['status']!='DIVERGED' for r in traces),
        diagnosed_repairs=all(r['status']=='MATCH' for r in probes),finite_relation=all(r['relation']['status']=='CLOSED_MATCH' for r in small),
        diagnostic_query_mapping=all(r['query_check']['status']=='MATCH' for r in small),mutation_detection=all(r['detected'] for r in negative),
        common_strategy_semantics=strategies_match,dependency_boundary=boundary['status']=='PASS')
    gate=dict(stage='P5.2',checks=checks,implementation_validated=all(checks.values()),
        status='P52_IMPLEMENTATION_VALIDATED_P53_REVIEW_PENDING' if all(checks.values()) else 'P52_NOT_ADMITTED',
        eligible_for_full_corpus_accuracy=False,
        finite_verified_scope=[r['definition']['id'] for r in small if r['relation']['status']=='CLOSED_MATCH'],
        remaining=['P5.3: review the conditional state/event correspondence and its domain against the frozen implementations.',
                   'P5.3: carry forward and stratify trigger/vacuity obligations; retain original insufficient-window records.',
                   'P5.4: freeze worker budgets, source versions, repeat plan and independent scoring admission.'],
        does_not_claim=['Unbounded equivalence from finite tests','Machine-checked Python refinement proof','PLC tool comparison'])
    write(a.output/'gate.json',gate)
    summary=dict(stage='P5.2',models=len(bindings),query_bindings=sum(len(q) for q in groups.values()),
        input_statuses=dict(Counter(r['status'] for r in bindings)),parent_cases=len(parents),
        trace_statuses=dict(Counter(r['status'] for r in traces)),probe_statuses=dict(Counter(r['status'] for r in probes)),
        finite_statuses=dict(Counter(r['relation']['status'] for r in small)),
        finite_query_statuses=dict(Counter(r['query_check']['status'] for r in small)),
        diagnostic_queries=sum(r['query_check'].get('queries',0) for r in small),
        finite_pairs=sum(r['relation'].get('pairs',0) for r in small),mutation_tests=len(negative),
        mutations_detected=sum(r['detected'] for r in negative),strategies_match=strategies_match,
        implementation_validated=gate['implementation_validated'],eligible_for_full_corpus_accuracy=False,
        elapsed_seconds=time.monotonic()-started,legacy_and_reference_unchanged=True)
    write(a.output/'summary.json',summary)
    write(a.output/'manifest.json',dict(schema='p52-validation/0.1',source_hashes=frozen,legacy_source_hashes=legacy,
        p4_manifest_sha256=sha(oracle/'manifest.json'),p51_manifest_sha256=sha(prior/'manifest.json'),
        files={p.relative_to(a.output).as_posix():sha(p) for p in a.output.rglob('*') if p.is_file()},reviewer_type='AI_technical_review'))
    print(summary,flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True);main(p.parse_args())
