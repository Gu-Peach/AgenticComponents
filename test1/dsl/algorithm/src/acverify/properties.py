"""Independent task obligations, protocol monitors and accounting invariants."""
from .expressions import goal, owner

IDS=['V01','V02','V03','V04','V05','V06','V07','V08','V09','V10a','V10b']


def invariant_violations(model,state):
    bad=set(state.get('violations',[]));w=state['world'];grants=list(w['grants'].items())
    for i,(r,who) in enumerate(grants):
        for r2,who2 in grants[i+1:]:
            if who!=who2 and (r==r2 or frozenset((r,r2)) in model.conflicts):bad.add('V04')
    for mid,m in w['materials'].items():
        locations=[loc for loc,items in w['occupancy'].items() for value in items if value==mid]
        if m['region']=='unspawned':
            if locations:bad.add('V05')
        elif len(locations)!=1 or owner(model,locations[0])!=m['holder']:bad.add('V05')
    for loc,items in w['occupancy'].items():
        reserved=sum(r['target']==loc for r in w['reservations'].values())
        if len(items)+reserved>model.locations[loc]['capacity']:bad.add('V06')
    for dev,d in model.devices.items():
        count=sum(len(items) for loc,items in w['occupancy'].items() if owner(model,loc)==dev)
        count+=sum(owner(model,r['target'])==dev for r in w['reservations'].values())
        if count>d['parameters']['capacity']:bad.add('V06')
    for t in state['tasks'].values():
        if t['phase']=='attention' and t.get('claims') and any(w['grants'].get(r)!=t['key'] for r in t['claims']):bad.add('V08')
        response=t['phase'] in ('succeeded','failed','cancelled') or (t['phase']=='attention' and all(w['grants'].get(r)==t['key'] for r in t.get('claims',[])))
        if t.get('accepted') and not response:
            window=model.data['queries'].get('response_window_ticks',1800)
            if state['tick']-t['accepted_tick']>=window:bad.add('V10b')
    if state['outcome']=='succeeded' and not goal(model,state):bad.add('V09')
    return sorted(bad)


def edge_properties(events):
    bad=set();triggers=set()
    for e in events:
        kind=e['kind']
        if kind=='capture':
            triggers.add('V01')
            if not e['valid']:bad.add('V01')
        if kind=='feedback':
            triggers.add('V02')
            if not e['valid']:bad.add('V02')
            if e['event']=='accepted':triggers.add('V10b')
        if kind=='condition_read':triggers.add('V03')
        if kind=='control_succeeded':
            triggers.add('V07')
            if not(e['ack'] and e['actual_stopped']):bad.add('V07')
        if kind=='root_succeeded':triggers.add('V09')
    return bad,triggers


def property_ir(model):
    declared={x['id']:x for x in model.data['properties']['properties']}
    return [{'id':pid,'kind':'reachability' if pid=='V10a' else 'bounded_response' if pid=='V10b' else 'safety',
             'applicable':declared.get(pid,{}).get('applicable',True),
             'source':{'file':'shared/properties/catalog.json','property':pid},
             'scope':'generated controller and explicit symbolic plant/environment',
             'construction_check':pid in ('V02','V03','V07'),
             'response_window_ticks':model.data['queries'].get('response_window_ticks',1800) if pid=='V10b' else None} for pid in IDS]
