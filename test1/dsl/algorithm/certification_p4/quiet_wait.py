"""Exact compressed witness segment for quiescent, stale-message waiting.

This proves one selected no-fault schedule, not a reduction of all executions.
Clock boundaries are never crossed. Old packets retain their sample timestamps.
"""
from reference.common import clone,canonical,digest,duration,TERMINAL
from reference.channel import interested
from reference.control import policy
from certification.evidence_check import require,BadEvidence
from .invariants import catalog


def chosen_next(model,state):
    gen=model.successors(state)
    try:
        for nxt,events in gen:
            if nxt['faults_used']!=state['faults_used']:continue
            okay=True
            for p in nxt['mail']:
                if p['sample_tick']!=nxt['tick']:continue
                delay=model.d.profile['feedback'][1] if p['kind'] in ('result','stop') else model.d.profile['feedback'][0]
                if p['due']!=p['sample_tick']+1+delay:okay=False;break
            if okay:return nxt,events
    finally:gen.close()
    raise BadEvidence('No legal successor for selected message schedule')


def without_clock_and_mail(state):return {k:v for k,v in state.items() if k not in ('tick','mail')}


def hypotheses(model,state):
    catalog(model);d=model.d;now=state['tick'];latency=1+d.profile['feedback'][1]
    require(state['outcome']=='running' and set(state['violations'])<={'V10b'} and not state['uncovered_properties'],'Not a supported running prefix')
    require(latency>d.profile['max_age'],'Maximum delay is not necessarily stale')
    require(not any(t.get('hardware') for t in state['tokens'].values()),'Physical event still pending')
    levels=[]
    for stream,level in sorted(state['latches'].items()):
        k=level['request'];t=state['tokens'][k]
        if interested(t,level['kind'],k in state['lost_stop']) and level['epoch']==state['plant']['devices'][level['provider']]['epoch']:
            require(level['kind'] in ('result','stop'),'Fresh protocol receipt can change control state')
            levels.append((stream,level))
    previous={}
    for packet in state['mail']:
        require(packet['kind'] in ('result','stop'),'Other packet kind pending')
        require(packet['sample_tick']<=now<packet['due']==packet['sample_tick']+latency,'Queue not in the selected stale schedule')
        require(packet['due']>=previous.get(packet['stream'],-1),'FIFO date inversion')
        previous[packet['stream']]=packet['due']
    boundaries=[]
    for t in state['tokens'].values():
        if t['status'] in TERMINAL:continue
        p=policy(d,t);status=t['status'];kind=t['kind'];n=d.nodes[t['node']]
        if t['eligible']>now:boundaries.append(t['eligible'])
        if kind in ('invoke','with-control') and status in ('ready','gate'):boundaries.append(t['born']+p['gate_ticks'])
        if status=='waiting_accept':boundaries.append(t['submitted']+p['accept_ticks'])
        if status=='executing':boundaries.append(t['execution_start']+p['execute_ticks'])
        if status=='entering':boundaries.append(t['enter_start']+p['accept_ticks'])
        if status in ('stopping','exiting'):boundaries.append(t['stop_start']+p['stop_ticks'])
        if kind=='await':boundaries.append(t['born']+duration(n[3]))
        if kind=='delay':boundaries.append(t['born']+max(1,duration(n[2:])))
        if kind=='branch' and status=='choosing':boundaries.append(t['born']+duration(n[3]))
        if t.get('accepted_at') is not None and d.profile['response_window'] is not None:
            deadline=t['accepted_at']+d.profile['response_window']
            if deadline>now:boundaries.append(deadline)
            else:require('V10b' in state['violations'],'An expired response was not recorded')
    for i,event in enumerate(d.profile['events']):
        if i not in state['events_done'] and event['tick']>now:boundaries.append(event['tick'])
    require(boundaries and min(boundaries)>now+1,'No nontrivial safe interval')
    return levels,min(boundaries),latency


def forecast(model,state,delta):
    levels,boundary,latency=hypotheses(model,state)
    require(type(delta) is int and delta>=1 and state['tick']+delta<boundary,'Jump crosses a control/property boundary')
    end=state['tick']+delta;nxt=clone(state);nxt['tick']=end
    nxt['mail']=[clone(p) for p in state['mail'] if p['due']>end]
    # Omitted samples were genuinely acquired and then delivered stale. Only
    # samples that are still queued at the end need concrete representation.
    for sampled in range(max(state['tick']+1,end-latency+1),end+1):
        for stream,level in levels:
            nxt['mail'].append({**level,'sample_tick':sampled,'due':sampled+latency,'stream':stream})
    return nxt,{'rule':'quiescent_stale_wait/0.1','start_tick':state['tick'],'end_tick':end,
                'next_boundary':boundary,'latency':latency,'streams':[x[0] for x in levels],
                'already_recorded_violations':state['violations'],
                'no_optional_fault_selected':True,'frame_unchanged':digest(without_clock_and_mail(state))}


def make_jump(model,state,max_tick):
    try:
        _,boundary,_=hypotheses(model,state);delta=min(boundary-1,max_tick)-state['tick']
        if delta<2:return None
        one,_=forecast(model,state,1);actual,_=chosen_next(model,state)
        require(actual==one,'Non-time control/event change prevents a waiting segment')
        final,proof=forecast(model,state,delta)
        return {'kind':'quiet_wait','delta':delta,'after':final,'proof':proof}
    except (BadEvidence,KeyError,TypeError,ValueError):return None


def check_jump(model,state,segment):
    one,_=forecast(model,state,1);actual,_=chosen_next(model,state)
    require(actual==one,'Waiting induction base does not hold')
    expected,proof=forecast(model,state,segment['delta'])
    require(segment['proof']==proof and segment['after']==expected,'Waiting recurrence or boundary altered')
    return expected


def generate_trace(model,bound=12000,stop_on_violation=True):
    state=model.initial;segments=[]
    while state['outcome']=='running' and state['tick']<bound:
        jump=make_jump(model,state,bound)
        if jump is not None:segments.append(jump);state=jump['after'];continue
        nxt,events=chosen_next(model,state);segments.append({'kind':'tick','after':nxt,'events':events});state=nxt
        if stop_on_violation and state['violations']:break
    return {'kind':'p4_macro_trace/0.1','model_digest':model.model_digest,'initial':model.initial,'segments':segments,
            'selection':'fresh acceptance; stale results/stops; no optional faults; exact quiet waiting segments'}


def check_trace(model,payload):
    require(payload['model_digest']==model.model_digest and payload['initial']==model.initial,'Macro trace input differs')
    state=clone(model.initial);observations=[];jumps=0;skipped=0
    for segment in payload['segments']:
        if segment['kind']=='quiet_wait':
            state=check_jump(model,state,segment);jumps+=1;skipped+=segment['delta']
            observations.append((state,[]))
        elif segment['kind']=='tick':
            match=None
            for nxt,events in model.successors(state):
                if nxt==segment['after'] and events==segment['events']:match=nxt;break
            require(match is not None,'Illegal explicit tick in macro trace')
            state=match;observations.append((state,segment['events']))
        else:raise BadEvidence('Unknown witness segment')
    return {'kind':'checked_trace','model_digest':model.model_digest,'initial':model.initial,'observations':observations,
            'last_tick':state['tick'],'checked_steps':len(observations),'quiet_segments':jumps,'represented_wait_ticks':skipped}
