"""Build independent P1 observation frames from reference states and effects."""
from .common import clone,TERMINAL
from .properties import evaluate,owner_ref,goal_value
from .state import request,world


def record(d,s,pid,frame,log):
    result=evaluate(pid,frame,d.task,bound=10**18)
    if result.get('trigger_observed') and pid not in s['triggered']:s['triggered'].append(pid);s['triggered'].sort()
    if result['status']=='VIOLATED':
        if pid not in s['violations']:s['violations'].append(pid);s['violations'].sort()
        log.append({'kind':'property_violation','property':pid,'frame':clone(frame),'result':result})
    if result['status'] in ('UNKNOWN','INVALID_FRAME'):
        item=pid+':'+result.get('reason','unknown')
        if item not in s['uncovered_properties']:s['uncovered_properties'].append(item);s['uncovered_properties'].sort()
    return result


def grants(d,s):
    return [{'resource':r,'owner':owner_ref(request(d,s,k))} for r,k in s['plant']['grants'].items()]


def state_checks(d,s,log):
    p=s['plant'];base={'kind':'state','tick':s['tick']}
    record(d,s,'V04',{**base,'grants':grants(d,s),'conflicts':d.relations['resource_conflicts']},log)
    materials=[]
    for mid,m in p['materials'].items():
        h=p['handoffs'].get(mid,{})
        materials.append({'id':mid,'phase':h.get('phase','unspawned' if m['region']=='unspawned' else 'stable'),
            **{k:v for k,v in h.items() if k!='phase'},
            'physical':{k:m[k] for k in ('region','support','held_by')},
            'ledger':{'holder':m['holder'],'locations':[loc for loc,ms in p['ledger'].items() for v in ms if v==mid]}})
    record(d,s,'V05',{**base,'materials':materials,'location_owners':{k:v['owner'] for k,v in d.locations.items()}},log)
    domains=[{'id':loc,'capacity':d.locations[loc]['capacity'],'occupied':ms,
              'reserved':[k for k,v in p['reservations'].items() if v['target']==loc]} for loc,ms in p['ledger'].items()]
    for actor,dev in d.devices.items():
        domains.append({'id':actor,'capacity':dev['parameters']['capacity'],
          'occupied':[mid for loc,ms in p['ledger'].items() if d.locations[loc]['owner']==actor for mid in ms],
          'reserved':[k for k,v in p['reservations'].items() if d.locations[v['target']]['owner']==actor]})
    record(d,s,'V06',{**base,'capacity_domains':domains,'effective_commits':list(p['commits'].values())},log)


def capture_check(d,s,k,log):
    a=d.actions[s['tokens'][k]['node']];src=a['args']['source'];actor=d.locations[src]['owner']
    record(d,s,'V01',{'kind':'capture','tick':s['tick'],'request':request(d,s,k),
      'source':{'drive':s['plant']['devices'][actor]['drive'],'material_ids':s['plant']['ledger'][src]},
      'required_resources':s['tokens'][k]['owned'],'grants':grants(d,s)},log)


def bounded_response(d,s,log):
    window=d.profile['response_window']
    if window is None:return
    for k,t in s['tokens'].items():
        accepted=t.get('accepted_at')
        if accepted is None:continue
        if 'V10b' not in s['triggered']:s['triggered'].append('V10b');s['triggered'].sort()
        responded=t['status'] in ('ok','failed','cancelled') or (t['status']=='isolated' and
                  all(s['plant']['grants'].get(r)==k for r in t['owned']))
        if not responded and s['tick']>=accepted+window:
            if 'V10b' not in s['violations']:s['violations'].append('V10b');s['violations'].sort()
            log.append({'kind':'response_deadline_violation','request':k,'accepted_at':accepted,'deadline':accepted+window})


def goal(d,s):
    w=world(s)
    try:return s['outcome']=='succeeded' and goal_value(w,d.task['goal']) is True and not w['grants'] and not w['active_requests']
    except (KeyError,ValueError,TypeError):return False
