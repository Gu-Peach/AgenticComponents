"""Certificates for an over-approximation of successful sequential effects.

Every branch is retained and every await is erased. Parallel nodes and external
events are refused. No result from this module establishes positive reachability.
The checker has its own derivation walk; atomic effects use the frozen P2 plant.
"""
from reference.common import clone,digest,key
from reference.plant import effect,release
from reference.properties import goal_value
from .evidence_check import require,BadEvidence
from .policy import check_kernel


def premises(model):
    check_kernel(model)
    d=model.d
    require(not d.profile['events'],'External events not covered by the success projection')
    require(not any(n[0]=='par' for n in d.nodes.values()),'Parallel success projection not admitted')
    require(set(d.profile['faults']) <= {'delayed_feedback','duplicate_same_request','old_request_feedback',
           'provider_restart','hold_permission_loss','missing_stop_confirmation'},'Unsupported fault effect')
    # The admitted goal language reads physical/ledger results, not permit or
    # communication metadata. A late permission loss can leave these unobserved
    # fields different without changing the successful goal projection.
    return {'no_external_events':True,'no_parallel_nodes':True,'guards_erased':True,'all_branch_arms_retained':True,
            'success_executes_all_linear_phases':True,'failure_does_not_resume_root_success':True,
            'goal_projection':'material pose/support/holder/held; drives/tools/clamps/index/history/cycles; fixed world facts; cleanup',
            'unobserved_fault_fields':['permit','provider_epoch'],'kernel_model_digest':model.model_digest}


def atomic(model,plant,node,path):
    k=key(node[1],path);state={'plant':clone(plant),'tokens':{k:{'node':node[1]}}}
    for phase in model.d.actions[node[1]]['model']['phases']:
        for call in phase['effects']:effect(model.d,state,k,call)
    release(state,k)
    return state['plant']


def scope(model,plant,node,path,enter):
    p=clone(plant);c=model.d.controls[model.d.env['controls'][node[2]]];k=key(node[1],path)
    if enter:
        p['grants'][c['writer']]=k;p['devices'][c['owner']].update(drive='moving',run_command=True)
    else:
        p['grants']={r:who for r,who in p['grants'].items() if who!=k}
        p['devices'][c['owner']].update(drive='stopped',run_command=False)
    return p


def record_id(node,path,state_id):return digest([node[1],path,state_id])


def generate(model,max_records=10000,max_states=2048):
    assumptions=premises(model);states={};records={}
    def save(s):
        ident=digest(s);states.setdefault(ident,clone(s))
        require(len(states)<=max_states,'Projection state limit')
        return ident
    def derive(n,path,before):
        rid=record_id(n,path,before)
        if rid in records:return records[rid]['after']
        require(len(records)<max_records,'Projection record limit')
        p=states[before];kind=n[0];deps=[]
        def child(c,cp,sp):
            result=derive(c,cp,sp);deps.append(record_id(c,cp,sp));return result
        if kind=='invoke':after=[save(atomic(model,p,n,path))]
        elif kind in ('await','delay'):after=[before]
        elif kind=='fail':after=[]
        elif kind in ('seq','repeat'):
            after=[before]
            children=[(c,path) for c in n[2:]] if kind=='seq' else [(n[3],path+[i]) for i in range(int(n[2]))]
            for c,cp in children:after=sorted({v for sp in after for v in child(c,cp,sp)})
        elif kind=='branch':after=sorted({v for arm in n[4:] for v in child(arm[-1],path,before)})
        elif kind=='with-control':
            entered=save(scope(model,p,n,path,True))
            after=sorted({save(scope(model,states[sp],n,path,False)) for sp in child(n[4],path,entered)})
        else:raise BadEvidence('Unsupported projection node')
        records[rid]={'node':n[1],'path':path,'before':before,'after':after,'dependencies':deps,'rule':kind}
        return after
    start=save(model.initial['plant']);final=derive(model.d.body,[],start)
    return {'kind':'success_effect_certificate/0.1','model_digest':model.model_digest,'premises':assumptions,
            'initial':start,'final':final,'states':states,'records':records}


def check(model,payload,max_records=10000,max_states=2048):
    require(payload['model_digest']==model.model_digest,'Projection model differs')
    require(payload['premises']==premises(model),'Projection prerequisites changed')
    states=payload['states'];records=payload['records'];checked={};active=set()
    require(len(states)<=max_states and len(records)<=max_records,'Certificate exceeds checker limits')
    for ident,s in states.items():require(digest(s)==ident,'Altered projected state')
    initial=digest(model.initial['plant'])
    require(payload['initial']==initial and states[initial]==model.initial['plant'],'Wrong initial projection')
    def verify(n,path,before):
        rid=record_id(n,path,before)
        require(rid not in active,'Cyclic derivation')
        if rid in checked:return checked[rid]
        require(rid in records,'Missing derivation arm')
        r=records[rid]
        require(r['node']==n[1] and r['path']==path and r['before']==before and r['rule']==n[0],'Wrong derivation rule')
        active.add(rid);deps=[];p=states[before]
        def need_state(value):
            ident=digest(value);require(ident in states and states[ident]==value,'Missing/mutated intermediate state');return ident
        def use(c,cp,sp):
            result=verify(c,cp,sp);deps.append(record_id(c,cp,sp));return result
        kind=n[0]
        if kind=='invoke':result=[need_state(atomic(model,p,n,path))]
        elif kind=='fail':result=[]
        elif kind in ('await','delay'):result=[before]
        elif kind=='branch':
            possible=set()
            for arm in n[4:]:possible.update(use(arm[-1],path,before))
            result=sorted(possible)
        elif kind=='with-control':
            sp=need_state(scope(model,p,n,path,True));possible=set()
            for child_post in use(n[4],path,sp):possible.add(need_state(scope(model,states[child_post],n,path,False)))
            result=sorted(possible)
        elif kind in ('seq','repeat'):
            result=[before]
            sequence=[(n[3],path+[i]) for i in range(int(n[2]))] if kind=='repeat' else [(c,path) for c in n[2:]]
            for child,cp in sequence:
                possible=set()
                for sp in result:possible.update(use(child,cp,sp))
                result=sorted(possible)
        else:raise BadEvidence('Unknown proof rule')
        require(result==r['after'] and deps==r['dependencies'],'Incomplete or forged derivation')
        active.remove(rid);checked[rid]=result;return result
    final=verify(model.d.body,[],initial)
    require(final==payload['final'],'Root poststates differ')
    require(len(checked)==len(records),'Unreachable derivation records')
    goals=[]
    for ident in final:
        p=states[ident]
        w={'materials':p['materials'],'devices':p['devices'],'external':p['external'],
           'grants':list(p['grants'].items()),'active_requests':[]}
        value=goal_value(w,model.d.task['goal'])
        if p['grants']:value=False
        goals.append(value)
    conclusions={}
    if all(g is True for g in goals):conclusions['V09']='HOLDS'
    if all(g is False for g in goals):conclusions['V10a']='UNREACHABLE'
    return {'kind':'checked_success_effects','model_digest':model.model_digest,'conclusions':conclusions,
            'empty_success_overapproximation':not final,'poststates':len(final),'records_checked':len(checked),
            'scope':'Universal successful-goal projection only; no positive reachability or timing guarantee'}


def verdict(query,checked):
    pid=query['property_id'];value=checked['conclusions'].get(pid)
    if value is None:return {'verdict':None,'reason':'PROJECTION_DOES_NOT_DECIDE_QUERY'}
    empty=checked['empty_success_overapproximation']
    return {'verdict':value,'scope':'successful_goal_overapproximation','vacuous':False if pid=='V10a' else True if empty else None,
            'trigger_reachability':'UNREACHABLE' if pid=='V10a' or empty else 'UNKNOWN'}
