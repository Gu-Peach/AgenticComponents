"""Passive obligation observers. They never authorize controller transitions."""
from .core import all3

IDENTITY=('activation','request','device','subject','epoch')


def identity(t):
    return dict(activation=t['key'],request=t['key'],device=t['device'],
                subject=t.get('args',{}).get('material'),epoch=t['epoch'])


def evidence_ok(packet,expected,tick,max_age):
    try:
        return (packet['valid'] is True and type(packet['value']) is bool
            and packet['provider']==expected['provider'] and packet['subject']==expected['subject']
            and packet['epoch']==expected['epoch']
            and (not expected['request_scoped'] or all(packet[k]==expected[k] for k in ('activation','request')))
            and type(packet['sample_tick']) is int and 0<=tick-packet['sample_tick']<=max_age)
    except (KeyError,TypeError):return None


def record(state,pid,value,log,active=True,detail=None):
    tick=state['tick']
    if active:state['trigger_ticks'].setdefault(pid,tick)
    if value is False:
        state['first_violation'].setdefault(pid,tick)
        if pid not in state['violations']:state['violations'].append(pid)
        log.append(dict(kind='obligation_violation',property=pid,tick=tick,detail=detail))
    elif value is not True:
        state['uncovered'].setdefault(pid,tick)


def on_evidence(model,state,packet,expected,log):
    record(state,'V03',evidence_ok(packet,expected,state['tick'],model.profile['max_age']),log,detail=dict(packet=packet,expected=expected))


def on_success(model,state,task,log):
    expected=identity(task);accepted=task['receipts'].get('accepted',{}).get('packet',{})
    result=task['receipts'].get('result',{}).get('packet',{})
    good=(bool(accepted) and result.get('value') is True and all(expected[k]==accepted.get(k)==result.get(k) for k in IDENTITY))
    record(state,'V02',good,log,detail=dict(expected=expected,accepted=accepted,result=result))


def stop_exit_valid(request,write,packet,epoch,drive,tick,max_age):
    try:
        expect=dict(provider=request['device'],subject=request['subject'],epoch=epoch,request_scoped=True,
                    activation=request['activation'],request=request['request'])
        return all3([write['request']==request['request'],write['run'] is False,
            None if drive is None else drive=='stopped',request['epoch']==epoch,packet['value'] is True,
            packet['sample_tick']>=write['tick'],evidence_ok(packet,expect,tick,max_age)])
    except (KeyError,TypeError):return None


def on_control_success(model,state,t,log):
    packet=t['receipts'].get('stop',{}).get('packet',{})
    write=dict(request=t['key'],run=False,tick=t['stop_start'])
    device=state['world']['devices'][t['device']]
    record(state,'V07',stop_exit_valid(identity(t),write,packet,device['epoch'],device['drive'],state['tick'],model.profile['max_age']),log,
           detail=dict(write=write,ack=packet,actual_drive=device['drive']))


def isolation_valid(before,after,required,grants,request,terminal='attention_required',expired=True):
    return all3([terminal not in ('confirmed_success','confirmed_failure','confirmed_cancel'),
        None if expired is None else (not expired or terminal=='attention_required'),
        all(grants.get(r)==request for r in required),before==after])


def on_isolation(state,task,before,log):
    record(state,'V08',isolation_valid(before,state['world']['materials'],task['claims'],state['world']['grants'],task['key']),log,
           detail=dict(request=task['key'],required=task['claims']))


def handoff_consistent(model,world,mid):
    m=world['materials'][mid]
    locations=[loc for loc,items in world['occupancy'].items() for item in items if item==mid]
    if m['region']=='unspawned':return not locations and m['holder'] is None and m['held_by'] is None
    if len(locations)!=1 or model.locations[locations[0]]['owner']!=m['holder']:return False
    h=world['handoffs'].get(mid)
    if h is None:
        return m['support']==m['region']==locations[0] and m['held_by'] is None
    phase=h['phase'];source=h['source'];target=h['target'];tool=h['tool'];actor=h['actor']
    if phase in ('reserved','captured'):
        position,ledger,holder=source,source,model.locations[source]['owner']
        held=actor if phase=='captured' else None
    elif phase in ('cleared','placed','released'):
        position=tool if phase=='cleared' else target
        ledger,holder=tool,actor;held=None if phase=='released' else actor
    elif phase=='committed':position,ledger,holder,held=target,target,model.locations[target]['owner'],None
    else:return None
    return (m['region']==m['support']==position and locations[0]==ledger and m['holder']==holder and m['held_by']==held)


def state_values(model,state):
    w=state['world'];grants=list(w['grants'].items())
    exclusive=all(a_owner==b_owner or (a!=b and frozenset((a,b)) not in model.conflicts)
                  for i,(a,a_owner) in enumerate(grants) for b,b_owner in grants[i+1:])
    handoff=all3(handoff_consistent(model,w,mid) for mid in w['materials'])
    capacity=True
    for loc,items in w['occupancy'].items():
        capacity &= len(items)+sum(r['target']==loc for r in w['reservations'].values())<=model.locations[loc]['capacity']
    for dev,d in model.devices.items():
        owned={k for k,v in model.locations.items() if v['owner']==dev}
        count=sum(len(w['occupancy'][loc]) for loc in owned)+sum(r['target'] in owned for r in w['reservations'].values())
        capacity &= count<=d['parameters']['capacity']
    commits=list(w['commit_records'].values())
    identities=[(c['activation'],c['request']) for c in commits]
    capacity &= len(identities)==len(set(identities))
    return {'V04':exclusive,'V05':handoff,'V06':bool(capacity)}


def state_checks(model,state,log):
    try:
        values=state_values(model,state);w=state['world']
        active={'V04':bool(w['grants']),'V05':bool(w['materials']),
                'V06':any(w['occupancy'].values()) or bool(w['reservations']) or bool(w['commit_records'])}
        for pid,value in values.items():record(state,pid,value,log,active[pid])
    except (KeyError,TypeError,ValueError):
        for pid in ('V04','V05','V06'):record(state,pid,None,log)


def response_tick(model,state,log):
    window=model.data['queries'].get('response_window_ticks')
    if window is None:return
    for key,t in state['tasks'].items():
        accepted=t.get('accepted_tick')
        if accepted is None:continue
        state['acceptances'].setdefault(key,accepted)
        state['trigger_ticks'].setdefault('V10b',state['tick'])
        response=t['phase'] in ('succeeded','failed','cancelled') or (t['phase']=='attention' and
                    all(state['world']['grants'].get(r)==key for r in t['claims']))
        if response:state['responses'].setdefault(key,state['tick'])
        elif state['tick']>=accepted+window:
            state['response_violations'].setdefault(key,dict(accepted_at=accepted,deadline=accepted+window,tick=state['tick']))
            record(state,'V10b',False,log,detail=dict(request=key,accepted_at=accepted,deadline=accepted+window))


def root_goal_value(model,state):
    from .expressions import goal,world_expr
    expression=model.data['task']['goal']
    value=world_expr(model,state,expression) if 'op' in expression else goal(model,state)
    return all3([value,not state['world']['grants'],world_expr(model,state,{'op':'no_active_requests'})])


def root_goal(model,state):
    return root_goal_value(model,state) is True
