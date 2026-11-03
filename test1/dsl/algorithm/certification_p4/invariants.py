"""Conditional inductive rules for the reviewed reference templates.

These are construction/preservation proofs, not evidence that arbitrary PLC code
or real equipment obeys the templates. Per-instance premises remain mandatory.
"""
import ast
from functools import lru_cache
import json
from pathlib import Path
from reference.common import digest
from reference.plant import conflicts
from certification.policy import check_kernel
from certification.evidence_check import require,BadEvidence

POLICY=Path(__file__).parent/'contract-policy.json'
SITES={
 'V01':['plant.py:predicate','transition.py:plant','environment.py:external','control.py:invoke'],
 'V02':['channel.py:emit','channel.py:deliver','control.py:invoke','control.py:finish','state.py:activate','environment.py:faults'],
 'V03':['channel.py:deliver','observations.py:condition','properties.py:evidence_valid','properties.py:goal_value','monitors.py:record'],
 'V04':['state.py:initial','control.py:invoke','control.py:control_scope','plant.py:authorized','plant.py:release'],
 'V05':['state.py:initial','plant.py:effect','plant.py:can_release','environment.py:external','control.py:stop'],
 'V06':['state.py:initial','plant.py:available','plant.py:reserve','plant.py:effect','environment.py:external'],
 'V07':['control.py:control_scope','control.py:stop','channel.py:deliver','transition.py:plant'],
 'V08':['control.py:invoke','control.py:control_scope','control.py:stop','control.py:scan','plant.py:release','state.py:retire']}


@lru_cache(maxsize=16)
def anchors(pid):
    from reference import transition
    root=Path(transition.__file__).parent;result={}
    for location in SITES[pid]:
        file,name=location.split(':');tree=ast.parse((root/file).read_text(encoding='utf8'))
        functions=[n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name]
        require(len(functions)==1,'Ambiguous proof site')
        result[location]=digest(ast.dump(functions[0],include_attributes=False))
    return result


def catalog(model):
    check_kernel(model);d=model.d;policy=json.loads(POLICY.read_text(encoding='utf8'))
    for a in d.actions.values():require(digest(a['model'])==policy['models'].get(a['model']['id']),'Unreviewed capability template')
    for c in d.controls.values():require(digest(d.models[c['contract_ref']])==policy['models'].get(c['contract_ref']),'Unreviewed control template')
    require(not model.initial['violations'] and not model.initial['uncovered_properties'],'Initial invariants not established')
    require(bool(model.initial['plant']['materials']),'Empty fallback-subject domain not covered')
    p=model.initial['plant'];mids=set(p['materials'])
    for dev in p['devices'].values():
        require(type(dev['operation_history']) is list and type(dev['cycle_counts']) is dict,'Untyped history')
        require(all(type(v) is int and v>=0 for v in dev['cycle_counts'].values()),'Untyped cycle count')
        require(all(r['material'] in mids and type(r['request']) is str for r in dev['operation_history']),'Untyped operation record')
    def expression(e):
        op=e['op']
        if op in ('all','any'):
            require(type(e['args']) is list,'Untyped formula list')
            for child in e['args']:expression(child)
        elif op=='not':expression(e['arg'])
        if 'material' in e:require(e['material'] in mids,'Unknown formula material')
        if 'device' in e:require(e['device'] in p['devices'],'Unknown formula device')
        if 'location' in e:require(e['location'] in d.locations,'Unknown formula location')
        if op in ('operation_count','cycle_count'):require(type(e['count']) is int and e['count']>=0,'Untyped count predicate')
        if op=='index_is':require(type(e['value']) is int,'Untyped index predicate')
        if op=='external':require(e['key'] in p['external'],'Unknown external fact')
    for e in d.env.get('observation_definitions',{}).values():expression(e)
    if 'op' in d.task['goal']:expression(d.task['goal'])
    for fact in p['external'].values():
        require(fact['value'] is None or type(fact['value']) is bool,'Untyped external value')
        require(fact['valid'] is None or type(fact['valid']) is bool,'Untyped external validity')
    for e in d.profile['events']:
        if e['kind']=='set_external':
            require(e['fact'] in p['external'] and (e['value'] is None or type(e['value']) is bool),'Untyped external update')
            require(e['valid'] is None or type(e['valid']) is bool,'Untyped external validity update')
        else:require(e['set_fact'] in p['external'],'Unknown replacement fact')
    return policy['id']


def resolved_claims(d,a):
    result=[]
    for r in a['model']['resource_claims']:
        if r.startswith('delegate:') or r=='target.capacity':continue
        if r=='material.claim':result.append(a['args']['material']+'.claim')
        elif r in ('source.zone','target.zone'):result.append(d.locations[a['args'][r.split('.')[0]]]['zone_ref'])
        elif r.startswith('device.'):result.append(a['device']+'.'+r.split('.')[1])
        else:raise BadEvidence('Unknown resource template')
    return result


def material_domains(model):
    d=model.d
    for a in d.actions.values():
        kind=a['model']['id'];dev=a['device']
        if kind=='transfer@0.1':require(dev+'.tool' in d.locations and d.locations[dev+'.tool']['owner']==dev,'Tool owner mismatch')
        if kind in ('transport@0.1','circulate@0.1'):
            for suffix in ('.entry','.exit'):require(dev+suffix in d.locations and d.locations[dev+suffix]['owner']==dev,'Conveyor location owner mismatch')
    return {'registered_tool_and_transport_owners':True,'material_writers_claim_subject':True,
            'external_moves_wait_for_active_users_and_held_materials':True}


def drive_fences(model):
    d=model.d;checks=[]
    for a in d.actions.values():
        if a['model']['id']!='transfer@0.1':continue
        src=a['args']['source'];owner=d.locations[src]['owner'];zone=d.locations[src]['zone_ref']
        for c in d.controls.values():
            if c['owner']==owner:
                require(conflicts(d,zone,c['writer']),'Source writer can change drive without conflicting source lease')
                checks.append([zone,c['writer']])
        for mover in d.actions.values():
            if mover['device']==owner and mover['model']['id'] in ('index@0.1','lift@0.1'):
                require(any(conflicts(d,zone,r) for r in resolved_claims(d,mover)),'Source axis is not fenced')
    return sorted(checks)


def control_fences(model):
    d=model.d;by_owner={}
    for c in d.controls.values():
        require(c['owner'] not in by_owner or by_owner[c['owner']]==c['writer'],'Two unrelated writers for one physical drive')
        by_owner[c['owner']]=c['writer']
        for a in d.actions.values():
            if a['device']==c['owner'] and a['model']['id'] in ('index@0.1','lift@0.1'):
                require(any(conflicts(d,c['writer'],r) for r in resolved_claims(d,a)),'Concurrent axis can invalidate stop observation')
    return by_owner


def capacity_domains(model):
    d=model.d;p=model.initial['plant'];actors={a['device'] for a in d.actions.values() if a['model']['id']=='transfer@0.1'}
    for dev in actors:
        locs=[loc for loc,v in d.locations.items() if v['owner']==dev]
        require(locs==[dev+'.tool'] or set(locs)=={dev+'.tool'},'Transfer actor has additional capacity-bearing locations')
        require(not p['ledger'][dev+'.tool'],'Transfer tool initially occupied')
        for a in d.actions.values():
            if 'target' in a['args']:require(d.locations[a['args']['target']]['owner']!=dev,'An action may fill another transfer tool')
        for e in d.profile['events']:
            if e['kind']=='replace_carrier':require(d.locations[e['destination']]['owner']!=dev,'External source may fill transfer tool')
    for a in d.actions.values():
        if a['model']['id'] in ('transport@0.1','circulate@0.1'):
            dev=a['device']
            for suffix in ('.entry','.exit'):
                require(d.locations[dev+suffix]['capacity']>=d.devices[dev]['parameters']['capacity'],'Unreserved conveyor move can overfill local zone')
    for e in d.profile['events']:
        if e['kind']=='replace_carrier':
            loc=d.locations[e['destination']]
            require(loc['capacity']>=d.devices[loc['owner']]['parameters']['capacity'],'External destination local reservation bound is not implied by owner bound')
    return {'exclusive_intermediate_tools':sorted(actors),'transport_and_external_local_bounds_covered_by_group_bounds':True,
            'effective_commit_once_per_activation':True}


def derive(model,pid):
    require(pid in SITES,'Unsupported invariant rule');policy=catalog(model);d=model.d
    premises={'contract_policy':policy,'initial_state_checked':True,'source_sites':anchors(pid)}
    if pid in ('V01','V05','V06'):premises.update(material_domains(model))
    if pid=='V01':premises['source_drive_fences']=drive_fences(model)
    if pid=='V06':premises.update(capacity_domains(model))
    if pid=='V07':premises['unique_drive_writers']=control_fences(model)
    if pid=='V03':
        premises.update(channel_consumption_dominated_by_same_validator=True,
            state_fact_values_boolean_or_unknown=True,unknown_facts_not_consumed=True,
            current_snapshot_sampling_does_not_retimestamp_packets=True)
    kinds={n[0] for n in d.nodes.values()};trigger='UNKNOWN'
    if pid in ('V05','V06') and pid in model.initial['triggered']:trigger='REACHABLE'
    if pid=='V01' and not any(a['model']['id']=='transfer@0.1' for a in d.actions.values()):trigger='UNREACHABLE'
    if pid=='V02' and not d.actions:trigger='UNREACHABLE'
    if pid=='V07' and 'with-control' not in kinds:trigger='UNREACHABLE'
    if pid in ('V04','V08') and not d.actions and 'with-control' not in kinds:trigger='UNREACHABLE'
    return {'property':pid,'premises':premises,'conclusion':'HOLDS','trigger_fact':trigger,
            'proof_class':'construction' if pid in ('V02','V03','V07') else 'conditional_inductive_preservation',
            'scope':'reviewed symbolic kernel/templates and checked instance conditions; not arbitrary PLC or equipment'}


def generate(model,pid):return {'kind':'p4_invariant/0.1','model_digest':model.model_digest,'derivation':derive(model,pid)}
def check(model,payload):
    require(payload['model_digest']==model.model_digest,'Invariant model differs')
    expected=derive(model,payload['derivation']['property']);require(expected==payload['derivation'],'Altered invariant derivation')
    return expected
def verdict(query,checked):
    if query['property_id']!=checked['property']:return {'verdict':None,'reason':'OTHER_PROPERTY'}
    t=checked['trigger_fact']
    return {'verdict':'HOLDS','scope':checked['scope'],'proof_class':checked['proof_class'],
            'vacuous':True if t=='UNREACHABLE' else False if t=='REACHABLE' else None,'trigger_reachability':t}
