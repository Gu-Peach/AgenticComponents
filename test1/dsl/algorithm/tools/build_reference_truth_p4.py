"""Extend the frozen P3 registry with checked P4 proofs and response-window queries."""
import argparse
from collections import defaultdict,Counter
import gc
import json
from pathlib import Path
import shutil
import sys
import time

BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from reference.frontend import load
from reference.transition import ReferenceModel
from reference.common import digest
from certification.binding import make_query
from certification.io import read,write,sha
from certification.policy import check_workspace
from certification_p4 import invariants,event_rules,goal_projection,response_bound,quiet_wait,witnesses
from certification_p4.binding import resolve_many


def code_hashes():
    return {p.relative_to(BASE).as_posix():sha(p) for folder in ('reference','certification','certification_p4') for p in (BASE/folder).rglob('*') if p.suffix in ('.py','.json','.md')}


def merge(query,items):
    if query['applicability']=='NOT_APPLICABLE':return {'truth_status':'NOT_APPLICABLE','verdict':None,'vacuous':None,'trigger_reachability':'UNKNOWN','evidence_refs':[]}
    proven=[r for r in items if r.get('verdict') is not None]
    if len({r['verdict'] for r in proven})>1:raise ValueError('Opposite checked conclusions')
    reached=[r for r in items if r.get('trigger_reachability')=='REACHABLE']
    if reached and any(r.get('vacuous') is True for r in proven):raise ValueError('Vacuity conflicts with witnessed trigger')
    if not proven:return {'truth_status':'UNRESOLVED','verdict':None,'vacuous':None,
        'trigger_reachability':'REACHABLE' if reached else 'UNKNOWN','evidence_refs':[],
        'trigger_evidence_refs':sorted({r['evidence'] for r in reached}),
        'unresolved_reason':'NO_FULL_RESPONSE_WINDOW' if query['property_id']=='V10b' and query.get('covered_trigger_cutoff',0)<1 else 'NO_CHECKED_EVIDENCE'}
    selected=max(proven,key=lambda r:(r.get('trigger_reachability') in ('REACHABLE','UNREACHABLE'),r.get('vacuous') is not None))
    result={k:v for k,v in selected.items() if k not in ('evidence','trigger_basis')}
    result.update(truth_status='CERTIFIED',primary_evidence=selected['evidence'],
                  evidence_refs=sorted({r['evidence'] for r in proven+reached}),
                  trigger_evidence_refs=sorted({r['evidence'] for r in reached}))
    if reached:
        result['trigger_reachability']='REACHABLE'
        if result['verdict']=='HOLDS':result['vacuous']=False
    return result


def main(a):
    check_workspace(a.workspace)
    if a.output.exists() and any(a.output.iterdir()):raise ValueError('Choose a fresh P4 directory')
    a.output.mkdir(parents=True)
    p3=a.workspace/'datasets/ac-path-v1/oracle/whole-line-p3-v1';p1=a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1'
    parent_manifest=read(p3/'manifest.json')
    for name,h in parent_manifest['files'].items():
        if sha(p3/name)!=h:raise ValueError('P3 package drift:'+name)
    for name,h in parent_manifest['source_hashes'].items():
        if sha(BASE/name)!=h:raise ValueError('P3 kernel/checker changed:'+name)
    source_queries=read(p1/'query-inventory.json')['queries'];proposed=read(p1/'proposed-query-extensions.json')['queries']
    case_inputs=read(p1/'case-inputs.json');old_queries=read(p3/'query-registry.json')['queries'];old_by_id={q['query_id']:q for q in old_queries}
    old_answers={r['query_id']:r for r in (json.loads(l) for l in (p3/'answers.jsonl').read_text(encoding='utf8').splitlines())}
    inherited=read(p3/'evidence-checks.json');old_results=defaultdict(list)
    for path,entry in inherited.items():
        for r in entry['query_results']:
            old_results[r['query_id']].append({**r,'evidence':path,'evidence_kind':entry['kind']})
    groups=defaultdict(list)
    for q in source_queries+proposed:groups[(q['case_id'],q['profile'])].append(q)
    spec_digest=digest(read(BASE/'reference/specs/property-spec.json'));frozen=code_hashes();begun=time.monotonic()
    write(a.output/'construction-plan.json',{'stage':'P4','original_queries':len(source_queries),'extended_queries':len(proposed),
        'model_groups':len(groups),'sources':frozen,'builder_sha256':sha(__file__),
        'P3_manifest_sha256':sha(p3/'manifest.json'),'P1_manifest_sha256':sha(p1/'manifest.json'),
        'scope':'Same frozen reference kernel; old IDs preserved; extended V10b windows get new IDs; no SUT results used'})
    registry=[];answers=[];new_checks={};attempts=[];conflicts=[];projection_cache={};remaining=Counter(cid for cid,_ in groups)
    for number,((cid,profile),source_group) in enumerate(groups.items(),1):
        m=ReferenceModel(load(a.workspace,cid,profile))
        if any(case_inputs[cid]['input_hashes'].get(k)!=v for k,v in m.d.input_hashes.items()):raise ValueError('Input drift:'+cid)
        qs=[make_query(s,m,spec_digest) for s in source_group];registry.extend(qs)
        for q in qs:
            if q['query_id'] in old_by_id and q!=old_by_id[q['query_id']]:raise ValueError('Original query changed')
        results={q['query_id']:list(old_results.get(q['query_id'],[])) for q in qs}
        def admit(payload,label):
            checked,receipt=resolve_many(m,qs,payload)
            if not any(r.get('verdict') is not None or r.get('trigger_reachability')=='REACHABLE' for r in checked):return
            path='evidence-p4/'+cid+'/'+profile+'-'+label+'.json.gz';h=write(a.output/path,payload)
            new_checks[path]={'sha256':h,'kind':payload['kind'],'case_id':cid,'profile':profile,'model_digest':m.model_digest,
                             'receipt':receipt,'query_results':[{**r,'query_id':q['query_id']} for q,r in zip(qs,checked)]}
            for q,r in zip(qs,checked):results[q['query_id']].append({**r,'evidence':path,'evidence_kind':payload['kind']})
        for pid in invariants.SITES:
            try:admit(invariants.generate(m,pid),'invariant-'+pid)
            except ValueError as e:attempts.append({'case_id':cid,'profile':profile,'rule':pid,'reason':str(e)})
        for rule in ('external_final_guard','external_initial_blocker','no_request_program'):
            try:admit(event_rules.generate(m,rule),rule)
            except ValueError as e:attempts.append({'case_id':cid,'profile':profile,'rule':rule,'reason':str(e)})
        try:admit(response_bound.generate(m),'response-bound')
        except ValueError as e:attempts.append({'case_id':cid,'profile':profile,'rule':'response_bound','reason':str(e)})
        # Per-profile proof binding remains explicit even when body effects agree.
        try:admit(goal_projection.generate(m),'goal-projection')
        except ValueError as e:attempts.append({'case_id':cid,'profile':profile,'rule':'goal_projection','reason':str(e)})
        def missing_response():
            return any(q['property_id']=='V10b' and q.get('covered_trigger_cutoff',-1)>=1 and
                       not any(r.get('verdict') is not None for r in results[q['query_id']]) for q in qs)
        if missing_response() and 1+m.d.profile['feedback'][1]>m.d.profile['max_age']:
            p=quiet_wait.generate_trace(m,bound=max(q['checked_until'] for q in qs),stop_on_violation=False)
            admit(p,'response-macro-trace')
        targets=set()
        for q in qs:
            pid=q['property_id'];items=results[q['query_id']]
            if q['applicability']=='NOT_APPLICABLE' or pid in ('V08','V09','V10a'):continue
            if pid=='V10b' and q.get('covered_trigger_cutoff',-1)<1:continue
            if any(r.get('trigger_reachability') in ('REACHABLE','UNREACHABLE') for r in items):continue
            if any(r.get('verdict') is not None for r in items):targets.add(pid)
        if targets:admit(witnesses.minimum_prefix(m,targets,bound=1000),'trigger-prefix')
        for q in qs:
            try:chosen=merge(q,results[q['query_id']])
            except ValueError as e:
                conflicts.append({'query_id':q['query_id'],'case_id':cid,'profile':profile,'property':q['property_id'],'reason':str(e)})
                chosen={'truth_status':'CONFLICT','verdict':None,'vacuous':None,'trigger_reachability':'UNKNOWN','evidence_refs':[]}
            if q['query_id'] in old_answers and old_answers[q['query_id']]['truth_status']=='CERTIFIED':
                if chosen['verdict']!=old_answers[q['query_id']]['verdict']:conflicts.append({'query_id':q['query_id'],'reason':'Regression against P3 checked answer'})
            row={k:q[k] for k in ('query_id','source_query_id','case_id','profile','property_id','bound_ticks','model_digest','input_digest',
                                   'property_version','tail_policy','response_window_ticks','covered_trigger_cutoff','checked_until')}
            row.update(reference_semantics=q['timing_scope'],sut_comparison_eligible=False,
                       query_set='original' if q['query_id'] in old_by_id else 'extended_response',**chosen)
            row['nonvacuous_reference_answer']=row['truth_status']=='CERTIFIED' and row.get('vacuous') is False
            answers.append(row)
        if number%60==0 or number==len(groups):
            print(json.dumps({'groups':number,'total':len(groups),'counts':dict(Counter(r['truth_status'] for r in answers)),
                              'elapsed_seconds':round(time.monotonic()-begun,1)}),flush=True)
        gc.collect()
    for path in inherited:
        target=a.output/path;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p3/path,target)
    write(a.output/'query-registry.json',{'queries':registry,'reference_scope':'reference-six-phase/0.1'})
    with (a.output/'answers.jsonl').open('w',encoding='utf8') as f:
        for r in answers:f.write(json.dumps(r,ensure_ascii=False)+'\n')
    write(a.output/'inherited-evidence-checks.json',inherited);write(a.output/'evidence-checks.json',new_checks)
    write(a.output/'attempts.json',attempts);write(a.output/'conflicts.json',conflicts)
    # A separate, versioned view proposes replacing only the inadequate legacy
    # response windows. The original records remain present and unresolved.
    extension_by_original={s['origin_query_id']:s['query_id'] for s in proposed}
    target_by_source={q['source_query_id']:q['query_id'] for q in registry};selected=[];replacements=[]
    for s in source_queries:
        original_target=target_by_source[s['query_id']]
        if s['property_id']=='V10b' and s.get('covered_trigger_cutoff',0)<1:
            new=target_by_source[extension_by_original[s['query_id']]];selected.append(new)
            replacements.append({'original_query_id':original_target,'extended_query_id':new,'reason':'empty full-response-window domain'})
        else:selected.append(original_target)
    by_id={r['query_id']:r for r in answers}
    write(a.output/'benchmark-view.json',{'id':'p4-window-explicit-view/0.1','query_ids':selected,'replacements':replacements,
        'scope_changed':True,'original_queries_retained':True,'SUT_alignment_required':True,
        'counts':dict(Counter(by_id[q]['truth_status'] for q in selected))})
    summary={'stage':'P4','queries':len(registry),'counts':dict(Counter(r['truth_status'] for r in answers)),
       'by_query_set':{s:dict(Counter(r['truth_status'] for r in answers if r['query_set']==s)) for s in ('original','extended_response')},
       'verdicts':dict(Counter(str(r['verdict']) for r in answers if r['truth_status']=='CERTIFIED')),
       'vacuity':dict(Counter(str(r['vacuous']) for r in answers if r['truth_status']=='CERTIFIED')),
       'new_evidence_files':len(new_checks),'inherited_evidence_files':len(inherited),'conflicts':len(conflicts),
       'source_unchanged':frozen==code_hashes(),'elapsed_seconds':time.monotonic()-begun,
       'whole_original_scope_complete':all(r['truth_status'] in ('CERTIFIED','NOT_APPLICABLE') for r in answers if r['query_set']=='original'),
       'extension_view_complete':all(by_id[q]['truth_status'] in ('CERTIFIED','NOT_APPLICABLE') for q in selected),
       'sut_alignment_complete':False}
    write(a.output/'summary.json',summary)
    write(a.output/'manifest.json',{'schema':'whole-line-reference-p4/0.1','source_hashes':frozen,
       'files':{p.relative_to(a.output).as_posix():sha(p) for p in a.output.rglob('*') if p.is_file() and p.name!='manifest.json'},
       'P3_manifest_sha256':sha(p3/'manifest.json'),'builder_sha256':sha(__file__),'reviewer_type':'AI_technical_review'})
    print(json.dumps(summary,ensure_ascii=False),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    main(p.parse_args())
