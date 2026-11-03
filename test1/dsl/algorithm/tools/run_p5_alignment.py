"""P5.1: freeze the common scope and audit semantics before running scored jobs."""
import argparse
from collections import Counter
from pathlib import Path
import sys
import time

BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from alignment_p5.io import read,write,sha,digest,sources,verify_files
from alignment_p5.models import pair,singleton,action_definitions,profile_definitions,node_shapes
from alignment_p5.projection import public_state,differences,paired_trace,replay_pair
from alignment_p5.diagnostics import hold_trace,pending_stop_trace,component_probes
from alignment_p5.scope import freeze_scope
from alignment_p5.gate import admit


def main(a):
    if a.output.exists():raise ValueError('Use a fresh P5.1 output directory')
    oracle=a.workspace/'datasets/ac-path-v1/oracle/whole-line-p4-v1'
    manifest=read(oracle/'manifest.json')
    verify_files(oracle,manifest['files']);verify_files(a.workspace,manifest['source_hashes'])
    frozen=sources(a.workspace)
    scope=freeze_scope(oracle)
    a.output.mkdir(parents=True)
    write(a.output/'evaluation-scope.json',scope)
    groups={}
    for q in scope['records']:groups.setdefault((q['case_id'],q['profile']),[]).append(q)
    plan=dict(id='method1-p5-alignment/0.1',scope_digest=scope['records_digest'],source_hashes=frozen,
        reference_manifest_sha256=sha(oracle/'manifest.json'),groups=len(groups),
        representative_selection='Lexicographically first case per scene, nominal profile, lower and upper singleton timings.',
        diagnostic_tick_bound=512,accuracy_jobs_authorized=False,
        audit_sources={p.relative_to(BASE).as_posix():sha(p) for folder in ('alignment_p5','tools') for p in (BASE/folder).glob('*.py')})
    write(a.output/'plan.json',plan)
    checks=[];begun=time.monotonic()
    for i,((cid,profile),qs) in enumerate(sorted(groups.items()),1):
        sut,ref=pair(a.workspace,cid,profile)
        if any(q['model_digest']!=ref.model_digest or q['input_digest']!=ref.d.input_digest for q in qs):
            raise ValueError('P4 model binding changed: '+cid+'/'+profile)
        comparisons={'actions':action_definitions(sut,ref),'profile_parameters':profile_definitions(sut,ref),
            'node_structure':node_shapes(sut,ref),'devices':(sut.devices,ref.d.devices),'locations':(sut.locations,ref.d.locations),
            'task':(sut.data['task'],ref.d.task),'controls':(sut.controls,ref.d.controls),
            'initial_public_state':(public_state(sut.initial),public_state(ref.initial,True))}
        detail={k:dict(sut_digest=digest(x),reference_digest=digest(y),equal=x==y,
                       differences=differences(x,y)) for k,(x,y) in comparisons.items()}
        checks.append(dict(case_id=cid,profile=profile,sut_model_digest=sut.model_digest,reference_model_digest=ref.model_digest,
                           status='INPUT_PROJECTION_MATCH' if all(d['equal'] for d in detail.values()) else 'INPUT_DIFFERENCE',components=detail))
        if i%120==0:print({'rebound_groups':i,'total':len(groups),'seconds':round(time.monotonic()-begun,1)},flush=True)
    write(a.output/'binding-audit.json',dict(groups=checks,scope='Input projection only; condition evaluation and transition semantics need independent checks.'))
    representatives={}
    for cid,_ in sorted(groups):representatives.setdefault(cid.split('-')[0],cid)
    trace_rows=[];evidence={}
    for scene,cid in sorted(representatives.items()):
        for upper in (False,True):
            sut,ref=singleton(a.workspace,cid,upper=upper)
            payload=paired_trace(sut,ref,512);receipt=replay_pair(sut,ref,payload)
            path=f'evidence/corpus-projection/{cid}-'+('upper' if upper else 'lower')+'.json.gz'
            evidence[path]=dict(sha256=write(a.output/path,payload),kind='paired_trace',receipt=receipt)
            trace_rows.append(dict(scene=scene,case_id=cid,profile='nominal',timing='upper' if upper else 'lower',
                scope='Declared-interval singleton restriction; public-state trace comparison, not all-path equivalence.',
                status=payload['status'],first_difference_tick=payload.get('first_difference_tick'),last_tick=payload.get('last_tick'),
                differences=payload.get('differences',[]),evidence=path))
    write(a.output/'trace-audit.json',dict(records=trace_rows))
    probes=[hold_trace(a.workspace),*component_probes(a.workspace),pending_stop_trace(a.workspace)]
    probe_rows=[]
    for p in probes:
        path='evidence/diagnostics/'+p['id']+'.json.gz'
        evidence[path]=dict(sha256=write(a.output/path,p),kind='semantic_probe',scope=p['scope'])
        probe_rows.append({k:v for k,v in p.items() if k in ('id','scope','status','interpretation')})
        probe_rows[-1]['evidence']=path
    write(a.output/'diagnostics.json',dict(records=probe_rows,not_corpus_cases=True))
    # Recompute the component probes; serialized expectations are not trusted.
    replayed=[hold_trace(a.workspace),*component_probes(a.workspace),pending_stop_trace(a.workspace)]
    for p in replayed:
        if read(a.output/('evidence/diagnostics/'+p['id']+'.json.gz'))!=p:
            raise ValueError('Diagnostic evidence did not reproduce: '+p['id'])
    unchanged=sources(a.workspace)==frozen
    if not unchanged:raise ValueError('Code changed during P5.1')
    verify_files(BASE,plan['audit_sources'])
    failed=[r['id'] for r in probe_rows if r['status']=='DIFFERENT']
    bind_ok=all(r['status']=='INPUT_PROJECTION_MATCH' for r in checks)
    checks_gate={
        'oracle_integrity':dict(status='PASS',evidence='P4 manifest and all child hashes'),
        'input_binding':dict(status='PASS' if bind_ok else 'FAIL',evidence='binding-audit.json'),
        'transition_relation':dict(status='FAIL' if failed or any(r['status']=='DIVERGED' for r in trace_rows) else 'PENDING',
                                   evidence='diagnostics.json; trace-audit.json; no bisimulation/refinement proof yet'),
        'property_alignment':dict(status='FAIL' if any(x.startswith(('D04','D05','D06','D07','D09')) for x in failed) else 'PENDING',evidence='diagnostics.json'),
        'query_windows':dict(status='FAIL' if 'D08-response-tail-filter' in failed else 'PENDING',evidence='evaluation-scope.json; D08'),
        'regression_suite':dict(status='PENDING',evidence='An aligned implementation and cross-implementation regression suite are required.'),
        'source_freeze':dict(status='PASS',evidence='plan.json')}
    gate=dict(id='method1-p5-semantic-admission/0.1',checks=checks_gate,unresolved_issues=failed,
        source_hashes=frozen,reference_manifest_sha256=scope['reference_manifest_sha256'],query_records_digest=scope['records_digest'],
        **admit(checks_gate))
    write(a.output/'gate.json',gate)
    write(a.output/'evidence-index.json',evidence)
    summary=dict(phase='P5.1',query_count=len(scope['records']),model_groups=len(checks),
        binding_statuses=dict(Counter(r['status'] for r in checks)),
        binding_difference_components=dict(Counter(k for r in checks for k,v in r['components'].items() if not v['equal'])),
        trace_statuses=dict(Counter(r['status'] for r in trace_rows)),diagnostic_statuses=dict(Counter(r['status'] for r in probe_rows)),
        probe_reproductions=len(replayed),source_unchanged=unchanged,
        original_window_obligations=len(scope['original_window_obligations']),nonvacuity_obligations=len(scope['nonvacuity_obligations']),
        p5_complete=False,eligible_for_accuracy=gate['eligible_for_accuracy'],elapsed_seconds=time.monotonic()-begun)
    write(a.output/'summary.json',summary)
    write(a.output/'manifest.json',dict(id='method1-p5-alignment-package/0.1',
        files={p.relative_to(a.output).as_posix():sha(p) for p in a.output.rglob('*') if p.is_file()},
        runner_sha256=sha(__file__),source_hashes=frozen,reviewer_type='AI_technical_review',accuracy_run_performed=False))
    print(summary,flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    main(parser.parse_args())
