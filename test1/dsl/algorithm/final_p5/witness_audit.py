"""Replay each distinct positive prediction in both execution models."""
from pathlib import Path
from .common import setup,read,write,sha,digest,seal,verify_files


def initial_history(reference):
    state=reference.initial
    return dict(trigger_ticks={p:0 for p in state['triggered']},first_violation={p:0 for p in state['violations']},
                uncovered={p.split(':')[0]:0 for p in state['uncovered_properties']},acceptances={},responses={},response_violations={})


def advance_history(reference,history,state,events):
    from copy import deepcopy
    h=deepcopy(history);tick=state['tick']
    for p in state['triggered']:h['trigger_ticks'].setdefault(p,tick)
    for p in state['violations']:h['first_violation'].setdefault(p,tick)
    for p in state['uncovered_properties']:h['uncovered'].setdefault(p.split(':')[0],tick)
    if reference.d.profile['response_window'] is not None:
        for key,t in state['tokens'].items():
            if t.get('accepted_at') is not None:h['acceptances'].setdefault(key,t['accepted_at'])
        for key in h['acceptances']:
            t=state['tokens'][key]
            response=t['status'] in ('ok','failed','cancelled') or (t['status']=='isolated' and all(state['plant']['grants'].get(r)==key for r in t['owned']))
            if response:h['responses'].setdefault(key,tick)
        for event in events:
            if event['kind']=='response_deadline_violation':
                h['response_violations'].setdefault(event['request'],dict(accepted_at=event['accepted_at'],deadline=event['deadline'],tick=tick))
    return h


def history_matches(sut_state,h):
    return all(sut_state[k]==v for k,v in h.items())


def map_to_reference(sut,reference,payload):
    from acverify_v3.search import replay
    from alignment_p52.relation import canonical,key
    native=replay(sut,payload)
    h0=initial_history(reference)
    if canonical(sut.initial)!=canonical(reference.initial,True) or not history_matches(sut.initial,h0):raise ValueError('Initial state/history relation failed')
    nodes=[dict(state=reference.initial,history=h0,parent=None,events=[])];frontier=[0]
    for index,step in enumerate(payload['steps'],1):
        target=canonical(step['state']);next_nodes={}
        for previous in frontier:
            current=nodes[previous]
            for state,events in reference.successors(current['state']):
                if canonical(state,True)!=target:continue
                history=advance_history(reference,current['history'],state,events)
                if not history_matches(step['state'],history):continue
                ident=key(dict(state=state,history=history))
                if ident not in next_nodes:
                    nodes.append(dict(state=state,history=history,parent=previous,events=events));next_nodes[ident]=len(nodes)-1
        if not next_nodes:raise ValueError('No reference state/history matches SUT tick '+str(index))
        if len(next_nodes)>10000:raise ValueError('Reference replay frontier exceeded audit budget')
        frontier=list(next_nodes.values())
    cursor=frontier[0];steps=[]
    while nodes[cursor]['parent'] is not None:
        n=nodes[cursor];steps.append(dict(state=n['state'],events=n['events']));cursor=n['parent']
    steps.reverse()
    converted=dict(kind='trace_certificate/0.1',model_digest=reference.model_digest,initial=reference.initial,steps=steps)
    return converted,dict(native=native,reference_steps=len(steps),max_history_tick=steps[-1]['state']['tick'] if steps else 0,
                          relation='Full mapped runtime state plus passive observer histories at every step')


def run(workspace,experiment,scores,output):
    workspace=setup(workspace);experiment=experiment.resolve();scores=scores.resolve();output=output.resolve()
    from alignment_p52.models import pair
    from certification.binding import validate_query
    from certification.evidence_check import verdict_from_checked
    verify_files(scores,read(scores/'manifest.json')['files'])
    if not read(experiment/'completion.json')['predictions_sealed']:raise ValueError('Predictions are not sealed')
    index=read(scores/'witness-index.json')
    registry={q['query_id']:q for q in read(workspace/'datasets/ac-path-v1/oracle/whole-line-p4-v1/query-registry.json')['queries']}
    plan=dict(predictions_manifest_sha256=sha(experiment/'manifest.json'),score_manifest_sha256=sha(scores/'manifest.json'),
              witness_index_sha256=sha(scores/'witness-index.json'),checker_sha256=sha(__file__),witnesses=len(index))
    if output.exists():
        if read(output/'plan.json')!=plan:raise ValueError('Audit resume differs')
    else:output.mkdir(parents=True);write(output/'plan.json',plan)
    results=[];issues=[];active=None;sut=reference=None
    for i,item in enumerate(sorted(index,key=lambda r:(r['case_id'],r['profile'],r['payload_digest'])),1):
        group=(item['case_id'],item['profile']);receipt_path=output/'checks'/(item['payload_digest']+'.json')
        if receipt_path.exists():
            result=read(receipt_path)
            if result['plan_digest']!=digest(plan):raise ValueError('Cached replay belongs to a different audit')
            if result['status']=='VERIFIED' and sha(output/result['reference_trace'])!=result['reference_trace_sha256']:raise ValueError('Cached mapped trace changed')
            results.append(result)
            if result['status']!='VERIFIED':issues.append(result)
            continue
        if group!=active:sut,reference=pair(workspace,*group);active=group
        result=dict(payload_digest=item['payload_digest'],case_id=item['case_id'],profile=item['profile'],plan_digest=digest(plan))
        try:
            path=experiment/item['path']
            if sha(path)!=item['sha256']:raise ValueError('Native witness hash changed')
            payload=read(path)
            if digest(payload)!=item['payload_digest'] or payload['model_digest']!=item['model_digest']:raise ValueError('Native witness binding changed')
            converted,receipt=map_to_reference(sut,reference,payload)
            checked=dict(kind='checked_trace',model_digest=reference.model_digest,initial=reference.initial,
                         observations=[(s['state'],s['events']) for s in converted['steps']])
            claims=[]
            for qid,prediction in item['queries'].items():
                q=registry[qid];validate_query(q,reference);verified=verdict_from_checked(reference,q,checked)
                if verified.get('verdict')!=prediction:raise ValueError('Reference replay does not establish claimed query: '+qid)
                claims.append(dict(query_id=qid,verdict=prediction))
            relative='reference-traces/'+item['payload_digest']+'.json.gz';h=write(output/relative,converted)
            result.update(status='VERIFIED',reference_trace=relative,reference_trace_sha256=h,receipt=receipt,claims=claims)
        except Exception as error:
            result.update(status='REPLAY_FAILED',error_type=type(error).__name__,message=str(error));issues.append(result)
        write(receipt_path,result);results.append(result)
        if i%25==0 or i==len(index):print(dict(witnesses=i,total=len(index),issues=len(issues)),flush=True)
    summary=dict(witnesses=len(index),verified=sum(r['status']=='VERIFIED' for r in results),issues=len(issues),
                 verified_query_claims=sum(len(r.get('claims',[])) for r in results),gold_changed=False)
    write(output/'summary.json',summary);write(output/'issues.json',issues)
    seal(output,stage='P5.5-independent-witness-audit',plan_digest=digest(plan))
    print(summary,flush=True)
