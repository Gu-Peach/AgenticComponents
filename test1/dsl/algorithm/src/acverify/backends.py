"""Full explicit exploration and a graph-BMC cross-check backend."""
from collections import deque
import time
from .core import canonical, VerificationError, require
from .expressions import goal
from .properties import invariant_violations, edge_properties, property_ir
from .reduction import compact, clock_key
from .budgets import resident_bytes


def explore(model,bound=256,state_limit=20000,time_limit=30,memory_mb=512,mode='full',search='complete',optimized=False,keep_edges=True,target_properties=None):
    require(mode!='clock' or (search=='complete' and not model.profile['events']),
            'UNSUPPORTED_REDUCTION','Clock quotient requires complete BFS and no absolute-time external events')
    from .state_store import clone_state
    reduce=(lambda s: compact(s, clone_state)) if optimized and mode in ('compact','clock') else compact if mode in ('compact','clock') else lambda s:s
    key_of=lambda s:canonical((clock_key(s, clone_state, True) if optimized else clock_key(s)) if mode=='clock' else s)
    targets=set(target_properties) if target_properties is not None else None
    if targets is not None: require(targets <= {p['id'] for p in property_ir(model)},'INVALID_INPUT','Unknown target property')
    generated=0;duplicates=0;edge_count=0;queue_peak=1;expanded=0
    initial=reduce(model.initial);states=[initial];parents=[None];edges=[];seen={key_of(initial):0};queue=deque([0])
    bad={p:0 for p in invariant_violations(model,initial)};goal_index=0 if initial['outcome']=='succeeded' and goal(model,initial) else None
    terminal={};triggers={'V05','V06'};horizon=False;limit=None;size=len(next(iter(seen)));start=time.perf_counter()
    stopped_early=False
    peak_rss=resident_bytes() or 0
    last_memory_sample=0
    while queue:
        if time.perf_counter()-start>=time_limit:limit='TIMEOUT';break
        if len(states)-last_memory_sample>=64:
            peak_rss=max(peak_rss,resident_bytes() or 0)
            last_memory_sample=len(states)
        if peak_rss>memory_mb*1024*1024:limit='RESOURCE_LIMIT';break
        index=queue.pop() if search=='witness' else queue.popleft();state=states[index];expanded+=1
        if state['outcome']!='running':
            terminal.setdefault(state['outcome'],index)
            if state['outcome']=='attention_required':triggers.add('V08')
            continue
        if state['tick']>=bound:horizon=True;continue
        successors=0
        for nxt,events in model.successors(state):
            if time.perf_counter()-start>=time_limit:limit='TIMEOUT';break
            successors+=1;generated+=1
            if successors>4096:limit='RESOURCE_LIMIT';break
            eb,et=edge_properties(events);triggers|=et
            nxt['violations']=sorted(set(nxt['violations'])|eb)
            nxt=reduce(nxt);encoded=key_of(nxt);target=seen.get(encoded)
            if target is None:
                if len(states)>=state_limit or size+len(encoded)>memory_mb*1024*1024:limit='RESOURCE_LIMIT';break
                target=len(states);states.append(nxt);parents.append((index,events));seen[encoded]=target;size+=len(encoded);queue.append(target)
            else:duplicates+=1
            edge_count+=1;queue_peak=max(queue_peak,len(queue))
            if keep_edges:edges.append((index,target,events))
            if nxt['world']['grants']:triggers.add('V04')
            for pid in invariant_violations(model,nxt):bad.setdefault(pid,target)
            if nxt['outcome']=='succeeded' and goal(model,nxt):goal_index=target
            found=set(bad)|({'V10a'} if goal_index is not None else set())
            if search=='witness' and ((bool(found) if targets is None else bool(targets) and targets <= found)):
                stopped_early=True;break
        if limit or stopped_early:break
        if not successors:limit='MODEL_DEADLOCK';break
    complete=not(limit or horizon or queue or stopped_early)
    results={}
    for p in property_ir(model):
        pid=p['id'];vacuous=pid not in triggers and pid!='V10a'
        if not p['applicable']:verdict='NOT_APPLICABLE'
        elif pid=='V10a':
            verdict='GOAL_REACHABLE_WITHIN_BOUND' if goal_index is not None else ('GOAL_NOT_REACHED_ON_FINITE_MODEL' if complete else 'GOAL_NOT_REACHED_WITHIN_BOUND' if not(limit or stopped_early) else 'UNKNOWN')
        elif pid in bad:verdict='VIOLATED_IN_MODEL'
        elif complete:verdict='PROVED_ON_FINITE_MODEL'
        elif limit or stopped_early:verdict='UNKNOWN'
        else:verdict='NO_VIOLATION_WITHIN_BOUND'
        results[pid]={**p,'verdict':verdict,'vacuous':vacuous,'trigger_reachable':pid in triggers,
                      'incomplete_window':pid=='V10b' and not complete}
    return {'states':states,'parents':parents,'edges':edges,'bad':bad,'goal':goal_index,'terminals':terminal,
            'report':{'backend':'explicit','reduction':mode,'search':search,'bound_ticks':bound,
                      'finite_model_exhausted':complete,'horizon_reached':horizon,'limit':limit,'early_witness':stopped_early,
                      'states':len(states),'edges':edge_count,'stored_edges':len(edges),'all_edges_retained':keep_edges,
                      'generated_successors':generated,'duplicate_successors':duplicates,'expanded_states':expanded,'queue_peak':queue_peak,
                      'optimized_storage':optimized,'target_properties':sorted(targets) if targets is not None else None,'serialized_state_bytes':size,'elapsed_seconds':time.perf_counter()-start,
                      'peak_sampled_rss_bytes':max(peak_rss,resident_bytes() or 0),
                      'properties':results}}


def graph_bmc(graph,pid,timeout_ms=10000):
    """Independent SMT path encoding over an explicitly constructed finite graph.

    This backend does not claim direct symbolic construction or scaling benefits.
    Incomplete graphs can supply SAT witnesses, never UNSAT safety conclusions.
    """
    require(graph['report'].get('all_edges_retained',True),'BACKEND_UNAVAILABLE','Graph SMT requires retained edges')
    try:import z3
    except ImportError as error:raise VerificationError('BACKEND_UNAVAILABLE','Install acverify[smt] or z3-solver in .deps') from error
    states=graph['states'];targets=[]
    for i,state in enumerate(states):
        if pid=='V10a':
            if i==graph['goal']:targets.append(i)
        elif pid in state.get('violations',[]) or graph['bad'].get(pid)==i:targets.append(i)
    solver=z3.Solver();solver.set(timeout=timeout_ms)
    # A decreasing integer distance prevents circular support of reachability
    # even when the time-translation quotient introduces graph back edges.
    incoming={i:[] for i in range(len(states))}
    for a,b,_ in graph['edges']:incoming[b].append(a)
    reachable=[z3.Bool(f'reachable_{i}') for i in range(len(states))]
    distance=[z3.Int(f'distance_{i}') for i in range(len(states))]
    solver.add(reachable[0],distance[0]==0)
    for i in range(1,len(states)):
        parents=sorted(set(incoming[i]));solver.add(distance[i]>=1,distance[i]<=graph['report']['bound_ticks'])
        solver.add(reachable[i]==z3.Or([z3.And(reachable[p],distance[i]==distance[p]+1) for p in parents]))
    solver.add(z3.Or([reachable[i] for i in targets]))
    status=solver.check()
    if status==z3.sat:verdict='SAT'
    elif status==z3.unsat:verdict='UNSAT_ON_COMPLETE_GRAPH' if graph['report']['finite_model_exhausted'] else 'UNKNOWN_INCOMPLETE_GRAPH'
    else:verdict='UNKNOWN'
    return {'backend':'z3-finite-graph','result':verdict,'solver':z3.get_version_string(),
            'scope':'Cross-check of graph query encoding; shares transition semantics with explicit exploration.',
            'reason_unknown':solver.reason_unknown() if status==z3.unknown else None}
