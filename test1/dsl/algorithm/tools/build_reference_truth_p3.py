"""Construct and check reference-scoped answers; never import tested-verifier results."""
import argparse
from collections import Counter,defaultdict
import copy
import gc
import json
from pathlib import Path
import sys
import time

BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from reference.frontend import load
from reference.transition import ReferenceModel
from reference.common import digest
from certification import logic,success_effects,construct
from certification.binding import make_query,resolve_many
from certification.policy import check_workspace
from certification.io import read,write,sha


def code_hashes():
    return {p.relative_to(BASE).as_posix():sha(p) for folder in ('reference','certification') for p in (BASE/folder).rglob('*')
            if p.suffix in ('.py','.json','.md')}


def merge(existing,new):
    known=[c for c in existing if c['verdict'] is not None]
    if new['verdict'] is not None:
        if any(c['verdict']!=new['verdict'] for c in known):raise ValueError('Conflicting independently checked conclusions')
    existing.append(new)


def choose(candidates):
    proven=[x for x in candidates if x['verdict'] is not None]
    if not proven:return None
    def rank(x):
        return (x.get('trigger_reachability') in ('REACHABLE','UNREACHABLE'),x.get('vacuous') is not None,
                x['evidence_kind']=='graph_certificate/0.1')
    picked=max(proven,key=rank).copy()
    picked.pop('trigger_basis',None)
    triggered=any(x.get('trigger_reachability')=='REACHABLE' for x in candidates)
    if triggered:
        if any(x.get('trigger_reachability')=='UNREACHABLE' and x.get('vacuous') is True for x in proven):
            raise ValueError('Trigger reachability conflicts with vacuity proof')
        picked['trigger_reachability']='REACHABLE'
        if picked['verdict']=='HOLDS':picked['vacuous']=False
    picked['evidence_refs']=sorted({x['evidence'] for x in proven}|{x['evidence'] for x in candidates if x.get('trigger_reachability')=='REACHABLE'})
    picked['trigger_evidence_refs']=sorted({x['evidence'] for x in candidates if x.get('trigger_reachability')=='REACHABLE'})
    return picked


def main(a):
    check_workspace(a.workspace)
    if a.output.exists() and any(a.output.iterdir()):raise ValueError('Choose a new truth version/output directory')
    a.output.mkdir(parents=True)
    p1root=a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1'
    p1=read(p1root/'query-inventory.json')['queries'];case_inputs=read(p1root/'case-inputs.json')
    spec=read(BASE/'reference/specs/property-spec.json');spec_digest=digest(spec)
    groups=defaultdict(list)
    for q in p1:groups[(q['case_id'],q['profile'])].append(q)
    # Construction scheduling uses only the independent P2 reference samples.
    # It does not filter the registry or consult acverify outcomes/old gold labels.
    p2_walks=read(a.workspace/'artifacts/reference-p2/validation/corpus-greedy.json')
    witness_cases={r['case_id'] for r in p2_walks if r['outcome']=='succeeded'}
    p2_native=read(a.workspace/'artifacts/reference-p2/validation/native-results.json')
    graph_groups={(r['summary']['case_id'],r['summary']['profile']['name']) for r in p2_native if r['summary']['finite_model_closed']}
    frozen=code_hashes()
    write(a.output/'construction-plan.json',{'query_groups':len(groups),'source_queries':len(p1),
      'witness_case_ids':sorted(witness_cases),'graph_groups':[list(x) for x in sorted(graph_groups)],
      'extra_response_witnesses':[['S01-P01','delayed'],['S01-P01','fault']],
      'selection_basis':'independent P2 candidates; entire P1 query inventory retained',
      'candidate_source_hashes':{'p2_walks':sha(a.workspace/'artifacts/reference-p2/validation/corpus-greedy.json'),
        'p2_native':sha(a.workspace/'artifacts/reference-p2/validation/native-results.json')},
      'kernel_and_checker_sources':frozen,'builder_sha256':sha(__file__),
      'P1_manifest_sha256':sha(p1root/'manifest.json'), 'truth_scope':'reference-six-phase/0.1 only; SUT alignment pending'})
    registry=[];answers=[];evidence_index={};attempts=[];conflicts=[];projection_cache={};begun=time.monotonic()
    remaining_groups=Counter(cid for cid,_ in groups)
    for index,((cid,profile),source_queries) in enumerate(groups.items(),1):
        model=ReferenceModel(load(a.workspace,cid,profile))
        if any(case_inputs[cid]['input_hashes'].get(k)!=v for k,v in model.d.input_hashes.items()):raise ValueError('P1 inputs drifted: '+cid)
        folder=a.workspace/'datasets/ac-path-v1/cases'/cid
        if sha(folder/'case.json')!=case_inputs[cid]['input_hashes']['case_descriptor'] or sha(folder/'dependencies.lock.json')!=case_inputs[cid]['input_hashes']['dependency_lock']:
            raise ValueError('P1 descriptor/lock drifted: '+cid)
        queries=[make_query(s,model,spec_digest) for s in source_queries];registry.extend(queries)
        per_query={q['query_id']:[] for q in queries}
        def admit(payload,label):
            results,receipt=resolve_many(model,queries,payload)
            if not any(r['verdict'] is not None or r.get('trigger_reachability')=='REACHABLE' for r in results):return
            relative='evidence/'+cid+'/'+profile+'-'+label+'.json.gz';h=write(a.output/relative,payload)
            evidence_index[relative]={'sha256':h,'kind':payload['kind'],'case_id':cid,'profile':profile,
                 'model_digest':model.model_digest,'checker_receipt':receipt,
                 'query_ids':[q['query_id'] for q in queries]}
            for q,r in zip(queries,results):
                if q['applicability']=='NOT_APPLICABLE':continue
                record={**r,'evidence':relative,'evidence_kind':payload['kind']}
                try:merge(per_query[q['query_id']],record)
                except ValueError as e:conflicts.append({'query_id':q['query_id'],'reason':str(e),'existing':per_query[q['query_id']],'new':record})
        for payload in logic.candidates(model):admit(payload,'logic-'+payload['derivation']['rule'])
        # Reuse only candidate structure across profiles. Every profile rechecks
        # premises, primitives, derivation arms, input/model identity and goals.
        if cid not in projection_cache:
            try:projection_cache[cid]=success_effects.generate(model)
            except (ValueError,KeyError,TypeError) as e:projection_cache[cid]={'construction_refused':str(e)}
        cached=projection_cache[cid]
        if 'construction_refused' in cached:
            attempts.append({'case_id':cid,'profile':profile,'stage':'success_projection','status':'UNSUPPORTED','reason':cached['construction_refused']})
        else:
            payload=copy.deepcopy(cached);payload['model_digest']=model.model_digest;payload['premises']=success_effects.premises(model)
            admit(payload,'success-effects')
        if cid in witness_cases:
            payload=construct.walk(model,bound=max(q['bound_ticks'] for q in queries),seconds=30)
            admit(payload,'trace-minimum')
            attempts.append({'case_id':cid,'profile':profile,'stage':'trace','status':'CHECKED',**payload['construction']})
        if cid=='S01-P01' and profile in ('delayed','fault'):
            payload=construct.walk(model,bound=3000,policy='fresh_accept_stale_result',seconds=30)
            admit(payload,'trace-stale-result')
            attempts.append({'case_id':cid,'profile':profile,'stage':'response_counterexample','status':'CHECKED',**payload['construction']})
        if (cid,profile) in graph_groups:
            payload,summary=construct.graph(model,bound=256,seconds=20)
            attempts.append({'case_id':cid,'profile':profile,'stage':'graph','summary':summary})
            if payload is not None:admit(payload,'graph-256')
        for q in queries:
            candidates=per_query[q['query_id']]
            try:picked=choose(candidates)
            except ValueError as e:conflicts.append({'query_id':q['query_id'],'reason':str(e)});picked=None
            row={'query_id':q['query_id'],'source_query_id':q['source_query_id'],'case_id':cid,'profile':profile,
                 'property_id':q['property_id'],'bound_ticks':q['bound_ticks'],
                 'model_digest':model.model_digest,'input_digest':model.d.input_digest,
                 'reference_semantics':q['timing_scope'],'sut_comparison_eligible':False,
                 'truth_status':'NOT_APPLICABLE' if q['applicability']=='NOT_APPLICABLE' else 'CERTIFIED' if picked else 'UNRESOLVED',
                 'verdict':None,'vacuous':None,'trigger_reachability':'UNKNOWN','evidence_refs':[]}
            if picked:
                row.update({k:v for k,v in picked.items() if k not in ('evidence','evidence_kind')})
                row['primary_evidence']=picked['evidence'];row['evidence_kind']=picked['evidence_kind']
            elif row['truth_status']=='UNRESOLVED':
                row['unresolved_reason']='NO_CHECKED_EVIDENCE_FOR_QUERY'
                if q['property_id']=='V10b' and q.get('covered_trigger_cutoff',0)<1:row['unresolved_reason']='NO_FULL_RESPONSE_WINDOW'
                if any(r.get('trigger_reachability')=='REACHABLE' for r in candidates):row['trigger_reachability']='REACHABLE'
            row['nonvacuous_reference_answer']=row['truth_status']=='CERTIFIED' and row['vacuous'] is False
            answers.append(row)
        if index%60==0 or index==len(groups):
            print(json.dumps({'groups_done':index,'total':len(groups),'answers_so_far':dict(Counter(r['truth_status'] for r in answers)),
                              'elapsed_seconds':round(time.monotonic()-begun,1)}),flush=True)
        # Keep one small abstract candidate per case, never searched graphs.
        remaining_groups[cid]-=1
        if not remaining_groups[cid]:projection_cache.pop(cid,None)
        gc.collect()
    if conflicts:
        for row in answers:
            if any(c['query_id']==row['query_id'] for c in conflicts):
                row.update(truth_status='CONFLICT',verdict=None,nonvacuous_reference_answer=False)
    write(a.output/'query-registry.json',{'queries':registry,'reference_scope':'reference-six-phase/0.1','source_queries_preserved':True})
    with (a.output/'answers.jsonl').open('w',encoding='utf8') as stream:
        for row in answers:stream.write(json.dumps(row,ensure_ascii=False)+'\n')
    write(a.output/'evidence-index.json',evidence_index);write(a.output/'construction-attempts.json',attempts);write(a.output/'conflicts.json',conflicts)
    summary={'stage':'P3','queries':len(registry),'answers':len(answers),'counts':dict(Counter(r['truth_status'] for r in answers)),
      'verdicts':dict(Counter(str(r['verdict']) for r in answers if r['truth_status']=='CERTIFIED')),
      'vacuity':dict(Counter(str(r['vacuous']) for r in answers if r['truth_status']=='CERTIFIED')),
      'evidence_files':len(evidence_index),'conflicts':len(conflicts),'source_unchanged':frozen==code_hashes(),
      'elapsed_seconds':time.monotonic()-begun,'whole_line_truth_complete':all(r['truth_status'] in ('CERTIFIED','NOT_APPLICABLE') for r in answers),
      'sut_alignment_complete':False,'meaning':'Checked reference-scoped answers; not automatic labels for the previous acverify experiments.'}
    write(a.output/'summary.json',summary)
    write(a.output/'manifest.json',{'schema':'whole-line-reference-p3/0.1','source_hashes':frozen,
      'files':{p.relative_to(a.output).as_posix():sha(p) for p in a.output.rglob('*') if p.is_file() and p.name!='manifest.json'},
      'reference_scope':'reference-six-phase/0.1','reviewer_type':'AI_technical_review','SUT_alignment_required':True})
    print(json.dumps(summary,ensure_ascii=False),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    main(p.parse_args())
