"""Fresh admission pass: recheck every artifact and reconstruct authoritative answers."""
import argparse
from collections import Counter,defaultdict
import json
from pathlib import Path
import shutil
import sys
import time

BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from reference.frontend import load
from reference.transition import ReferenceModel
from reference.common import digest
from certification.binding import make_query,resolve_many
from certification.policy import check_workspace
from certification.io import read,write,sha


def adjudicate(query,results):
    if query['applicability']=='NOT_APPLICABLE':return {'truth_status':'NOT_APPLICABLE','verdict':None,'evidence_refs':[],'vacuous':None,'trigger_reachability':'UNKNOWN'}
    answers=[r for r in results if r.get('verdict') is not None]
    verdicts={r['verdict'] for r in answers}
    if len(verdicts)>1:raise ValueError('Conflicting reference verdicts')
    witnessed=[r for r in results if r.get('trigger_reachability')=='REACHABLE']
    if witnessed and any(r.get('vacuous') is True for r in answers):raise ValueError('Vacuity conflicts with reachable trigger')
    if not answers:
        return {'truth_status':'UNRESOLVED','verdict':None,'evidence_refs':[],
            'unresolved_reason':'NO_FULL_RESPONSE_WINDOW' if query['property_id']=='V10b' and query.get('covered_trigger_cutoff',0)<1 else 'NO_CHECKED_EVIDENCE_FOR_QUERY',
            'vacuous':None,'trigger_reachability':'REACHABLE' if witnessed else 'UNKNOWN',
            'trigger_evidence_refs':sorted({r['evidence'] for r in witnessed})}
    # Select a representative certificate only after checking consensus.
    ordered=sorted(answers,key=lambda r:(r.get('trigger_reachability') in ('REACHABLE','UNREACHABLE'),
                     r.get('vacuous') is not None,r['evidence_kind']=='graph_certificate/0.1'),reverse=True)
    result={k:v for k,v in ordered[0].items() if k not in ('evidence','trigger_basis')}
    result.update(truth_status='CERTIFIED',primary_evidence=ordered[0]['evidence'],
                  evidence_refs=sorted({r['evidence'] for r in answers+witnessed}),
                  trigger_evidence_refs=sorted({r['evidence'] for r in witnessed}))
    if witnessed:
        result['trigger_reachability']='REACHABLE'
        if result['verdict']=='HOLDS':result['vacuous']=False
    return result


def main(a):
    check_workspace(a.workspace)
    if a.output.exists() and any(a.output.iterdir()):raise ValueError('Use a new final admission directory')
    a.output.mkdir(parents=True)
    manifest=read(a.candidates/'manifest.json');plan=read(a.candidates/'construction-plan.json');index=read(a.candidates/'evidence-index.json')
    queries=read(a.candidates/'query-registry.json')['queries'];groups=defaultdict(list)
    p1root=a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1'
    p1manifest=read(p1root/'manifest.json')
    for relative,h in p1manifest['files'].items():
        path=(p1root/relative).resolve()
        if not path.is_relative_to(p1root.resolve()) or sha(path)!=h:raise ValueError('P1 child artifact changed: '+relative)
    original=read(a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1/query-inventory.json')['queries']
    original={q['query_id']:q for q in original};inputs=read(a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1/case-inputs.json')
    require_files=[]
    for relative,h in manifest['files'].items():
        path=(a.candidates/relative).resolve()
        if not path.is_relative_to(a.candidates.resolve()) or sha(path)!=h:raise ValueError('Candidate file drift: '+relative)
    for relative,h in manifest['source_hashes'].items():
        if sha(BASE/relative)!=h:raise ValueError('Checker/kernel differs from construction: '+relative)
    if sha(a.construction_builder)!=plan['builder_sha256']:raise ValueError('Original construction source not preserved')
    if sha(a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1/manifest.json')!=plan['P1_manifest_sha256']:raise ValueError('P1 source scope changed')
    if len({q['query_id'] for q in queries})!=len(queries) or {q['source_query_id'] for q in queries}!=set(original):raise ValueError('Registry coverage differs')
    for q in queries:groups[(q['case_id'],q['profile'])].append(q)
    evidence_by_group=defaultdict(list)
    for path,record in index.items():evidence_by_group[(record['case_id'],record['profile'])].append((path,record))
    spec_digest=digest(read(BASE/'reference/specs/property-spec.json'));answers=[];receipts={};conflicts=[];begun=time.monotonic();scope_notes={}
    for number,((cid,profile),group) in enumerate(groups.items(),1):
        model=ReferenceModel(load(a.workspace,cid,profile));expected_inputs=inputs[cid]['input_hashes']
        if model.d.task.get('required_environment_gates'):
            scope_notes[cid]={'required_environment_gates':model.d.task['required_environment_gates'],
                'scope':'This metadata is not an additional executable goal/temporal formula in P1/P2.',
                'reason':'The dataset generator collects initially false external facts, including branch classifiers; do not infer that all must become true.'}
        if any(expected_inputs.get(k)!=v for k,v in model.d.input_hashes.items()):raise ValueError('Current case input drift: '+cid)
        folder=a.workspace/'datasets/ac-path-v1/cases'/cid
        if sha(folder/'case.json')!=expected_inputs['case_descriptor'] or sha(folder/'dependencies.lock.json')!=expected_inputs['dependency_lock']:raise ValueError('Descriptor/lock drift')
        for q in group:
            if q!=make_query(original[q['source_query_id']],model,spec_digest):raise ValueError('Query rebound or scope altered')
        evaluated={q['query_id']:[] for q in group}
        for path,record in evidence_by_group[(cid,profile)]:
            payload=read(a.candidates/path)
            if sha(a.candidates/path)!=record['sha256']:raise ValueError('Evidence digest differs')
            results,receipt=resolve_many(model,group,payload)
            if receipt!=record['checker_receipt']:raise ValueError('Evidence receipt did not reproduce: '+path)
            receipts[path]={'sha256':record['sha256'],'kind':payload['kind'],'case_id':cid,'profile':profile,
                            'model_digest':model.model_digest,'receipt':receipt,
                            'query_results':[{**r,'query_id':q['query_id']} for q,r in zip(group,results)]}
            for q,result in zip(group,results):evaluated[q['query_id']].append({**result,'evidence':path,'evidence_kind':payload['kind']})
        for q in group:
            try:result=adjudicate(q,evaluated[q['query_id']])
            except ValueError as e:
                conflicts.append({'query_id':q['query_id'],'reason':str(e)});result={'truth_status':'CONFLICT','verdict':None,'vacuous':None,'evidence_refs':[],'trigger_reachability':'UNKNOWN'}
            row={k:q[k] for k in ('query_id','source_query_id','case_id','profile','property_id','bound_ticks','model_digest','input_digest',
                                   'property_version','tail_policy','response_window_ticks','covered_trigger_cutoff','checked_until')}
            row.update(reference_semantics=q['timing_scope'],sut_comparison_eligible=False,**result)
            row['nonvacuous_reference_answer']=row['truth_status']=='CERTIFIED' and row.get('vacuous') is False
            answers.append(row)
        if number%90==0 or number==len(groups):
            print(json.dumps({'rechecked_groups':number,'total':len(groups),'elapsed_seconds':round(time.monotonic()-begun,1)}),flush=True)
    # Recheck actual input bytes at the end, including cases visited early.
    input_cache={}
    for cid,info in inputs.items():
        folder=a.workspace/'datasets/ac-path-v1/cases'/cid;descriptor=read(folder/'case.json')
        for name,h in info['input_hashes'].items():
            path=(folder/descriptor['inputs'][name] if name in descriptor['inputs'] else
                  folder/'case.json' if name=='case_descriptor' else folder/descriptor['dependency_lock'] if name=='dependency_lock' else
                  a.workspace/'datasets/ac-path-v1'/name).resolve()
            if path not in input_cache:input_cache[path]=sha(path)
            if input_cache[path]!=h:raise ValueError('End-of-admission input drift: '+cid+'|'+name)
    previous={r['query_id']:r for r in (json.loads(line) for line in (a.candidates/'answers.jsonl').read_text(encoding='utf8').splitlines())}
    differences=[]
    for row in answers:
        for field in ('truth_status','verdict','vacuous','trigger_reachability'):
            if row.get(field)!=previous[row['query_id']].get(field):differences.append({'query_id':row['query_id'],'field':field})
    if differences:raise ValueError('Independent aggregation differs: '+str(differences[:5]))
    # Copy evidence only after the complete independent admission pass.
    for relative in index:
        target=a.output/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(a.candidates/relative,target)
    write(a.output/'query-registry.json',read(a.candidates/'query-registry.json'))
    with (a.output/'answers.jsonl').open('w',encoding='utf8') as stream:
        for row in answers:stream.write(json.dumps(row,ensure_ascii=False)+'\n')
    write(a.output/'evidence-checks.json',receipts);write(a.output/'conflicts.json',conflicts)
    # Preserve all obligations, including incomplete graph attempts and refused proofs.
    write(a.output/'construction-attempts.json',read(a.candidates/'construction-attempts.json'))
    write(a.output/'construction-plan.json',plan)
    write(a.output/'source-scope-notes.json',{'cases':scope_notes,
        'scope':'V01-V10b as defined; goal expression and cleanup. Additional temporal/business requirements need explicit formulas.',
        'generator_reference':'tools/build_full_dataset.py:557','generator_sha256':sha(a.workspace/'tools/build_full_dataset.py')})
    target=a.output/'provenance/build_reference_truth_p3.py';target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(a.construction_builder,target)
    counts=Counter(r['truth_status'] for r in answers);vacuity=Counter(str(r['vacuous']) for r in answers if r['truth_status']=='CERTIFIED')
    by_property=defaultdict(Counter);by_profile=defaultdict(Counter);by_scene=defaultdict(Counter)
    for r in answers:
        by_property[r['property_id']][r['truth_status']]+=1;by_profile[r['profile']][r['truth_status']]+=1
        by_scene[r['case_id'].split('-')[0]][r['truth_status']]+=1
    summary={'stage':'P3','queries':len(queries),'counts':dict(counts),
       'verdicts':dict(Counter(str(r['verdict']) for r in answers if r['truth_status']=='CERTIFIED')),
       'vacuity':dict(vacuity),'reference_truth_coverage':counts['CERTIFIED']/(len(queries)-counts['NOT_APPLICABLE']),
       'nonvacuous_certified':sum(r['nonvacuous_reference_answer'] for r in answers),
       'evidence_files_rechecked':len(receipts),'conflicts':len(conflicts),'whole_line_truth_complete':counts['UNRESOLVED']==0 and not conflicts,
       'sut_alignment_complete':False,'elapsed_recheck_seconds':time.monotonic()-begun,
       'independent_aggregation_differences':differences,'task_metadata_scope_cases':len(scope_notes),
       'by_property':{k:dict(v) for k,v in by_property.items()},'by_profile':{k:dict(v) for k,v in by_profile.items()},
       'by_scene':{k:dict(v) for k,v in by_scene.items()},
       'boundary':'Reference-scoped standard answers under the pinned P2 kernel; no legacy/SUT equivalence or equipment certification.'}
    write(a.output/'summary.json',summary)
    write(a.output/'manifest.json',{'schema':'whole-line-reference-p3/0.1','admission':'fresh recheck, not copied builder verdicts',
       'source_hashes':{p.relative_to(BASE).as_posix():sha(p) for folder in ('reference','certification') for p in (BASE/folder).rglob('*') if p.suffix in ('.py','.json','.md')},
       'files':{p.relative_to(a.output).as_posix():sha(p) for p in a.output.rglob('*') if p.is_file() and p.name!='manifest.json'},
       'auditor_sha256':sha(__file__),'construction_manifest_sha256':sha(a.candidates/'manifest.json'),
       'reference_scope':'reference-six-phase/0.1','reviewer_type':'AI_technical_review','SUT_alignment_required':True})
    print(json.dumps(summary,ensure_ascii=False),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--candidates',type=Path,required=True)
    p.add_argument('--construction-builder',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    main(p.parse_args())
