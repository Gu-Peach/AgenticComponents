"""Bounded explicit search with query-aware witnesses and conservative limits."""
from collections import deque
import time
from .core import canonical,require
from .budgets import resident_bytes
from .query import validate,observed,summarize


def explore(model,queries,seconds=30,state_limit=20000,memory_mb=512,strategy='complete',keep_edges=True):
    validate(model,queries)
    require(queries and seconds>=0 and state_limit>0 and memory_mb>0,'INVALID_QUERY','Invalid budget or empty query set')
    require(strategy in ('complete','witness'),'INVALID_QUERY','Unknown search strategy')
    horizon=max(q['checked_until'] for q in queries);start=time.perf_counter()
    states=[model.initial];parents=[None];seen={canonical(model.initial):0};frontier=deque([0]);edges=[]
    size=len(next(iter(seen)).encode());generated=0;horizon_hit=False;limit=None;partial=False;peak=resident_bytes() or 0;last_memory_sample=0
    records={q['query_id']:dict(positive=None,trigger=False,uncovered=False,witness=None) for q in queries}
    def inspect(state,index):
        for q in queries:
            record=records[q['query_id']];o=observed(model,state,q)
            record['trigger']|=o['trigger']
            monitor_tick=state['uncovered'].get(q['property_id'])
            record['uncovered']|=monitor_tick is not None and monitor_tick<=q['checked_until']
            if o['verdict'] and record['positive'] is None:record.update(positive=o,witness=index)
    inspect(model.initial,0)
    while frontier:
        if time.perf_counter()-start>=seconds:limit='TIMEOUT';break
        if len(states)-last_memory_sample>=64 or last_memory_sample==0:
            peak=max(peak,resident_bytes() or 0)
            last_memory_sample=len(states)
            if peak>memory_mb*1024*1024:limit='MEMORY_LIMIT';break
        index=frontier.pop() if strategy=='witness' else frontier.popleft();state=states[index]
        if state['outcome']!='running':continue
        if state['tick']>=horizon:horizon_hit=True;continue
        count=0;successors=model.successors(state)
        try:
            for nxt,events in successors:
                count+=1
                if time.perf_counter()-start>=seconds:limit='TIMEOUT';partial=True;break
                if len(states)-last_memory_sample>=64:
                    peak=max(peak,resident_bytes() or 0);last_memory_sample=len(states)
                    if peak>memory_mb*1024*1024:limit='MEMORY_LIMIT';partial=True;break
                encoded=canonical(nxt);target=seen.get(encoded)
                if target is None:
                    if len(states)>=state_limit or size+len(encoded.encode())>memory_mb*1024*1024:
                        limit='STATE_OR_STORAGE_LIMIT';partial=True;break
                    target=len(states);seen[encoded]=target;states.append(nxt);parents.append((index,events));frontier.append(target)
                    size+=len(encoded.encode())
                generated+=1
                if keep_edges:edges.append((index,target,events))
                inspect(nxt,target)
                if strategy=='witness' and any(r['positive'] for r in records.values()):limit='EARLY_WITNESS';partial=True;break
        finally:successors.close()
        if limit:break
        if count==0:limit='MODEL_DEADLOCK';partial=True;break
    complete=not limit and not frontier and not partial
    closed=complete and not horizon_hit
    rows=[]
    for q in queries:
        r=records[q['query_id']]
        rows.append(dict(query_id=q['query_id'],property_id=q['property_id'],**summarize(q,r['positive'],r['trigger'],complete,closed,r['uncovered'])))
    return dict(results=rows,states=states,parents=parents,edges=edges,witnesses={qid:r['witness'] for qid,r in records.items() if r['witness'] is not None},
        statistics=dict(states=len(states),edges=generated,stored_edges=len(edges),serialized_bytes=size,limit=limit,
            explored_all_prefixes=complete,finite_model_closed=closed,horizon=horizon,horizon_reached=horizon_hit,
            elapsed_seconds=time.perf_counter()-start,peak_sampled_rss_bytes=max(peak,resident_bytes() or 0)))


def witness(model,graph,index):
    tape=[];current=index
    while graph['parents'][current] is not None:
        parent,events=graph['parents'][current]
        tape.append(dict(state=graph['states'][current],events=events));current=parent
    return dict(model_digest=model.model_digest,initial=model.initial,steps=list(reversed(tape)))


def replay(model,payload):
    require(payload['model_digest']==model.model_digest and payload['initial']==model.initial,'BAD_WITNESS','Model/initial state differs')
    state=model.initial
    for step in payload['steps']:
        gen=model.successors(state)
        try:valid=any(s==step['state'] and e==step['events'] for s,e in gen)
        finally:gen.close()
        require(valid,'BAD_WITNESS','Illegal transition');state=step['state']
    return dict(checked_steps=len(payload['steps']),last_tick=state['tick'])
