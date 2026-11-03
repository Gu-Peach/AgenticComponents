"""Declared exogenous changes and nondeterministic bounded fault injections."""
from .common import clone,TERMINAL
from .plant import owner,conflicts,ledger_move


def external(d,s,log):
    p=s['plant']
    for i,event in enumerate(d.profile['events']):
        if i in s['events_done'] or event['tick']>s['tick']:continue
        if event['kind']=='set_external':
            p['external'][event['fact']].update(value=event['value'],valid=event['valid'],
                provider_epoch=event['provider_epoch'],sample_tick=s['tick'])
        else:
            carrier=event['carrier'];mids=event['materials'];dest=event['destination']
            zones={loc['zone_ref'] for loc in d.locations.values() if loc['owner']==carrier}
            if any(conflicts(d,z,r) for z in zones for r in p['grants']):continue
            if any(owner(d,r['target'])==carrier for r in p['reservations'].values()):continue
            active=False
            for t in s['tokens'].values():
                if t['status'] in TERMINAL|{'ready','gate'}:continue
                args=d.actions[t['node']]['args'] if t['node'] in d.actions else {}
                if t.get('actor')==carrier or any(args.get(k) in d.locations and owner(d,args[k])==carrier for k in ('source','target','location')):
                    active=True
            if active or any(p['materials'][m]['holder']!=carrier or p['materials'][m]['held_by'] is not None for m in mids):continue
            target_owner=owner(d,dest)
            group=sum(len(ms) for loc,ms in p['ledger'].items() if owner(d,loc)==target_owner)
            reserved=sum(owner(d,r['target'])==target_owner for r in p['reservations'].values())
            if group+reserved+len(mids)>d.devices[target_owner]['parameters']['capacity']:continue
            if len(p['ledger'][dest])+len(mids)>d.locations[dest]['capacity']:continue
            for mid in mids:
                ledger_move(s,mid,dest);p['materials'][mid].update(region=dest,support=dest,holder=target_owner)
                p['handoffs'].pop(mid,None)
            p['devices'][carrier]['epoch']=event['new_epoch']
            p['external'][event['set_fact']].update(value=True,valid=True,sample_tick=s['tick'])
        s['events_done'].append(i);log.append({'kind':'external','event':i})


def faults(d,s,log):
    yield clone(s),list(log)
    if s['faults_used']>=d.profile['max_faults']:return
    live=[k for k,t in s['tokens'].items() if 'actor' in t and t['status'] not in TERMINAL|{'ready','gate'}]
    for fault in d.profile['faults']:
        if fault=='delayed_feedback':continue
        if fault in ('duplicate_same_request','old_request_feedback'):
            if not s['mail']:continue
            for index,stored in enumerate(s['mail']):
                nxt=clone(s);packet=clone(stored);packet['due']=s['tick']
                if fault=='old_request_feedback':
                    packet['request']='prior:'+packet['request'];packet['activation']=packet['request']
                    packet['stream']='prior:'+packet['stream']
                nxt['mail'].append(packet);nxt['faults_used']+=1
                yield nxt,log+[{'kind':'fault','fault':fault,'packet_index':index,'sample_tick':stored['sample_tick']}]
        else:
            for k in live:
                t=s['tokens'][k]
                if fault=='missing_stop_confirmation' and t['status'] not in ('stopping','exiting'):continue
                nxt=clone(s);actor=t['actor'];nxt['faults_used']+=1
                if fault=='missing_stop_confirmation':nxt['lost_stop'].append(k)
                elif fault=='hold_permission_loss':nxt['plant']['devices'][actor]['permit']=False
                elif fault=='provider_restart':
                    nxt['plant']['devices'][actor]['epoch']+=1;nxt['abort']='provider_restart'
                    nxt['latches']={name:v for name,v in nxt['latches'].items() if v['provider']!=actor}
                    for token in nxt['tokens'].values():
                        if token.get('actor')==actor and token['status'] not in TERMINAL:
                            token['receipts']={};token['result_confirmed']=False
                else:continue
                yield nxt,log+[{'kind':'fault','fault':fault,'request':k}]
