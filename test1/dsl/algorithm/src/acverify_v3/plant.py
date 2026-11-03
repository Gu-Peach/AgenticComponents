"""Contract effects. Physical region, support and business accounting stay separate."""
from .core import VerificationError
from .expressions import owner


def claims(model,task):
    args=task['args'];dev=task['device'];result=[]
    for template in model.models[task['model']]['resource_claims']:
        if template.startswith('delegate:') or template=='target.capacity':continue
        if template=='material.claim':result.append(args['material']+'.claim')
        elif template in ('source.zone','target.zone'):
            result.append(model.locations[args[template.split('.')[0]]]['zone_ref'])
        elif template.startswith('device.'):result.append(dev+'.'+template.split('.')[1])
        else:raise VerificationError('UNSUPPORTED_MODEL','Unregistered resource template: '+template)
    return sorted(set(result))


def can_claim(model,world,resources,request):
    return all(existing_owner==request or (r!=existing and frozenset((r,existing)) not in model.conflicts)
               for r in resources for existing,existing_owner in world['grants'].items())


def reserve(world,key,args):
    if 'target' in args:world['reservations'][key]={'target':args['target'],'material':args['material']}


def remove_occupancy(world,mid):
    for values in world['occupancy'].values():
        if mid in values:values.remove(mid)


def effect(model,state,task,call):
    w=state['world'];args=task['args'];dev=task['device'];key=task['key'];values=[]
    for x in call['args']:
        if x=='$device':values.append(dev)
        elif x=='$request':values.append(key)
        elif isinstance(x,str) and x.startswith('$'):values.append(args[x[1:]])
        else:values.append(x)
    a=values;op=call['effect']
    handoff=None
    if task['model']=='transfer@0.1':
        mid=args['material']
        if w['handoffs'].get(mid,{}).get('request')!=key:
            w['handoffs'][mid]=dict(request=key,source=args['source'],target=args['target'],actor=dev,tool=dev+'.tool',phase='reserved')
        handoff=w['handoffs'][mid]
    if op=='reserve_target':reserve(w,key,{'target':a[1],'material':a[0]})
    elif op=='capture':w['materials'][a[0]]['held_by']=a[1];w['devices'][a[1]]['held_material']=a[0];handoff['phase']='captured'
    elif op=='clear_source':
        m=w['materials'][a[0]];loc=a[2]+'.tool';remove_occupancy(w,a[0]);w['occupancy'][loc].append(a[0])
        m.update(region=loc,support=loc,holder=a[2])
        handoff['phase']='cleared'
    elif op=='place_supported':w['materials'][a[0]].update(region=a[1],support=a[1]);handoff['phase']='placed'
    elif op=='release_tool':w['materials'][a[0]]['held_by']=None;w['devices'][a[1]]['held_material']=None;handoff['phase']='released'
    elif op in ('commit_transfer','emit_registered'):
        if key not in w['committed']:
            m=w['materials'][a[0]];m.update(holder=owner(model,a[1]),region=a[1],support=a[1])
            remove_occupancy(w,a[0]);w['occupancy'][a[1]].append(a[0]);w['reservations'].pop(key,None);w['committed'].append(key)
            w['commit_records'][key]=dict(activation=key,request=key,subject=a[0],target=a[1])
        if handoff:handoff['phase']='committed'
        else:w['handoffs'].pop(a[0],None)
    elif op in ('advance_to_exit','wrap_to_entry'):
        loc=a[1]+('.exit' if op=='advance_to_exit' else '.entry');m=w['materials'][a[0]]
        remove_occupancy(w,a[0]);w['occupancy'][loc].append(a[0]);m.update(region=loc,support=loc)
        w['handoffs'].pop(a[0],None)
    elif op=='increment_cycle':
        counts=w['devices'][a[1]]['cycle_counts'];counts[a[0]]=counts.get(a[0],0)+1
    elif op=='record_operation':
        records=w['devices'][a[1]]['operation_history']
        if not any(r['request']==key for r in records):records.append({'material':a[0],'request':key})
    elif op=='clamp_workpiece':w['devices'][a[1]]['clamped_material']=a[0]
    elif op=='unclamp_workpiece':w['devices'][a[1]]['clamped_material']=None
    elif op=='begin_index':w['devices'][a[0]]['drive']='indexing'
    elif op=='begin_lift':w['devices'][a[0]]['drive']='moving'
    elif op=='finish_index':w['devices'][a[1]].update(actual_index=a[0],drive='stopped')
    elif op=='finish_lift':w['devices'][a[1]].update(actual_level=a[0],drive='stopped')
    elif op=='publish_success':pass
    else:raise VerificationError('UNSUPPORTED_MODEL','Unregistered effect: '+op)


def safe_release(model,state,task):
    w=state['world'];mid=task.get('args',{}).get('material')
    if not mid:return True
    m=w['materials'][mid]
    # A held or released-but-uncommitted transfer requires reconciliation.
    if task.get('model')=='transfer@0.1':
        src=task['args']['source'];dst=task['args']['target']
        return m['held_by'] is None and (m['region']==src and m['holder']==owner(model,src) or
                                       task['key'] in w['committed'] and m['region']==dst and m['holder']==owner(model,dst))
    return True


def release(state,key):
    w=state['world'];w['grants']={r:o for r,o in w['grants'].items() if o!=key};w['reservations'].pop(key,None)
