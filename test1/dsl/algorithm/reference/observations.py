"""Observe current symbolic facts; correlate completed requests by lexical path."""
from .common import all3,any3,key,need
from .properties import goal_value,InvalidFrame
from .state import world


def completed(s,node,path):
    for n in range(len(path),-1,-1):
        found=s['completed'].get(key(node,path[:n]))
        if found is not None:return found
    return None


def condition(d,s,expr,path,log=None,audit_state=None):
    op=expr[0]
    if op=='condition':return condition(d,s,d.conditions[expr[1]],path,log,audit_state)
    if op=='all':return all3(condition(d,s,e,path,log,audit_state) for e in expr[1:])
    if op=='any':return any3(condition(d,s,e,path,log,audit_state) for e in expr[1:])
    if op=='not':
        value=condition(d,s,expr[1],path,log,audit_state);return None if value is None else not value
    need(op=='is' and expr[-1] in ('true','false'),'Unsupported condition')
    read=expr[1];need(read[0]=='observation','Only declared observations supported')
    alias=read[1];name=read[2][1];p=s['plant'];qual={q[0]:q[1] for q in read[3:]}
    record_ref=None;mid=None
    if alias=='world':
        try:value=goal_value(world(s),d.env['observation_definitions'][name])
        except (KeyError,InvalidFrame):value=None
    else:
        actor=d.env['bindings'][alias]['id'];mid=d.env['bindings'][qual['subject']]['id'] if 'subject' in qual else next(iter(p['materials']))
        record=completed(s,qual['request'],path) if 'request' in qual else None
        record_ref=record
        if 'request' in qual and record is None:return None
        if name=='surface_stopped':value=p['devices'][actor]['drive']=='stopped'
        elif name=='both_tools_empty':value=all(v['held_material'] is None for v in p['devices'].values())
        elif name=='subject_at_exit':
            if record and (record['material']!=mid or record['target']!=actor+'.exit'):return None
            value=p['materials'][mid]['region']==actor+'.exit'
        elif name=='holder_matches_target':value=None if not record else p['materials'][mid]['holder']==d.locations[record['target']]['owner']
        elif name=='supported_at_target':value=None if not record else p['materials'][mid]['region']==record['target'] and p['materials'][mid]['support']==record['target']
        else:need(False,'Unknown observation '+name)
    if value is not None and log is not None:
        from .monitors import record as audit
        provider=d.env['bindings'][alias]['id'];epoch=p['devices'][provider]['epoch'] if provider in p['devices'] else 0
        req=record_ref['request'] if record_ref else None
        expected={'provider':provider,'epoch':epoch,'subject':mid,'request_scoped':req is not None,
                  'activation':req,'request':req,'value_type':'bool'}
        evidence={**expected,'kind':'state_fact','fact':name,'value':value,'valid':True,'sample_tick':s['tick']}
        audit(d,audit_state if audit_state is not None else s,'V03',{'kind':'consume_evidence','tick':s['tick'],
          'evidence':evidence,'expected':expected,'max_age':d.profile['max_age']},log)
        log.append({'kind':'state_observation','provider':provider,'fact':name,'value':value,'request':req})
    return None if value is None else value==(expr[-1]=='true')
