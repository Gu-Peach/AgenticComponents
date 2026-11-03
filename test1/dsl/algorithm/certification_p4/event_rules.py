"""Frame rules for explicitly declared external updates."""
from reference.common import canonical
from reference.properties import goal_value
from reference.state import world
from certification.logic import terminal,atoms,flatten
from certification.evidence_check import require
from .invariants import catalog


def atom_writes(d,atom,event):
    op=atom['op']
    if event['kind']=='set_external':return op=='external' and atom['key']==event['fact']
    if event['kind']=='replace_carrier':
        return op in ('at','holder','supported') and atom['material'] in event['materials'] or op=='external' and atom['key']==event['set_fact']
    return True


def post_value(d,atom,event):
    if event['kind']=='set_external':return event['value'] if event['valid'] is True else None
    if atom['op']=='external':return True
    value=d.locations[event['destination']]['owner'] if atom['op']=='holder' else event['destination']
    return value==atom['device' if atom['op']=='holder' else 'location']


def preserve(d,atom,value,event):
    return not atom_writes(d,atom,event) or post_value(d,atom,event) is value


def derive(model,rule):
    catalog(model);d=model.d
    if rule=='no_request_program':
        require(not any(n[0] in ('invoke','with-control') for n in d.nodes.values()),'Request-bearing node exists')
        return {'rule':rule,'node_kinds':sorted({n[0] for n in d.nodes.values()}),
                'conclusions':{'V10b':'HOLDS'},'trigger_facts':{'V10b':'UNREACHABLE'}}
    if rule=='external_final_guard':
        node=terminal(d.body);require(node[0]=='await' and 'op' in d.task['goal'],'No supported final guard')
        have={canonical(a) for a in atoms(d,node[2])};wanted=flatten(d.task['goal'])+[{'op':'no_grants'},{'op':'no_active_requests'}]
        require(all(canonical(a) in have for a in wanted),'Guard misses goal/cleanup')
        require(all(preserve(d,a,True,e) for a in wanted for e in d.profile['events']),'External update may falsify final goal')
        return {'rule':rule,'node':node[1],'goal_atoms':wanted,'events':d.profile['events'],
                'conclusions':{'V09':'HOLDS'},'trigger_facts':{}}
    if rule=='external_initial_blocker':
        node=terminal(d.body,True);require(node[0]=='await','No initial await')
        false_atoms=[]
        for a in atoms(d,node[2]):
            try:
                if a['op']=='never_true' or (goal_value(world(model.initial),a) is False and all(preserve(d,a,False,e) for e in d.profile['events'])):
                    false_atoms.append(a)
            except (KeyError,TypeError,ValueError):continue
        require(false_atoms,'No preserved false atom')
        conclusions={p:'HOLDS' for p in ('V01','V02','V04','V07','V08','V09','V10b')};conclusions['V10a']='UNREACHABLE'
        return {'rule':rule,'node':node[1],'blocking_atoms':false_atoms,'events':d.profile['events'],
                'conclusions':conclusions,'trigger_facts':{p:'UNREACHABLE' for p in conclusions}}
    raise ValueError('Unknown event rule')


def generate(model,rule):return {'kind':'p4_event_frame/0.1','model_digest':model.model_digest,'derivation':derive(model,rule)}
def check(model,payload):
    require(payload['model_digest']==model.model_digest,'Event proof model differs')
    expected=derive(model,payload['derivation']['rule']);require(expected==payload['derivation'],'Event footprint/claim changed');return expected
def verdict(query,checked):
    pid=query['property_id'];value=checked['conclusions'].get(pid)
    if value is None:return {'verdict':None,'reason':'OTHER_PROPERTY'}
    if pid=='V10b' and query.get('covered_trigger_cutoff',0)<1:return {'verdict':None,'reason':'NO_FULL_RESPONSE_WINDOW'}
    t=checked['trigger_facts'].get(pid,'UNKNOWN')
    return {'verdict':value,'scope':'external_event_frame_proof','proof_class':'request_absence' if checked['rule']=='no_request_program' else 'event_stability',
            'trigger_reachability':t,'vacuous':False if pid=='V10a' else True if t=='UNREACHABLE' else None}
