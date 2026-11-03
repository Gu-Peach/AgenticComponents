"""Reference state: control tokens, explicit event dates and separate ledgers."""
from .common import clone,need,key,TERMINAL


def initial(d):
    raw=d.initial;pilot=d.descriptor['schema_type']=='PilotCase'
    if pilot:
        need(not raw['grants'] and raw['accepted_request'] is None and not raw['completed_requests']
             and raw['reservation'] is None and not raw['attention_required'],'Initial recovery protocol unsupported')
    else:
        p=raw['protocol'];need(not raw['reservations'] and not p['active_requests'] and not p['grants']
             and not p['completed_requests'] and not p['attention_required'],'Initial recovery protocol unsupported')
    materials={m['id']:clone(m) for m in raw['materials']}
    if pilot:materials[raw['material']].update({k:raw[k] for k in ('region','support','holder','held_by')})
    devices={}
    for dev in d.devices:
        if pilot:
            value={'drive':raw['drives'].get(dev,'stopped'),'run_command':raw['run_commands'].get(dev,False),
              'permit':raw['permits'].get(dev,True),'held_material':None,'clamped_material':None,'access_closed':True,
              'actual_index':0,'actual_level':0,'operation_history':[],'cycle_counts':{}}
        else:
            need(dev in raw['device_states'],'Missing device initial state: '+dev);value=clone(raw['device_states'][dev])
        required={'drive','run_command','permit','held_material','clamped_material','access_closed',
                  'actual_index','actual_level','operation_history','cycle_counts'}
        need(required<=set(value),'Incomplete initial device fields: '+dev)
        for field in ('run_command','permit','access_closed'):
            need(value[field] is None or type(value[field]) is bool,'Invalid initial boolean')
        value.setdefault('epoch',0);need(type(value['epoch']) is int and value['epoch']>=0,'Invalid initial epoch')
        need(value['drive']=='stopped','Initial moving drive unsupported')
        for mid in materials:value['cycle_counts'].setdefault(mid,0)
        devices[dev]=value
    if pilot:
        ledger={loc:([raw['material']] if loc in raw['occupancy'] else []) for loc in d.locations}
    else:ledger=clone(raw['occupancy'])
    for loc in d.locations:ledger.setdefault(loc,[])
    s={'tick':0,'plant':{'materials':materials,'devices':devices,'ledger':ledger,'grants':{},'reservations':{},
                        'commits':{},'external':clone(raw.get('external',{})),'handoffs':{}},
       'tokens':{},'completed':{},'mail':[],'latches':{},'lost_stop':[],'events_done':[],'faults_used':0,
       'abort':None,'outcome':'running','violations':[],'triggered':[],'uncovered_properties':[]}
    activate(d,s,d.body[1],[],None,None)
    return s


def activate(d,s,node,path,parent,scope):
    ident=key(node,path);need(ident not in s['tokens'],'Activation reused')
    n=d.nodes[node];token={'node':node,'kind':n[0],'path':list(path),'parent':parent,'scope':scope,'status':'ready',
                          'born':s['tick'],'eligible':s['tick']+1,'children':[],'position':0,'owned':[]}
    if n[0] in ('invoke','with-control'):
        actor=d.actions[node]['device'] if n[0]=='invoke' else d.controls[d.env['controls'][n[2]]]['owner']
        token.update(actor=actor,epoch=s['plant']['devices'][actor]['epoch'],receipts={},accepted_at=None,
                     hardware=None,hardware_due=None,stage=0,hardware_start=None,plant_finished=False)
    s['tokens'][ident]=token
    if parent:s['tokens'][parent]['children'].append(ident)
    return ident


def request(d,s,ident):
    t=s['tokens'][ident];args=d.actions[t['node']]['args'] if t['node'] in d.actions else {}
    return {'activation':ident,'request':ident,'device':t['actor'],'subject':args.get('material'),'epoch':t['epoch']}


def world(s):
    return {'materials':s['plant']['materials'],'devices':s['plant']['devices'],
            'grants':list(s['plant']['grants'].items()),'external':s['plant']['external'],
            'active_requests':[k for k,t in s['tokens'].items() if t['kind']=='invoke' and t['status'] in
                               ('waiting_accept','executing','stopping','isolated')]}


def retire(s):
    # Timers and received packets have no future reader after a terminal token.
    # Completion identity and physical results remain in the separate index.
    for ident,t in list(s['tokens'].items()):
        if t['status'] in TERMINAL and not t.get('hardware'):
            s['tokens'][ident]={k:v for k,v in t.items() if k in
              ('node','kind','path','parent','scope','status','children','actor','epoch','owned')}
    s['latches']={k:v for k,v in s['latches'].items() if s['tokens'][v['request']]['status'] not in TERMINAL}
