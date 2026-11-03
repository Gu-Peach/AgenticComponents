"""Explicit observation relation; no source model calls occur inside the SUT."""
import copy
import json

PHASE={'new':'ready','requesting':'waiting_accept','running':'executing','result_wait':'executing',
       'enter_wait':'entering','exit_wait':'exiting','succeeded':'ok','attention':'isolated'}
DONE={'ok','failed','cancelled','isolated'}


def key(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)


def canonical(state,reference=False):
    w=copy.deepcopy(state['plant' if reference else 'world'])
    if not reference:
        w['ledger']=w.pop('occupancy');w['commits']=w.pop('commit_records');w.pop('committed')
    for v in w['devices'].values():
        for mid in w['materials']:v['cycle_counts'].setdefault(mid,0)
    tokens={}
    for k,t in state['tokens' if reference else 'tasks'].items():
        status=t['status'] if reference else PHASE.get(t['phase'],t['phase'])
        mapped=dict(node=t['node'],kind=t['kind'],path=t['path'],parent=t['parent'],scope=t['scope'],status=status,children=t['children'])
        actor=t.get('actor' if reference else 'device')
        if actor is not None:mapped.update(actor=actor,epoch=t['epoch'],owned=t['owned' if reference else 'claims'])
        pending=(dict(kind=t['hardware'],start=t['hardware_start'],due=t['hardware_due']) if t.get('hardware') else None) if reference else t.get('scheduled')
        if pending and not reference and pending['kind']=='phase':pending={**pending,'kind':'action_phase'}
        mapped['scheduled']=pending
        if status not in DONE or pending:
            mapped.update(eligible=t['eligible'],born=t['born' if reference else 'created'])
            if t['kind'] in ('seq','par','repeat','branch'):mapped['position']=t.get('position',0)
            if actor is not None:
                mapped['receipts']=t['receipts'];mapped['accepted_at']=t.get('accepted_at' if reference else 'accepted_tick')
                if t['kind']=='invoke':mapped.update(stage=t.get('stage',0),plant_finished=t.get('plant_finished' if reference else 'plant_done',False),
                    result_confirmed=t.get('result_confirmed' if reference else 'result_valid',False))
            for label,a,b in (('submitted','submitted','submit'),('execution_start','execution_start','execute_start'),
                             ('enter_start','enter_start','start'),('stop_start','stop_start','stop_start')):
                value=t.get(a if reference else b)
                if value is not None:mapped[label]=value
            if status=='exiting':mapped['abort_exit']=t.get('abort_exit',False)
        tokens[k]=mapped
    complete={k:{f:v.get(f) for f in ('request','material','target','epoch')} for k,v in state['completed'].items()}
    return dict(tick=state['tick'],plant=w,tokens=tokens,completed=complete,
        mail=state['mail' if reference else 'inbox'],latches=state['latches' if reference else 'levels'],
        lost_stop=state['lost_stop'],events=state['events_done' if reference else 'applied_events'],
        faults=state['faults_used' if reference else 'fault_count'],aborting=bool(state['abort']),outcome=state['outcome'],
        violations=sorted(state['violations']),triggered=sorted(state['triggered'] if reference else state['trigger_ticks']),
        uncovered=sorted({v.split(':')[0] for v in state['uncovered_properties']} if reference else state['uncovered']))


def diff(a,b,p=''):
    if isinstance(a,dict) and isinstance(b,dict):
        result=[]
        for k in sorted(set(a)|set(b)):
            if k not in a or k not in b:result.append(dict(path=p+'/'+k,sut=a.get(k),reference=b.get(k)))
            else:result.extend(diff(a[k],b[k],p+'/'+k))
        return result
    return [] if a==b else [dict(path=p,sut=a,reference=b)]


def walk(sut,ref,bound=512,fault_tick=None,fault=None):
    s,r=sut.initial,ref.initial;trace=[]
    for tick in range(bound+1):
        delta=diff(canonical(s),canonical(r,True))
        if delta:return dict(status='DIVERGED',tick=tick,differences=delta,trace=trace)
        if s['outcome']!='running':return dict(status='MATCHED_TERMINAL',tick=tick,trace=trace)
        if tick==bound:break
        picked=fault if tick+1==fault_tick else None
        def choose(m,state):
            matches=[];g=m.successors(state)
            try:
                for nxt,events in g:
                    fs=[e for e in events if e['kind']=='fault']
                    if (not fs if picked is None else len(fs)==1 and fs[0]['fault']==picked):
                        matches.append((nxt,events))
                        if len(matches)>1:raise ValueError('Use a singleton fixture for paired walks')
            finally:g.close()
            if len(matches)!=1:raise ValueError('No coupled successor')
            return matches[0]
        s,se=choose(sut,s);r,re=choose(ref,r)
        trace.append(dict(tick=tick+1,sut=s,reference=r,sut_events=se,reference_events=re))
    return dict(status='PREFIX_ONLY',tick=bound,trace=trace)
