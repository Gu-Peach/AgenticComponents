"""Exact removal of inactive activation fields; no plant/failure-state abstraction."""
import copy

KEEP={'key','node','kind','phase','path','parent','scope','children'}


def compact(state, copier=copy.deepcopy):
    state=copier(state)
    for key,t in state['tasks'].items():
        if t['phase'] in ('succeeded','failed','cancelled'):
            state['tasks'][key]={k:v for k,v in t.items() if k in KEEP}
    return state


def dependencies(model):
    result={}
    for node,action in model.actions.items():
        contract=model.models[action['model_ref']]
        result[node]={'devices':[action['device']], 'arguments':action['arguments'],
                      'reads':contract['footprint']['read_predicates'],'writes':contract['footprint']['write_effects'],
                      'resources':contract['resource_claims']}
    return result


def clock_key(state, copier=copy.deepcopy, already_compact=False):
    """Time-translation quotient for models without absolute-time external events.

    Keep every live deadline age and arbitration order. Absolute query depth is
    retained by BFS's earliest representative, not by the quotient key.
    """
    value=copier(state) if already_compact else compact(state, copier);now=value.pop('tick')
    live=[t for t in value['tasks'].values() if t['phase'] not in ('succeeded','failed','cancelled','attention')]
    order={e:i for i,e in enumerate(sorted({t['eligible'] for t in live}))}
    time_fields={'created','submit','execute_start','stage_start','stop_start','start','accepted_tick'}
    for t in value['tasks'].values():
        phase=t['phase'];kind=t['kind'];needed=set()
        if phase in ('new','gate') or kind in ('await','delay') or (kind=='branch' and phase=='choosing'):needed.add('created')
        if phase=='requesting':needed.add('submit')
        if phase in ('running','result_wait'):needed.add('execute_start')
        if t.get('plant_active'):needed.add('stage_start')
        if phase in ('stopping','exit_wait'):needed.add('stop_start')
        if phase=='enter_wait':needed.add('start')
        if t.get('accepted') and phase not in ('succeeded','failed','cancelled','attention'):needed.add('accepted_tick')
        for key in time_fields:
            if key in t:
                if key in needed:t[key]=now-t[key]
                else:t.pop(key)
        if 'eligible' in t:
            if phase in ('succeeded','failed','cancelled','attention'):t.pop('eligible')
            else:
                eligible=t['eligible'];t['eligible']=[eligible<=now,max(0,eligible-now),order[eligible]]
        if t.get('pending_result'):
            for key in ('sample_tick','min_due','max_due'):t['pending_result'][key]-=now
    for packet in value['inbox']:
        for key in ('sample_tick','min_due','max_due'):packet[key]-=now
    return value
