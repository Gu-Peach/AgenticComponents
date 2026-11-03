"""Typed world predicates and three-valued process observations."""
from .core import all3, any3, activation, VerificationError


def owner(model,loc):return model.locations[loc]['owner']
def material(world,mid):return world['materials'][mid]
def drive(world,dev):return world['devices'][dev]['drive']


def world_expr(model,state,expr):
    w=state['world'];op=expr['op'];m=expr.get('material');d=expr.get('device');loc=expr.get('location')
    if op=='all':return all3(world_expr(model,state,x) for x in expr['args'])
    if op=='at':return material(w,m)['region']==loc
    if op=='holder':return material(w,m)['holder']==d
    if op=='supported':return material(w,m)['support']==loc
    if op=='drive_stopped':return drive(w,d)=='stopped'
    if op=='operation_count':return sum(x['material']==m for x in w['devices'][d]['operation_history'])>=expr['count']
    if op=='cycle_count':return w['devices'][d]['cycle_counts'].get(m,0)>=expr['count']
    if op=='index_is':return w['devices'][d]['actual_index']==expr['value']
    if op=='unclamped':return w['devices'][d]['clamped_material'] is None
    if op=='tools_empty':return all(x['held_material'] is None for x in w['devices'].values())
    if op=='drives_stopped':return all(x['drive']=='stopped' for x in w['devices'].values())
    if op=='no_active_requests':return not any(t['phase'] in ('requesting','running','result_wait','stopping','attention') and t['kind']=='invoke' for t in state['tasks'].values())
    if op=='no_grants':return not w['grants']
    if op=='external':
        value=w['external'].get(expr['key']);return value['value'] if value and value.get('valid') is True and type(value.get('value')) is bool else None
    raise VerificationError('UNSUPPORTED_MODEL','Unknown observation operator: '+op)


def goal(model,state):
    g=model.data['task']['goal']
    if 'op' in g:return world_expr(model,state,g) is True
    w=state['world'];m=w['materials'][g['material']]
    return (m['region']==g['region'] and m['holder']==g['holder'] and m['support']==g['support'] and
            m['held_by']==g['held_by'] and all(drive(w,d)==v for d,v in g['drives'].items()) and
            (not g['no_grants'] or not w['grants']) and
            (not g['no_active_request'] or world_expr(model,state,{'op':'no_active_requests'})))


def resolve_request(state,node_id,path):
    for size in range(len(path),-1,-1):
        key=activation(node_id,path[:size])
        if key in state['completed']:return state['completed'][key]
    return None


def process_condition(model,state,expr,path):
    kind=expr['kind']
    if kind=='ref':return process_condition(model,state,model.ir['conditions'][expr['condition_ref']],path)
    if kind=='all':return all3(process_condition(model,state,v,path) for v in expr['operands'])
    if kind=='any':return any3(process_condition(model,state,v,path) for v in expr['operands'])
    if kind=='not':
        value=process_condition(model,state,expr['operand'],path);return None if value is None else not value
    read=expr['read'];env=model.data['environment'];w=state['world']
    if read['source']!='observation':raise VerificationError('UNSUPPORTED_MODEL','Parameter/authorization read adapter not registered')
    if read['owner_ref']=='world':value=world_expr(model,state,env['observation_definitions'][read['key']])
    else:
        dev=env['bindings'][read['owner_ref']]['id'];key=read['key']
        mid=env['bindings'][read['subject_ref']]['id'] if 'subject_ref' in read else next(iter(w['materials']))
        record=resolve_request(state,read['request_node_ref'],path) if 'request_node_ref' in read else None
        if 'request_node_ref' in read and record is None:return None
        if key=='surface_stopped':value=drive(w,dev)=='stopped'
        elif key=='both_tools_empty':value=world_expr(model,state,{'op':'tools_empty'})
        elif key=='subject_at_exit':
            if record and (record['target']!=dev+'.exit' or record['material']!=mid):return None
            value=w['materials'][mid]['region']==dev+'.exit'
        elif key=='holder_matches_target':
            value=None if not record else w['materials'][mid]['holder']==owner(model,record['target'])
        elif key=='supported_at_target':
            value=None if not record else w['materials'][mid]['region']==record['target'] and w['materials'][mid]['support']==record['target']
        else:raise VerificationError('UNSUPPORTED_MODEL','Unknown observation: '+key)
    return None if value is None else value==expr['equals']['value']


def capacity_available(model,w,target,request=None):
    loc=model.locations[target];dev=loc['owner']
    local=len(w['occupancy'].get(target,[]));group=sum(len(v) for k,v in w['occupancy'].items() if owner(model,k)==dev)
    for key,r in w['reservations'].items():
        if key==request:continue
        local+=r['target']==target;group+=owner(model,r['target'])==dev
    return local<loc['capacity'] and group<model.devices[dev]['parameters']['capacity']


def predicate(model,state,task,call):
    w=state['world'];p=call['predicate'];args=task.get('args',{});dev=task.get('device')
    values=[]
    for value in call['args']:
        if value=='$device':values.append(dev)
        elif value=='$request':values.append(task['key'])
        elif isinstance(value,str) and value.startswith('$'):values.append(args[value[1:]])
        else:values.append(value)
    a=values
    if p=='source_contains':return material(w,a[0])['region']==a[1] and a[0] in w['occupancy'].get(a[1],[])
    if p=='source_unclamped':return w['devices'][owner(model,a[1])]['clamped_material']!=a[0]
    if p=='target_compatible':return material(w,a[0])['type'] in model.locations[a[1]]['accepts']
    if p=='target_capacity':return capacity_available(model,w,a[0],task['key'])
    if p=='tool_empty':return w['devices'][a[0]]['held_material'] is None
    if p in ('source_stationary','target_stationary'):return drive(w,owner(model,a[0]))=='stopped'
    if p=='interlock_valid':return w['devices'][a[0]]['permit']
    if p=='all_grants_valid':return all(w['grants'].get(r)==task['key'] for r in task['claims'])
    if p=='drive_stopped':return drive(w,a[0])=='stopped'
    if p=='subject_on_device':return owner(model,material(w,a[0])['region'])==a[1] and material(w,a[0])['holder']==a[1]
    if p=='drive_authorized':
        scope=task.get('scope')
        if scope not in state['tasks']:return False
        writer=model.controls[state['tasks'][scope]['control']]['writer']
        return w['grants'].get(writer)==scope and w['devices'][a[0]]['run_command'] and drive(w,a[0])=='moving'
    if p=='subject_at_exit':return material(w,a[0])['region']==a[1]+'.exit'
    if p=='result_matches':return task.get('accepted') and task.get('result_valid',False)
    if p=='transfer_committed':return task['key'] in w['committed'] and material(w,a[0])['holder']==owner(model,a[1])
    if p=='supported_at':return material(w,a[0])['region']==a[1] and material(w,a[0])['support']==a[1]
    if p=='at_location':return material(w,a[0])['region']==a[1]
    if p=='location_owned_by':return owner(model,a[0])==a[1]
    if p=='clamped':return w['devices'][a[1]]['clamped_material']==a[0]
    if p=='unclamped':return w['devices'][a[1]]['clamped_material'] is None
    if p=='access_closed':return w['devices'][a[0]]['access_closed']
    if p=='no_processing':return not any(t['key']!=task['key'] and t.get('device')==a[0] and t.get('model')=='process@0.1' and t['phase'] in ('requesting','running','result_wait','stopping','attention') for t in state['tasks'].values())
    if p=='operation_recorded':return any(x['material']==a[0] and x['request']==task['key'] for x in w['devices'][a[1]]['operation_history'])
    if p=='tools_clear':return not any(r==a[0]+'.zone' and o!=task['key'] for r,o in w['grants'].items())
    if p=='target_index_valid':return 0<=a[0]<model.devices[a[1]]['parameters']['index_count']
    if p=='axis_target_valid':return 0<=a[0]<model.devices[a[1]]['parameters']['level_count']
    if p=='index_reached':return w['devices'][a[1]]['actual_index']==a[0] and drive(w,a[1])=='stopped'
    if p=='level_reached':return w['devices'][a[1]]['actual_level']==a[0] and drive(w,a[1])=='stopped'
    if p=='material_unspawned':return material(w,a[0])['region']=='unspawned'
    raise VerificationError('UNSUPPORTED_MODEL','Unknown contract predicate: '+p)
