"""Property declarations and state obligations for the v0.3 engine."""
from .monitor import state_values

IDS=['V01','V02','V03','V04','V05','V06','V07','V08','V09','V10a','V10b']


def invariant_violations(model,state):
    bad=set(state['violations'])
    bad.update(pid for pid,value in state_values(model,state).items() if value is False)
    return sorted(bad)


def edge_properties(events):
    return ({e['property'] for e in events if e['kind']=='obligation_violation'},set())


def property_ir(model):
    declared={x['id']:x for x in model.data['properties']['properties']}
    return [dict(id=pid,applicable=declared.get(pid,{}).get('applicable',True),
        kind='reachability' if pid=='V10a' else 'bounded_response' if pid=='V10b' else 'safety',
        construction_check=pid in ('V02','V03','V07'),scope='acverify-six-phase/0.3') for pid in IDS]
