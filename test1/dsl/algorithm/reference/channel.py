"""Independent channel: choose absolute delivery dates at source sampling."""
from .common import clone,TERMINAL
from .state import request
from .properties import evidence_valid
from .monitors import record


def expected(d,s,k):
    r=request(d,s,k)
    return {'provider':r['device'],'epoch':s['plant']['devices'][r['device']]['epoch'],'subject':r['subject'],
            'request_scoped':True,'activation':k,'request':k,'value_type':'bool'}


def emit(d,s,k,kind):
    r=request(d,s,k)
    s['latches'][k+'|'+kind]={**r,'epoch':s['plant']['devices'][r['device']]['epoch'],
          'kind':kind,'provider':r['device'],'value':True,'valid':True}


def interested(t,kind,lost=False):
    if t['status'] in TERMINAL:return False
    got=t['receipts']
    if kind in ('accepted','rejected'):return t['status']=='waiting_accept' and kind not in got
    if kind=='fault':return t['status'] in ('waiting_accept','executing') and 'fault' not in got
    if kind=='result':return t['status'] in ('waiting_accept','executing') and not t.get('result_confirmed',False)
    if kind=='enter':return t['status']=='entering' and 'enter' not in got
    if kind=='stop':return t['status'] in ('stopping','exiting') and 'stop' not in got and not lost
    return False


def sample(d,s,log):
    streams=[(name,level) for name,level in sorted(s['latches'].items())
             if level['request'] in s['tokens'] and interested(s['tokens'][level['request']],level['kind'],level['request'] in s['lost_stop'])
             and level['epoch']==s['plant']['devices'][level['provider']]['epoch']]
    def choose(index,state,events):
        if index==len(streams):yield state,events;return
        stream,level=streams[index]
        for delay in range(d.profile['feedback'][0],d.profile['feedback'][1]+1):
            nxt=clone(state);p={**level,'sample_tick':s['tick'],'due':s['tick']+1+delay,'stream':stream}
            nxt['mail'].append(p)
            yield from choose(index+1,nxt,events+[{'kind':'sample','request':p['request'],'signal':p['kind'],'sample_tick':p['sample_tick'],'due':p['due']}])
    yield from choose(0,s,log)


def deliver(d,s,log):
    remaining=[];blocked=set();now=s['tick']
    for p in s['mail']:
        stream=p['stream']
        if stream in blocked or p['due']>now:
            remaining.append(p);blocked.add(stream);continue
        k=p['request'];t=s['tokens'].get(k)
        if t is None or t['status'] in TERMINAL:
            log.append({'kind':'ignored_packet','request':k});continue
        exp=expected(d,s,k)
        valid=p['epoch']==t['epoch'] and evidence_valid(p,exp,now,d.profile['max_age']) is True
        if not valid:
            log.append({'kind':'ignored_packet','request':k});continue
        kind=p['kind'];used=interested(t,kind,k in s['lost_stop'])
        if not used:continue
        record(d,s,'V03',{'kind':'consume_evidence','tick':now,'evidence':p,'expected':exp,'max_age':d.profile['max_age']},log)
        t['receipts'][kind]={'packet':clone(p),'observed':now}
        if kind=='accepted':
            if t['accepted_at'] is None:t['accepted_at']=now
            pending=t['receipts'].get('result')
            if pending and evidence_valid(pending['packet'],exp,now,d.profile['max_age']) is True:t['result_confirmed']=True
        if kind=='result' and 'accepted' in t['receipts']:t['result_confirmed']=True
        log.append({'kind':'consume','request':k,'signal':kind,'sample_tick':p['sample_tick'],'observed':now})
    s['mail']=remaining
