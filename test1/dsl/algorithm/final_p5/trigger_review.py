"""Reference-only non-vacuity supplements; no SUT prediction is consumed."""
import time
from collections import defaultdict,Counter
from .common import setup,read,read_rows,write,sha,seal,verify_files


def choose(model,state,mode):
    from reference.common import TERMINAL
    restart=(mode=='restart' and state['faults_used']==0 and
             any('actor' in t and t['status'] not in TERMINAL|{'ready','gate'} for t in state['tokens'].values()))
    iterator=model.successors(state)
    try:
        for nxt,events in iterator:
            faults=[e for e in events if e['kind']=='fault']
            if restart:
                if len(faults)!=1 or faults[0]['fault']!='provider_restart':continue
            elif faults:continue
            valid=True
            for packet in nxt['mail']:
                if packet['sample_tick']!=nxt['tick']:continue
                maximum=mode=='all_max' or packet['kind'] in ('result','stop')
                latency=model.d.profile['feedback'][int(maximum)]
                if packet['due']!=packet['sample_tick']+1+latency:valid=False;break
            if valid:return nxt,events
    finally:iterator.close()
    raise ValueError('No permitted successor for trigger strategy')


def trace(model,mode,bound=1000,seconds=5):
    from certification_p4.quiet_wait import make_jump
    state=model.initial;segments=[];start=time.monotonic();limit=None
    while state['outcome']=='running' and state['tick']<bound and 'V08' not in state['triggered']:
        if time.monotonic()-start>seconds:limit='TIMEOUT';break
        jump=make_jump(model,state,bound)
        if jump:
            segments.append(jump);state=jump['after'];continue
        nxt,events=choose(model,state,mode)
        segments.append(dict(kind='tick',after=nxt,events=events));state=nxt
    payload=dict(kind='p4_macro_trace/0.1',model_digest=model.model_digest,initial=model.initial,segments=segments,
                 selection=mode+'; original reference parameters; legal optional faults only')
    return payload,dict(mode=mode,last_tick=state['tick'],segments=len(segments),limit=limit,elapsed_seconds=time.monotonic()-start)


def run(workspace,output):
    workspace=setup(workspace)
    from reference.frontend import load
    from reference.transition import ReferenceModel
    from certification_p4.binding import resolve_many
    from certification.construct import graph
    oracle=workspace/'datasets/ac-path-v1/oracle/whole-line-p4-v1'
    manifest=read(oracle/'manifest.json');verify_files(workspace,manifest['source_hashes'])
    if output.exists():raise ValueError('Use a fresh trigger-review directory')
    output.mkdir(parents=True)
    queries=read(oracle/'query-registry.json')['queries'];gold={r['query_id']:r for r in read_rows(oracle/'answers.jsonl')}
    pending=read(oracle/'remaining-obligations.json')['nonvacuity_queries'];groups=defaultdict(list);wanted=defaultdict(set)
    for q in queries:groups[(q['case_id'],q['profile'])].append(q)
    for row in pending:wanted[(row['case_id'],row['profile'])].add(row['property_id'])
    jobs=[]
    for (cid,profile),properties in sorted(wanted.items()):
        if 'V08' in properties and profile in ('fault','delayed'):
            jobs.append(dict(case_id=cid,profile=profile,mode='restart' if profile=='fault' else 'all_max'))
        if properties-{'V08'}:jobs.append(dict(case_id=cid,profile=profile,mode='closed_graph'))
    write(output/'plan.json',dict(stage='P5.3-trigger-review',jobs=jobs,trace_bound=1000,seconds_per_trace=5,seconds_per_graph=5,
         selection='All pending V08 fault/delayed groups, plus every group with other pending properties. Nominal V08 not assumed unreachable.',
         original_manifest_sha256=sha(oracle/'manifest.json'),reference_sources=manifest['source_hashes']))
    index={};updates={};attempts=[];conflicts=[]
    for number,job in enumerate(jobs,1):
        cid,profile,mode=job['case_id'],job['profile'],job['mode'];model=ReferenceModel(load(workspace,cid,profile));qs=groups[cid,profile]
        if mode=='closed_graph':payload,stats=graph(model,bound=max(q['checked_until'] for q in qs),seconds=5)
        else:payload,stats=trace(model,mode)
        attempts.append({**job,'statistics':stats})
        if payload is not None:
            results,receipt=resolve_many(model,qs,payload)
            useful=False
            for q,r in zip(qs,results):
                old=gold[q['query_id']]
                if r.get('verdict') is not None and old['truth_status']=='CERTIFIED' and r['verdict']!=old['verdict']:
                    conflicts.append(dict(query_id=q['query_id'],old=old['verdict'],new=r['verdict'],job=job))
                if old['truth_status']=='CERTIFIED' and old['vacuous'] is None and r.get('trigger_reachability') in ('REACHABLE','UNREACHABLE'):
                    useful=True
            if useful:
                path=f'evidence/{cid}/{profile}-{mode}.json.gz';h=write(output/path,payload)
                # A fresh decode and second checker pass guard serialized artifacts.
                repeated,receipt2=resolve_many(model,qs,read(output/path))
                if repeated!=results or receipt2!=receipt:raise ValueError('Trigger evidence did not reproduce')
                index[path]=dict(sha256=h,kind=payload['kind'],case_id=cid,profile=profile,receipt=receipt,
                                query_results=[dict(query_id=q['query_id'],**r) for q,r in zip(qs,results)])
                for q,r in zip(qs,results):
                    old=gold[q['query_id']];tr=r.get('trigger_reachability')
                    if old['truth_status']=='CERTIFIED' and old['vacuous'] is None and tr in ('REACHABLE','UNREACHABLE'):
                        if q['query_id'] in updates and updates[q['query_id']]['trigger_reachability']!=tr:
                            conflicts.append(dict(query_id=q['query_id'],reason='Opposite trigger evidence'))
                        updates[q['query_id']]=dict(query_id=q['query_id'],trigger_reachability=tr,
                             vacuous=False if tr=='REACHABLE' else True,evidence=path,verdict_unchanged=old['verdict'])
        if number%40==0 or number==len(jobs):print(dict(trigger_jobs=number,total=len(jobs),resolved=len(updates),conflicts=len(conflicts)),flush=True)
    verify_files(workspace,manifest['source_hashes'])
    write(output/'evidence-checks.json',index);write(output/'updates.json',list(updates.values()))
    write(output/'attempts.json',attempts);write(output/'conflicts.json',conflicts)
    remaining=[r for r in pending if r['query_id'] not in updates]
    write(output/'remaining.json',dict(nonvacuity=remaining,original_window_obligations=read(oracle/'remaining-obligations.json')['queries']))
    summary=dict(original_unknown=len(pending),resolved=len(updates),remaining=len(remaining),jobs=len(jobs),evidence_files=len(index),
                 conflicts=len(conflicts),by_trigger=dict(Counter(r['trigger_reachability'] for r in updates.values())),
                 verdicts_changed=False,source='independent_reference_only',budget_failures=[r for r in attempts if r['statistics'].get('limit')])
    write(output/'summary.json',summary);seal(output,stage='P5.3-trigger-review',original_manifest_sha256=sha(oracle/'manifest.json'))
    if conflicts:raise ValueError('Reference trigger review conflicts require investigation')
    print({k:v for k,v in summary.items() if k!='budget_failures'},flush=True)
