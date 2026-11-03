"""Plain reference enumeration. Resource exhaustion is not a truth verdict."""
from collections import deque,Counter
import hashlib
import time
from .common import canonical,digest,clone
from .monitors import goal


def enumerate_model(model,bound=256,max_states=100000,seconds=30,search='complete',memory_mb=512,retain_edges=False):
    states=[model.initial];parents=[None];seen={canonical(model.initial):0};queue=deque([0])
    terminals=Counter();bad={};goals=[];horizon=False;limit=None;edges=0;start=time.perf_counter();edge_digest=hashlib.sha256();early=False;uncovered=set()
    stored_bytes=len(next(iter(seen)).encode());peak_rss=0;edge_records=[]
    try:
        import psutil
        process=psutil.Process()
    except ImportError:process=None
    while queue:
        if time.perf_counter()-start>=seconds:limit='TIMEOUT';break
        if process is not None:
            peak_rss=max(peak_rss,process.memory_info().rss)
            if peak_rss>memory_mb*1024*1024:limit='MEMORY_LIMIT';break
        i=queue.pop() if search=='witness' else queue.popleft();s=states[i]
        uncovered.update(s['uncovered_properties'])
        for pid in s['violations']:bad.setdefault(pid,i)
        if goal(model.d,s):
            goals.append(i)
            if search=='witness':early=True;break
        if s['outcome']!='running':terminals[s['outcome']]+=1;continue
        if s['tick']>=bound:horizon=True;continue
        for nxt,log in model.successors(s):
            if time.perf_counter()-start>=seconds:limit='TIMEOUT';break
            encoded=canonical(nxt);target=seen.get(encoded)
            uncovered.update(nxt['uncovered_properties'])
            if target is None:
                if len(states)>=max_states:limit='STATE_LIMIT';break
                size=len(encoded.encode())
                if stored_bytes+size>memory_mb*1024*1024:limit='SERIALIZED_SIZE_LIMIT';break
                stored_bytes+=size
                target=len(states);seen[encoded]=target;states.append(nxt);parents.append((i,log));queue.append(target)
            edges+=1;edge_digest.update(canonical([i,target,log]).encode())
            if retain_edges:edge_records.append({'from':i,'to':target,'events':log})
        if limit:break
    exhausted=not queue and limit is None and not early
    return {'states':states,'parents':parents,'goals':goals,'bad':bad,'edges':edge_records,
        'summary':{'reference_version':model.version,'model_digest':model.model_digest,'case_id':model.d.case_id,
          'profile':model.d.profile,'bound':bound,'search':search,'states':len(states),'edges':edges,
          'frontier_exhausted':exhausted,'finite_model_closed':exhausted and not horizon,
          'horizon_reached':horizon,'limit':limit,'elapsed_seconds':time.perf_counter()-start,
          'serialized_state_bytes':stored_bytes,'peak_sampled_rss_bytes':peak_rss,
          'all_edges_retained':retain_edges,
          'memory_tracking':'sampled RSS and serialized keys' if process is not None else 'serialized keys only',
          'terminal_counts':dict(terminals),'violations_seen':sorted(bad),'goal_witness_found':bool(goals),
          'uncovered_obligations':sorted(uncovered),'monitor_coverage_complete':not uncovered,
          'edge_digest':edge_digest.hexdigest(),'reference_queries_admitted':False,
          'note':'P2 model validation output; P3 must independently check evidence before truth admission.'}}


def trace(model,graph,index):
    steps=[]
    while graph['parents'][index] is not None:
        parent,events=graph['parents'][index];steps.append({'state':graph['states'][index],'events':events});index=parent
    return {'version':model.version,'model_digest':model.model_digest,'initial':model.initial,'steps':list(reversed(steps)),
            'scope':'one reference execution, not a whole-model proof'}


def replay(model,witness):
    if witness['model_digest']!=model.model_digest:raise ValueError('Model identity differs')
    if witness['initial']!=model.initial:raise ValueError('Initial state differs')
    current=clone(model.initial)
    for step in witness['steps']:
        target=canonical(step['state']);matched=False
        for nxt,events in model.successors(current):
            if canonical(nxt)==target and events==step['events']:
                current=nxt;matched=True;break
        if not matched:raise ValueError('Illegal reference step after tick '+str(current['tick']))
    return {'valid':True,'tick':current['tick'],'outcome':current['outcome'],
            'boundary':'self-model replay; not P3 independent evidence certification'}
