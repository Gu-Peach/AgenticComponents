"""Scheduled device work and declared exogenous/fault choices."""
from .core import all3
from .expressions import predicate,owner
from .plant import effect,remove_occupancy
from .monitor import record,state_checks

DONE={'succeeded','failed','cancelled','attention'}


def schedule(task,kind,start):
    task['scheduled']={'kind':kind,'start':start,'due':None}


def apply_events(model,state,log):
    w=state['world']
    for i,e in enumerate(model.profile['events']):
        if i in state['applied_events'] or e['tick']>state['tick']:continue
        if e['kind']=='set_external':
            w['external'][e['fact']].update(value=e['value'],valid=e['valid'],provider_epoch=e['provider_epoch'],sample_tick=state['tick'])
        elif e['kind']=='replace_carrier':
            carrier=e['carrier'];dest=e['destination'];mids=e['materials']
            zones={v['zone_ref'] for v in model.locations.values() if v['owner']==carrier}
            if any(z==r or frozenset((z,r)) in model.conflicts for z in zones for r in w['grants']):continue
            if any(owner(model,r['target'])==carrier for r in w['reservations'].values()):continue
            active=[t for t in state['tasks'].values() if t['phase'] not in DONE|{'new','gate'}]
            if any(t.get('device')==carrier or any(t.get('args',{}).get(k) in model.locations and owner(model,t['args'][k])==carrier
                   for k in ('source','target','location')) for t in active):continue
            if any(w['materials'][m]['held_by'] is not None or w['materials'][m]['holder']!=carrier for m in mids):continue
            dst_owner=owner(model,dest)
            count=sum(len(items) for loc,items in w['occupancy'].items() if owner(model,loc)==dst_owner)
            count+=sum(owner(model,r['target'])==dst_owner for r in w['reservations'].values())
            if count+len(mids)>model.devices[dst_owner]['parameters']['capacity']:continue
            if len(w['occupancy'][dest])+len(mids)>model.locations[dest]['capacity']:continue
            for mid in mids:
                remove_occupancy(w,mid);w['occupancy'][dest].append(mid)
                w['materials'][mid].update(region=dest,support=dest,holder=dst_owner);w['handoffs'].pop(mid,None)
            w['devices'][carrier]['epoch']=e['new_epoch']
            w['external'][e['set_fact']].update(value=True,valid=True,sample_tick=state['tick'])
        else:raise ValueError('Unsupported external event')
        state['applied_events'].append(i);log.append(dict(kind='external_event',event=i))


def faults(model,state,log):
    yield model.clone(state),list(log)
    if state['fault_count']>=model.profile['max_faults']:return
    live=[t for t in state['tasks'].values() if 'device' in t and t['phase'] not in DONE|{'new','gate'}]
    for name in model.profile['faults']:
        if name=='delayed_feedback':continue
        if name in ('duplicate_same_request','old_request_feedback'):
            for index,packet in enumerate(state['inbox']):
                s=model.clone(state);duplicate=model.clone(packet);duplicate['due']=s['tick']
                if name=='old_request_feedback':
                    duplicate['request']='prior:'+duplicate['request'];duplicate['activation']=duplicate['request']
                    duplicate['stream']='prior:'+duplicate['stream']
                s['inbox'].append(duplicate);s['fault_count']+=1
                yield s,log+[dict(kind='fault',fault=name,packet_index=index,sample_tick=packet['sample_tick'])]
        else:
            for t in live:
                if name=='missing_stop_confirmation' and t['phase'] not in ('stopping','exit_wait'):continue
                s=model.clone(state);s['fault_count']+=1;dev=t['device']
                if name=='missing_stop_confirmation':s['lost_stop'].append(t['key'])
                elif name=='hold_permission_loss':s['world']['devices'][dev]['permit']=False
                elif name=='provider_restart':
                    s['world']['devices'][dev]['epoch']+=1;s['abort']=True;s['reason']='provider_restart'
                    s['levels']={k:v for k,v in s['levels'].items() if v['device']!=dev}
                    for token in s['tasks'].values():
                        if token.get('device')==dev and token['phase'] not in DONE:
                            token.update(receipts={},accepted=False,stop_ack=False,ack=False,result_valid=False,device_fault=False,rejected=False)
                else:continue
                yield s,log+[dict(kind='fault',fault=name,request=t['key'])]


def physical(model,state,log,keys,index=0):
    if index==len(keys):yield state,log;return
    key=keys[index];task=state['tasks'][key];pending=task.get('scheduled')
    if not pending or (task['phase'] in DONE and pending['kind']!='stop'):
        yield from physical(model,state,log,keys,index+1);return
    kind=pending['kind'];interval=model.profile['accept' if kind=='accept' else 'stop' if kind=='stop' else 'phase']
    dates=[pending['due']] if pending['due'] is not None else range(pending['start']+interval[0]-1,pending['start']+interval[1])
    for date in dates:
        s=model.clone(state);notes=list(log);t=s['tasks'][key];t['scheduled']['due']=date
        if date>s['tick']:
            yield from physical(model,s,notes,keys,index+1);continue
        t['scheduled']=None
        if kind=='accept':
            if all3(predicate(model,s,t,p) for p in model.models[t['model']]['preconditions']) is True:
                t['plant_active']=True;t['stage']=0;model.emit(s,t,'accepted');schedule(t,'phase',s['tick']+1)
            else:model.emit(s,t,'rejected')
        elif kind=='phase':
            definition=model.models[t['model']]
            if all3(predicate(model,s,t,p) for p in definition['sustaining_conditions']) is not True:
                model.emit(s,t,'fault');schedule(t,'stop',s['tick']+1)
                notes.append(dict(kind='device_hold_failed',request=key))
                yield from physical(model,s,notes,keys,index+1);continue
            phase=definition['phases'][t['stage']]
            if any(call['effect']=='capture' for call in phase['effects']):
                src=t['args']['source'];w=s['world']
                good=all3([None if w['devices'][owner(model,src)]['drive'] is None else w['devices'][owner(model,src)]['drive']=='stopped',
                    t['args']['material'] in w['occupancy'][src],all(w['grants'].get(r)==key for r in t['claims'])])
                record(s,'V01',good,notes,detail=dict(request=key,source=src))
            for call in phase['effects']:
                effect(model,s,t,call);state_checks(model,s,notes)
            notes.append(dict(kind='plant_phase',request=key,phase=phase['id']))
            t['stage']+=1
            if t['stage']==len(definition['phases']):
                t['plant_active']=False;t['plant_done']=True;model.emit(s,t,'result')
            else:schedule(t,'phase',s['tick']+1)
        elif kind=='enter':s['world']['devices'][t['device']]['drive']='moving';model.emit(s,t,'enter')
        elif kind=='stop':
            t['plant_active']=False;s['world']['devices'][t['device']]['drive']='stopped'
            if model.profile['forced_stop_loss']==t['device'] and key not in s['lost_stop']:s['lost_stop'].append(key)
            if key not in s['lost_stop']:model.emit(s,t,'stop')
            notes.append(dict(kind='physical_stop',request=key,confirmation_lost=key in s['lost_stop']))
        else:raise ValueError('Unknown scheduled event')
        state_checks(model,s,notes)
        yield from physical(model,s,notes,keys,index+1)
