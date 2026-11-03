"""Small proof kernel for mandatory guards and an immutable initial blocker.

Rules refer to the frozen P2 semantics, not to answers from any tested solver.
They do not establish geometry or refinement of another runtime.
"""
from reference.common import canonical
from reference.state import world
from reference.properties import goal_value
from .evidence_check import BadEvidence,require
from .policy import check_kernel


def terminal(body,first=False):
    while body[0]=='seq':body=body[2] if first else body[-1]
    return body


def flatten(expression):
    if expression['op']=='all':return [a for e in expression['args'] for a in flatten(e)]
    require(expression['op'] not in ('any','not'),'Non-conjunctive goal/guard unsupported by this rule')
    return [expression]


def atoms(d,expression,seen=()):
    kind=expression[0]
    if kind=='condition':
        require(expression[1] not in seen,'Cyclic condition')
        return atoms(d,d.conditions[expression[1]],seen+(expression[1],))
    if kind=='all':return [a for e in expression[1:] for a in atoms(d,e,seen)]
    require(kind=='is' and expression[-1]=='true','Only positive conjunctions supported')
    r=expression[1];require(r[0]=='observation','Unknown condition source')
    alias=r[1];name=r[2][1];qual={q[0]:q[1] for q in r[3:]}
    if alias=='world':return flatten(d.env['observation_definitions'][name])
    dev=d.env['bindings'][alias]['id']
    if name=='surface_stopped':return [{'op':'drive_stopped','device':dev}]
    if name=='both_tools_empty':return [{'op':'tools_empty'}]
    require('request' in qual and qual['request'] in d.actions,'Missing request binding')
    action=d.actions[qual['request']];mid=d.env['bindings'][qual.get('subject','material')]['id']
    target=action['args'].get('target',action['device']+'.exit' if action['model']['id'] in ('transport@0.1','circulate@0.1') else action['args'].get('location'))
    if name=='subject_at_exit':
        if target!=dev+'.exit' or action['args'].get('material')!=mid:return [{'op':'never_true'}]
        return [{'op':'at','material':mid,'location':dev+'.exit'}]
    require(action['args'].get('material')==mid,'Subject/request mismatch needs a separate mapping proof')
    require(target in d.locations,'Unknown target')
    if name=='holder_matches_target':return [{'op':'holder','material':mid,'device':d.locations[target]['owner']}]
    if name=='supported_at_target':return [{'op':'at','material':mid,'location':target},{'op':'supported','material':mid,'location':target}]
    raise BadEvidence('Unsupported observation')


def derive(model,rule):
    check_kernel(model)
    d=model.d;last=terminal(d.body);first=terminal(d.body,True)
    if rule=='mandatory_final_guard_contradiction':
        require(last[0]=='await','No mandatory terminal await')
        terms=atoms(d,last[2]);locations={};impossible=False
        for a in terms:
            if a['op']=='never_true':impossible=True
            if a['op']=='at':
                if a['material'] in locations and locations[a['material']]!=a['location']:impossible=True
                locations[a['material']]=a['location']
        require(impossible,'No contradictory guard')
        return {'rule':rule,'node':last[1],'premises':{'same_snapshot':True,'mandatory_final_node':True},
                'conclusions':{'V09':'HOLDS','V10a':'UNREACHABLE'},'root_success_impossible':True,
                'trigger_facts':{'V09':'UNREACHABLE','V10a':'UNREACHABLE'}}
    if rule=='final_guard_entails_goal':
        require(not d.profile['events'],'External goal stability not established')
        require(last[0]=='await' and 'op' in d.task['goal'],'Goal/terminal shape not supported')
        have={canonical(t) for t in atoms(d,last[2])}
        required=flatten(d.task['goal'])+[{'op':'no_grants'},{'op':'no_active_requests'}]
        require(all(canonical(t) in have for t in required),'Guard does not entail every goal/cleanup atom')
        return {'rule':rule,'node':last[1],'premises':{'no_external_events':True,'seq_only_ancestors_to_final_await':True,
            'prior_subtrees_succeeded_no_remaining_physical_work':True},'conclusions':{'V09':'HOLDS'},
            'root_success_impossible':False,'trigger_facts':{}}
    if rule=='immutable_initial_gate':
        require(not d.profile['events'],'Initial facts can be changed by external events')
        require(first[0]=='await','First effectful node is not await')
        terms=atoms(d,first[2]);blocking=[];p=model.initial['plant']
        for t in terms:
            try:
                if t['op']=='never_true' or goal_value(world(model.initial),t) is False:blocking.append(t)
            except (KeyError,ValueError,TypeError):continue
        require(blocking,'No known false immutable atom')
        require(not p['grants'] and not p['reservations'] and not model.initial['mail'],'Initial live work not excluded')
        require(not model.initial['violations'] and not model.initial['uncovered_properties'],'Initial invariants not checked')
        conclusions={p:'HOLDS' for p in ('V01','V02','V04','V05','V06','V07','V08','V09','V10b')}
        conclusions['V10a']='UNREACHABLE'
        trigger={p:'UNREACHABLE' for p in conclusions}
        for pid in ('V05','V06'):
            trigger[pid]='REACHABLE' if pid in model.initial['triggered'] else 'UNREACHABLE'
        return {'rule':rule,'node':first[1],'blocking_atoms':blocking,
                'premises':{'no_external_events':True,'no_prior_actor_activation':True,'world_unchanged_until_abort':True},
                'conclusions':conclusions,'root_success_impossible':True,'trigger_facts':trigger}
    raise BadEvidence('Unknown proof rule')


RULES=('mandatory_final_guard_contradiction','final_guard_entails_goal','immutable_initial_gate')


def candidates(model):
    result=[]
    for rule in RULES:
        try:result.append({'kind':'logical_certificate/0.1','model_digest':model.model_digest,'derivation':derive(model,rule)})
        except (BadEvidence,KeyError,TypeError):continue
    return result


def check(model,payload):
    require(payload['model_digest']==model.model_digest,'Logical certificate model differs')
    rule=payload['derivation']['rule'];expected=derive(model,rule)
    require(expected==payload['derivation'],'Certificate premises or conclusion altered')
    return {'kind':'checked_logic','model_digest':model.model_digest,'derivation':expected}


def verdict(query,checked):
    d=checked['derivation'];pid=query['property_id'];value=d['conclusions'].get(pid)
    if value is None:return {'verdict':None,'reason':'RULE_DOES_NOT_PROVE_PROPERTY'}
    if pid=='V10b' and query.get('covered_trigger_cutoff',query['bound_ticks'])<1:
        return {'verdict':None,'reason':'NO_FULL_RESPONSE_WINDOW'}
    trigger=d['trigger_facts'].get(pid,'UNKNOWN')
    return {'verdict':value,'scope':'structural_reference_model_proof',
       'trigger_reachability':trigger,'vacuous':False if pid=='V10a' else True if trigger=='UNREACHABLE' else False if trigger=='REACHABLE' else None,
       'rule':d['rule'],'trigger_basis':'initial_invariant_domain' if pid in ('V05','V06') else 'structural_proof'}
