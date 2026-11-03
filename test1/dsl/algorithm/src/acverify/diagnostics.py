"""Witness reconstruction and full-model replay; no oracle inputs."""
import copy
from .core import canonical, require
from .reduction import compact


def trace(model,graph,index):
    steps=[];current=index
    while graph['parents'][current] is not None:
        parent,events=graph['parents'][current]
        annotated=[]
        for event in events:
            item=copy.deepcopy(event)
            if 'node' in item:item['source']=model.data['source_map'].get(item['node'])
            annotated.append(item)
        steps.append({'events':annotated,'state':graph['states'][current]});current=parent
    return {'model_version':model.version,'reduction':graph['report']['reduction'],'initial':graph['states'][0],
            'steps':list(reversed(steps)),'input_digest':model.data['input_digest'],'model_digest':model.model_digest,'environment':model.profile}


def replay(model,witness):
    require(witness['model_version']==model.version,'TRACE_INVALID','Model version differs')
    require(witness['input_digest']==model.data['input_digest'],'TRACE_INVALID','Input dependencies differ')
    require(witness['model_digest']==model.model_digest,'TRACE_INVALID','Normalized model differs')
    require(canonical(witness['environment'])==canonical(model.profile),'TRACE_INVALID','Environment differs')
    projection=compact if witness['reduction'] in ('compact','clock') else lambda x:x
    state=copy.deepcopy(model.initial)
    require(canonical(projection(state))==canonical(witness['initial']),'TRACE_INVALID','Initial state differs')
    for step in witness['steps']:
        target=canonical(step['state']);found=None
        for nxt,events in model.successors(state):
            from .properties import edge_properties
            bad,_=edge_properties(events);nxt['violations']=sorted(set(nxt['violations'])|bad)
            if canonical(projection(nxt))==target:found=nxt;break
        require(found is not None,'TRACE_INVALID','No legal full-model successor',tick=state['tick'])
        state=found
    return {'valid':True,'ticks':state['tick'],'outcome':state['outcome'],
            'scope':'Full transition-model replay, not an independent physical or semantic oracle.'}
