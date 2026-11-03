"""Held source levels, source-time sampling and per-stream FIFO delivery."""
from itertools import product
from .monitor import identity,evidence_ok,on_evidence

DONE={'succeeded','failed','cancelled','attention'}


def interested(t,kind,lost=False):
    if t['phase'] in DONE:return False
    got=t['receipts']
    if kind in ('accepted','rejected'):return t['phase']=='requesting' and kind not in got
    if kind=='fault':return t['phase'] in ('requesting','running','result_wait') and kind not in got
    if kind=='result':return t['phase'] in ('requesting','running','result_wait') and not t.get('result_valid')
    if kind=='enter':return t['phase']=='enter_wait' and kind not in got
    if kind=='stop':return t['phase'] in ('stopping','exit_wait') and kind not in got and not lost
    return False


def emit(model,state,t,kind):
    state['levels'][t['key']+'|'+kind]={**identity(t),'provider':t['device'],
        'epoch':state['world']['devices'][t['device']]['epoch'],'kind':kind,'value':True,'valid':True}


def sampling(model,state,log):
    streams=[]
    for name,level in sorted(state['levels'].items()):
        t=state['tasks'][level['request']]
        if interested(t,level['kind'],t['key'] in state['lost_stop']) and level['epoch']==state['world']['devices'][t['device']]['epoch']:
            streams.append((name,level))
    low,high=model.profile['feedback']
    for latencies in product(range(low,high+1),repeat=len(streams)):
        new=model.clone(state);events=list(log)
        for (name,level),delay in zip(streams,latencies):
            packet={**level,'stream':name,'sample_tick':state['tick'],'due':state['tick']+1+delay}
            new['inbox'].append(packet)
            events.append(dict(kind='sample',request=packet['request'],signal=packet['kind'],sample_tick=packet['sample_tick'],due=packet['due']))
        yield new,events


def consume(model,state,packet,log):
    t=state['tasks'].get(packet['request'])
    if t is None or t['phase'] in DONE:return
    expect=dict(provider=t['device'],subject=t.get('args',{}).get('material'),
                epoch=state['world']['devices'][t['device']]['epoch'],request_scoped=True,activation=t['key'],request=t['key'])
    if packet['epoch']!=t['epoch'] or evidence_ok(packet,expect,state['tick'],model.profile['max_age']) is not True:return
    kind=packet['kind']
    if not interested(t,kind,t['key'] in state['lost_stop']):return
    on_evidence(model,state,packet,expect,log)
    t['receipts'][kind]=dict(packet=model.clone(packet),observed=state['tick'])
    if kind=='accepted':
        t['accepted']=True;t.setdefault('accepted_tick',state['tick'])
        pending=t['receipts'].get('result',{}).get('packet')
        if pending and evidence_ok(pending,expect,state['tick'],model.profile['max_age']) is True:t['result_valid']=True
    elif kind=='result':t['result_valid']='accepted' in t['receipts']
    elif kind=='rejected':t['rejected']=True
    elif kind=='enter':t['ack']=True
    elif kind=='stop':t['stop_ack']=True
    elif kind=='fault':t['device_fault']=True
    log.append(dict(kind='feedback_consumed',signal=kind,request=t['key'],sample_tick=packet['sample_tick'],observed=state['tick']))


def delivery(model,state,log):
    waiting=[];blocked=set()
    for packet in state['inbox']:
        stream=packet['stream']
        if stream in blocked or packet['due']>state['tick']:
            waiting.append(packet);blocked.add(stream)
        else:consume(model,state,packet,log)
    state['inbox']=waiting
