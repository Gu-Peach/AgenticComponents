"""Check legal paths and complete successor coverage, not solver verdict flags.

The frozen P2 transition relation is the trusted kernel. This checker is separate
from its search loop and from the tested acverify algorithm, but is not a proof
that P2 refines real devices or another execution semantics.
"""
from collections import Counter,defaultdict,deque
from reference.common import canonical,digest,clone
from reference.monitors import goal
from .policy import check_kernel


class BadEvidence(ValueError):pass


def require(ok,message):
    if not ok:raise BadEvidence(message)


def bind(model,query,payload):
    require(query['model_digest']==model.model_digest,'Query/reference model mismatch')
    require(payload['model_digest']==model.model_digest,'Evidence/reference model mismatch')
    require(query['input_digest']==model.d.input_digest,'Query/input mismatch')
    require(query['timing_scope']==model.d.profile['timing_scope'],'Timing scope mismatch')
    require(query['case_id']==model.d.case_id and query['profile']==model.d.profile['name'],'Case/profile mismatch')


def check_trace(model,payload):
    check_kernel(model)
    require(payload['model_digest']==model.model_digest,'Trace model differs')
    require(payload['initial']==model.initial,'Initial state differs')
    current=clone(model.initial);observations=[]
    for step in payload['steps']:
        target=canonical(step['state']);found=None
        for nxt,events in model.successors(current):
            if canonical(nxt)==target and events==step['events']:
                found=nxt;break
        require(found is not None,'No legal reference transition at tick '+str(current['tick']))
        require(found['tick']==current['tick']+1,'Invalid clock increment')
        observations.append((found,step['events']));current=found
    return {'kind':'checked_trace','model_digest':model.model_digest,'initial':model.initial,
            'observations':observations,'last_tick':current['tick'],'checked_steps':len(observations)}


def check_graph(model,payload):
    check_kernel(model)
    require(payload['model_digest']==model.model_digest,'Graph model differs')
    bound=payload['coverage_bound'];require(type(bound) is int and bound>=0,'Invalid graph horizon')
    states=payload['states'];edges=payload['edges']
    require(states and states[0]==model.initial,'Graph initial state differs')
    encoded=[canonical(s) for s in states];require(len(set(encoded))==len(encoded),'Duplicate canonical state')
    index={v:i for i,v in enumerate(encoded)};outgoing=defaultdict(list)
    for edge in edges:
        a,b=edge['from'],edge['to']
        require(type(a) is int and type(b) is int and 0<=a<len(states) and 0<=b<len(states),'Invalid graph endpoint')
        outgoing[a].append(edge)
    boundary=[]
    for i,state in enumerate(states):
        require(0<=state['tick']<=bound,'State outside declared graph horizon')
        expected=Counter()
        if state['tick']<bound or state['outcome']!='running':
            for nxt,events in model.successors(state):
                value=canonical(nxt)
                require(value in index,'Missing legal successor of state '+str(i))
                expected[canonical([index[value],events])]+=1
        else:boundary.append(i)
        actual=Counter(canonical([e['to'],e['events']]) for e in outgoing[i])
        require(actual==expected,'Incomplete or altered outgoing edges at state '+str(i))
    reachable={0};queue=deque([0])
    while queue:
        for edge in outgoing[queue.popleft()]:
            if edge['to'] not in reachable:reachable.add(edge['to']);queue.append(edge['to'])
    require(len(reachable)==len(states),'Unreachable graph states')
    return {'kind':'checked_graph','model_digest':model.model_digest,'states':states,'edges':edges,
            'coverage_bound':bound,'closed':not boundary,'boundary':boundary,
            'checked_steps':len(edges),'last_tick':max(s['tick'] for s in states)}


def _response_violation(events,query):
    if query['property_id']!='V10b':return False
    cutoff=query.get('covered_trigger_cutoff',query['bound_ticks'])
    return any(e['kind']=='response_deadline_violation' and e['accepted_at']<=cutoff and
               e['deadline']<=query.get('checked_until',query['bound_ticks']) for e in events)


def verdict_from_checked(model,query,checked):
    require(query['model_digest']==checked['model_digest']==model.model_digest,'Checked evidence binding differs')
    pid=query['property_id'];bound=query['bound_ticks'];end=query.get('checked_until',bound)
    if checked['kind']=='checked_trace':
        frames=checked['observations']
        for state,events in frames:
            if state['tick']>end:break
            if pid=='V10a' and state['tick']<=bound and goal(model.d,state):
                return {'verdict':'REACHABLE','scope':'within_bound','witness_tick':state['tick'],'vacuous':False,'trigger_reachability':'REACHABLE'}
            if (pid=='V10b' and _response_violation(events,query)) or (pid not in ('V10a','V10b') and state['tick']<=bound and pid in state['violations']):
                return {'verdict':'VIOLATED','scope':'within_bound','witness_tick':state['tick'],'vacuous':False,'trigger_reachability':'REACHABLE'}
        result={'verdict':None,'reason':'ONE_TRACE_CANNOT_ESTABLISH_UNIVERSAL_OR_UNREACHABLE_CLAIM'}
        for state,_ in [(checked['initial'],[])]+frames:
            if state['tick']>bound:break
            triggered=(any(t.get('accepted_at') is not None and t['accepted_at']<=query.get('covered_trigger_cutoff',bound)
                           for t in state['tokens'].values()) if pid=='V10b' else pid in state['triggered'])
            if triggered:
                result.update(trigger_reachability='REACHABLE',trigger_tick=state['tick']);break
        return result
    states=checked['states'];edges=checked['edges'];coverage=checked['coverage_bound']
    visited=[s for s in states if s['tick']<=bound]
    unknown=[v for s in states for v in s['uncovered_properties'] if v.split(':')[0]==pid]
    if unknown:return {'verdict':None,'reason':'UNCOVERED_PROPERTY_OBSERVATION'}
    if pid=='V10a':
        if any(goal(model.d,s) for s in visited):return {'verdict':'REACHABLE','scope':'within_bound','vacuous':False,'trigger_reachability':'REACHABLE'}
        if not checked['closed'] and coverage<bound:return {'verdict':None,'reason':'GRAPH_HORIZON_TOO_SHORT'}
        return {'verdict':'UNREACHABLE','scope':'within_bound','vacuous':False,'trigger_reachability':'UNREACHABLE'}
    if pid=='V10b':
        for edge in edges:
            if states[edge['to']]['tick']<=end and _response_violation(edge['events'],query):
                return {'verdict':'VIOLATED','scope':'declared_response_window','vacuous':False,'trigger_reachability':'REACHABLE'}
        # The P1 inventory explicitly flags windows that cannot test a newly
        # accepted request. Do not turn an empty deadline domain into useful gold.
        if query.get('covered_trigger_cutoff',bound)<1:return {'verdict':None,'reason':'NO_FULL_RESPONSE_WINDOW'}
        if not checked['closed']:return {'verdict':None,'reason':'RESPONSE_TAIL_NOT_CLOSED'}
        if any(s['tokens'][k]['status']=='isolated' and any(s['plant']['grants'].get(r)!=k for r in s['tokens'][k]['owned'])
               for s in states for k in s['tokens']):return {'verdict':None,'reason':'ISOLATION_PREMISE_NOT_SATISFIED'}
        triggered=any(t.get('accepted_at') is not None and t['accepted_at']<=query.get('covered_trigger_cutoff',bound)
                      for s in states for t in s['tokens'].values())
    else:
        if any(pid in s['violations'] for s in visited):return {'verdict':'VIOLATED','scope':'within_bound','vacuous':False,'trigger_reachability':'REACHABLE'}
        if not checked['closed'] and coverage<bound:return {'verdict':None,'reason':'GRAPH_HORIZON_TOO_SHORT'}
        triggered=any(pid in s['triggered'] for s in visited)
    result={'verdict':'HOLDS','scope':('declared_response_window_on_closed_model' if pid=='V10b' else
            'complete_reference_model' if checked['closed'] else 'within_bound'),
            'vacuous':not triggered,'trigger_reachability':'REACHABLE' if triggered else 'UNREACHABLE'}
    if pid=='V10b':
        cutoff=query.get('covered_trigger_cutoff',bound)
        result['tail_trigger_reachable']=any(t.get('accepted_at') is not None and cutoff<t['accepted_at']<=bound
                          for s in states for t in s['tokens'].values())
    return result
