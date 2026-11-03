"""Independent symbolic plant, ledger and atomic resource operations."""
from .common import need,all3,TERMINAL


def owner(d,loc):return d.locations[loc]['owner']
def action(d,s,k):return d.actions[s['tokens'][k]['node']]


def resources(d,s,k):
    a=action(d,s,k);values=[]
    for r in a['model']['resource_claims']:
        if r.startswith('delegate:') or r=='target.capacity':continue
        if r=='material.claim':values.append(a['args']['material']+'.claim')
        elif r in ('source.zone','target.zone'):values.append(d.locations[a['args'][r.split('.')[0]]]['zone_ref'])
        elif r.startswith('device.'):values.append(a['device']+'.'+r.split('.')[1])
        else:need(False,'Unknown claim '+r)
    return sorted(set(values))


def conflicts(d,a,b):return a==b or [a,b] in d.relations['resource_conflicts'] or [b,a] in d.relations['resource_conflicts']
def authorized(d,s,wanted,k):return all(who==k or not conflicts(d,r,held) for r in wanted for held,who in s['plant']['grants'].items())


def available(d,s,target,k=None):
    p=s['plant'];o=owner(d,target)
    local=len(p['ledger'][target]);group=sum(len(xs) for loc,xs in p['ledger'].items() if owner(d,loc)==o)
    for who,res in p['reservations'].items():
        if who!=k:local+=res['target']==target;group+=owner(d,res['target'])==o
    return local<d.locations[target]['capacity'] and group<d.devices[o]['parameters']['capacity']


def reserve(d,s,k):
    args=action(d,s,k)['args']
    if 'target' in args:s['plant']['reservations'][k]={'material':args['material'],'target':args['target']}


def release(s,k):
    p=s['plant'];p['grants']={r:who for r,who in p['grants'].items() if who!=k};p['reservations'].pop(k,None)


def can_release(d,s,k):
    a=action(d,s,k);args=a['args'];p=s['plant']
    if a['model']['id']!='transfer@0.1':return True
    m=p['materials'][args['material']]
    return m['held_by'] is None and ((m['region']==args['source'] and m['holder']==owner(d,args['source'])) or
         (k in p['commits'] and m['region']==args['target'] and m['holder']==owner(d,args['target'])))


def values(d,s,k,call):
    a=action(d,s,k);lookup={'request':k,'device':a['device'],**a['args']}
    return [lookup[x[1:]] if isinstance(x,str) and x.startswith('$') else x for x in call['args']]


def predicate(d,s,k,call):
    a=values(d,s,k,call);name=call['predicate'];p=s['plant'];t=s['tokens'][k]
    mat=p['materials'];dev=p['devices']
    if name=='source_contains':return mat[a[0]]['region']==a[1] and a[0] in p['ledger'][a[1]]
    if name=='source_unclamped':return dev[owner(d,a[1])]['clamped_material']!=a[0]
    if name=='target_compatible':return mat[a[0]]['type'] in d.locations[a[1]]['accepts']
    if name=='target_capacity':return available(d,s,a[0],k)
    if name=='tool_empty':return dev[a[0]]['held_material'] is None
    if name in ('source_stationary','target_stationary'):return dev[owner(d,a[0])]['drive']=='stopped'
    if name=='interlock_valid':return dev[a[0]]['permit']
    if name=='all_grants_valid':return all(p['grants'].get(r)==k for r in t['owned'])
    if name=='drive_stopped':return dev[a[0]]['drive']=='stopped'
    if name=='subject_on_device':return owner(d,mat[a[0]]['region'])==a[1] and mat[a[0]]['holder']==a[1]
    if name=='drive_authorized':
        scope=t['scope']
        if scope not in s['tokens']:return False
        n=d.nodes[s['tokens'][scope]['node']];c=d.controls[d.env['controls'][n[2]]]
        return p['grants'].get(c['writer'])==scope and dev[a[0]]['run_command'] is True and dev[a[0]]['drive']=='moving'
    if name=='subject_at_exit':return mat[a[0]]['region']==a[1]+'.exit'
    if name=='result_matches':return 'accepted' in t['receipts'] and t.get('result_confirmed',False)
    if name=='transfer_committed':return k in p['commits'] and mat[a[0]]['holder']==owner(d,a[1])
    if name=='supported_at':return mat[a[0]]['region']==a[1] and mat[a[0]]['support']==a[1]
    if name=='at_location':return mat[a[0]]['region']==a[1]
    if name=='location_owned_by':return owner(d,a[0])==a[1]
    if name=='clamped':return dev[a[1]]['clamped_material']==a[0]
    if name=='unclamped':return dev[a[1]]['clamped_material'] is None
    if name=='access_closed':return dev[a[0]]['access_closed']
    if name=='no_processing':return not any(who!=k and x.get('actor')==a[0] and x['status'] not in TERMINAL|{'ready','gate'} and
        x['node'] in d.actions and d.actions[x['node']]['model']['id']=='process@0.1' for who,x in s['tokens'].items())
    if name=='operation_recorded':return any(r['request']==k and r['material']==a[0] for r in dev[a[1]]['operation_history'])
    if name=='tools_clear':return not any(r==a[0]+'.zone' and who!=k for r,who in p['grants'].items())
    if name=='target_index_valid':return 0<=a[0]<d.devices[a[1]]['parameters']['index_count']
    if name=='axis_target_valid':return 0<=a[0]<d.devices[a[1]]['parameters']['level_count']
    if name=='index_reached':return dev[a[1]]['actual_index']==a[0] and dev[a[1]]['drive']=='stopped'
    if name=='level_reached':return dev[a[1]]['actual_level']==a[0] and dev[a[1]]['drive']=='stopped'
    if name=='material_unspawned':return mat[a[0]]['region']=='unspawned'
    need(False,'Unsupported predicate '+name)


def predicates(d,s,k,field):return all3(predicate(d,s,k,c) for c in action(d,s,k)['model'][field])


def ledger_move(s,material,location):
    for items in s['plant']['ledger'].values():
        if material in items:items.remove(material)
    s['plant']['ledger'][location].append(material)


def effect(d,s,k,call):
    a=values(d,s,k,call);op=call['effect'];p=s['plant'];m=p['materials'];dev=p['devices']
    act=action(d,s,k)
    if act['model']['id']=='transfer@0.1':
        args=act['args']
        if p['handoffs'].get(args['material'],{}).get('request')!=k:
            p['handoffs'][args['material']]={'source':args['source'],'target':args['target'],
                       'actor':act['device'],'tool':act['device']+'.tool','phase':'reserved','request':k}
        h=p['handoffs'][args['material']]
    else:h=None
    if op=='reserve_target':reserve(d,s,k)
    elif op=='capture':m[a[0]]['held_by']=a[1];dev[a[1]]['held_material']=a[0];h['phase']='captured'
    elif op=='clear_source':
        loc=a[2]+'.tool';ledger_move(s,a[0],loc);m[a[0]].update(region=loc,support=loc,holder=a[2]);h['phase']='cleared'
    elif op=='place_supported':m[a[0]].update(region=a[1],support=a[1]);h['phase']='placed'
    elif op=='release_tool':m[a[0]]['held_by']=None;dev[a[1]]['held_material']=None;h['phase']='released'
    elif op in ('commit_transfer','emit_registered'):
        if k not in p['commits']:
            ledger_move(s,a[0],a[1]);m[a[0]].update(region=a[1],support=a[1],holder=owner(d,a[1]))
            p['reservations'].pop(k,None);p['commits'][k]={'activation':k,'request':k,'subject':a[0],'target':a[1]}
        if h:h['phase']='committed'
        else:p['handoffs'].pop(a[0],None)
    elif op in ('advance_to_exit','wrap_to_entry'):
        loc=a[1]+('.exit' if op=='advance_to_exit' else '.entry');ledger_move(s,a[0],loc);m[a[0]].update(region=loc,support=loc)
        p['handoffs'].pop(a[0],None)
    elif op=='increment_cycle':dev[a[1]]['cycle_counts'][a[0]]+=1
    elif op=='record_operation':
        if not any(r['request']==k for r in dev[a[1]]['operation_history']):dev[a[1]]['operation_history'].append({'material':a[0],'request':k})
    elif op=='clamp_workpiece':dev[a[1]]['clamped_material']=a[0]
    elif op=='unclamp_workpiece':dev[a[1]]['clamped_material']=None
    elif op=='begin_index':dev[a[0]]['drive']='indexing'
    elif op=='begin_lift':dev[a[0]]['drive']='moving'
    elif op=='finish_index':dev[a[1]].update(actual_index=a[0],drive='stopped')
    elif op=='finish_lift':dev[a[1]].update(actual_level=a[0],drive='stopped')
    elif op=='publish_success':pass
    else:need(False,'Unsupported effect '+op)
