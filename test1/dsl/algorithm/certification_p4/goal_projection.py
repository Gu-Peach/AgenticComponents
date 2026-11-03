"""Goal-only parallel/event projection, not a timed execution/POR equivalence."""
from reference.common import clone,digest,canonical
from reference.transition import ReferenceModel
from reference.observations import condition
from certification import success_effects
from certification.logic import terminal,flatten
from certification.evidence_check import require,BadEvidence
from .invariants import catalog

NO_WRITE='__no_write__'


def merge_sequence(a,b):
    out={}
    for field in set(a)|set(b):
        av=a.get(field,{NO_WRITE});bv=b.get(field,{NO_WRITE})
        out[field]=(bv-{NO_WRITE})|(av if NO_WRITE in bv else set())
    return out


def action_writes(model,node):
    a=model.d.actions[node[1]];actor=a['device'];mid=a['args'].get('material');kind=a['model']['id'];fields={}
    if mid is not None:fields['material|'+mid]={canonical(['effect',node[1]])}
    if kind=='transfer@0.1':fields['held|'+actor]={canonical(None)}
    elif kind=='clamp@0.1':fields['clamp|'+actor]={canonical(mid)}
    elif kind=='unclamp@0.1':fields['clamp|'+actor]={canonical(None)}
    elif kind=='process@0.1':fields['history|'+actor+'|'+mid]={canonical(['append',node[1]])}
    elif kind=='circulate@0.1':fields['cycles|'+actor+'|'+mid]={canonical(['increment',node[1]])}
    elif kind in ('index@0.1','lift@0.1'):
        fields['drive|'+actor]={canonical('stopped')}
        fields[('index|' if kind=='index@0.1' else 'level|')+actor]={canonical(a['args']['target_index' if kind=='index@0.1' else 'target_level'])}
    return fields,{mid} if mid is not None else set()


def goal_dependencies(model):
    g=model.d.task['goal'];mats=set();external=set()
    if 'op' not in g:mats.add(g['material']);return mats,external
    def walk(x):
        if 'material' in x:mats.add(x['material'])
        if x['op']=='external':external.add(x['key'])
        for c in x.get('args',[]):walk(c)
        if 'arg' in x:walk(x['arg'])
    walk(g);return mats,external


def transform(model):
    catalog(model);d=model.d;goal_mats,goal_external=goal_dependencies(model)
    used={a['args']['material'] for a in d.actions.values() if 'material' in a['args']}
    for event in d.profile['events']:
        if event['kind']=='set_external':require(event['fact'] not in goal_external,'Event writes goal fact')
        else:
            require(not (set(event['materials'])&(used|goal_mats)),'Event moves a used/goal material')
            require(event['set_fact'] not in goal_external,'Replacement writes goal fact')
    notes=[];first=terminal(d.body,True)
    def external_keys(expr):
        if expr[0]=='condition':return external_keys(d.conditions[expr[1]])
        if expr[0] in ('all','any','not'):return set().union(*(external_keys(x) for x in expr[1:]))
        require(expr[0]=='is' and expr[1][1]=='world','Not immutable external-only condition')
        expression=d.env['observation_definitions'][expr[1][2][1]]
        def keys(e):
            if e['op']=='external':return {e['key']}
            if e['op'] in ('all','any'):return set().union(*(keys(x) for x in e['args']))
            if e['op']=='not':return keys(e['arg'])
            raise BadEvidence('Condition reads mutable state')
        return keys(expression)
    written_external={e['fact'] if e['kind']=='set_external' else e['set_fact'] for e in d.profile['events']}
    def children(n):
        return n[2:] if n[0] in ('seq','par') else [n[3]] if n[0]=='repeat' else [n[4]] if n[0]=='with-control' else [a[-1] for a in n[4:]] if n[0]=='branch' else []
    def material_writes(n):
        if n[0]=='invoke':
            mid=d.actions[n[1]]['args'].get('material');return {mid} if mid else set()
        return set().union(*(material_writes(c) for c in children(n)))
    before={}
    def prefix_writes(n,prior):
        before[n[1]]=set(prior);cs=children(n)
        if n[0]=='seq':
            current=set(prior)
            for c in cs:prefix_writes(c,current);current|=material_writes(c)
        elif n[0]=='par':
            for i,c in enumerate(cs):prefix_writes(c,prior|set().union(*(material_writes(x) for j,x in enumerate(cs) if j!=i)))
        elif n[0]=='repeat':
            for c in cs:prefix_writes(c,prior|(material_writes(c) if int(n[2])>1 else set()))
        else:
            for c in cs:prefix_writes(c,prior)
    prefix_writes(d.body,set())
    external_materials=set().union(*(set(e['materials']) for e in d.profile['events'] if e['kind']=='replace_carrier'))
    def immutable_material_condition(expr,prior):
        if expr[0]=='condition':return immutable_material_condition(d.conditions[expr[1]],prior)
        if expr[0] in ('all','any','not'):
            return all(immutable_material_condition(x,prior) for x in expr[1:])
        require(expr[0]=='is' and expr[1][1]=='world','Condition is not a world fact')
        def stable(e):
            if e['op'] in ('all','any'):return all(stable(c) for c in e['args'])
            if e['op']=='not':return stable(e['arg'])
            if e['op']=='external':return e['key'] not in written_external
            if e['op'] in ('at','holder','supported'):return e['material'] not in prior|external_materials
            return False
        return stable(d.env['observation_definitions'][expr[1][2][1]])
    def visit(n):
        kind=n[0]
        if kind=='invoke':w,m=action_writes(model,n);return clone(n),w,m,True
        if kind in ('await','delay'):return clone(n),{},set(),True
        if kind=='fail':return clone(n),{},set(),False
        if kind=='branch':
            can_prune=n[1]==first[1] and not d.profile['events']
            if not can_prune:
                try:can_prune=not (set().union(*(external_keys(arm[1]) for arm in n[4:-1]))&written_external)
                except (BadEvidence,KeyError,TypeError):can_prune=False
            if not can_prune:
                try:can_prune=all(immutable_material_condition(arm[1],before[n[1]]) for arm in n[4:-1])
                except (BadEvidence,KeyError,TypeError):can_prune=False
            if can_prune:
                values=[condition(d,model.initial,arm[1],[]) for arm in n[4:-1]];choice=None
                if n[2]=='exclusive':
                    if values.count(True)>1:
                        notes.append({'branch':n[1],'rule':'constant_exclusive_conflict','values':values})
                        return ['fail',n[1],'P4_CONSTANT_CONFLICT'],{},set(),False
                    if None not in values:choice=values.index(True) if True in values else len(values)
                else:
                    for i,value in enumerate(values):
                        if value is None:break
                        if value is True:choice=i;break
                    else:choice=len(values)
                if choice is not None:
                    child,w,m,ok=visit(n[4+choice][-1]);notes.append({'branch':n[1],'rule':'constant_branch','values':values,'choice':choice})
                    return ['seq',n[1],child],w,m,ok
            children=[visit(a[-1]) for a in n[4:]];valid=[x for x in children if x[3]]
            fields=set().union(*(set(x[1]) for x in valid)) if valid else set();writes={}
            for f in fields:writes[f]=set().union(*(x[1].get(f,{NO_WRITE}) for x in valid))
            changed=clone(n)
            for arm,child in zip(changed[4:],children):arm[-1]=child[0]
            return changed,writes,set().union(*(x[2] for x in children)),bool(valid)
        if kind in ('seq','par'):
            children=[visit(c) for c in n[2:]];materials=set().union(*(c[2] for c in children))
            if kind=='par' and all(c[3] for c in children):
                for i,a in enumerate(children):
                    for b in children[i+1:]:require(not (a[2]&b[2]),'Parallel branches share material effects')
                fields=set().union(*(set(c[1]) for c in children));details={}
                for f in fields:
                    writers=[c[1][f] for c in children if f in c[1]]
                    values=set().union(*(v-{NO_WRITE} for v in writers))
                    if len(writers)>1:require(len(values)<=1,'Non-confluent shared final field: '+f)
                    details[f]=sorted(values)
                notes.append({'parallel':n[1],'rule':'disjoint_materials_and_disjoint_or_constant_final_fields',
                              'materials':[sorted(c[2]) for c in children],'final_fields':details})
            writes={}
            for c in children:writes=merge_sequence(writes,c[1])
            return ['seq',n[1],*(c[0] for c in children)],writes,materials,all(c[3] for c in children)
        if kind=='repeat':
            child,w,m,ok=visit(n[3]);count=int(n[2])
            return [kind,n[1],n[2],child],w if count else {},m if count else set(),ok or count==0
        if kind=='with-control':
            child,w,m,ok=visit(n[4]);c=d.controls[d.env['controls'][n[2]]]
            return [kind,n[1],n[2],clone(n[3]),child],{**w,'drive|'+c['owner']:{canonical('stopped')}},m,ok
        raise BadEvidence('Unknown goal projection node')
    body,_,_,_=visit(d.body);shadow=clone(d);shadow.body=body;shadow.nodes={}
    def index(n):
        shadow.nodes[n[1]]=n
        cs=n[2:] if n[0] in ('seq','par') else [n[3]] if n[0]=='repeat' else [n[4]] if n[0]=='with-control' else [a[-1] for a in n[4:]] if n[0]=='branch' else []
        for c in cs:index(c)
    index(body);shadow.actions={k:v for k,v in shadow.actions.items() if k in shadow.nodes}
    shadow.profile['events']=[];shadow.case_id='p4-shadow:'+d.case_id
    return ReferenceModel(shadow),{'transformations':notes,'ignored_events':d.profile['events'],
       'used_materials':sorted(used),'goal_materials':sorted(goal_mats),'goal_external_facts':sorted(goal_external),
       'scope':'successful goal projection only; feasibility, timing and intermediate invariants are not preserved'}


def generate(model):
    shadow,proof=transform(model)
    return {'kind':'p4_goal_projection/0.1','model_digest':model.model_digest,'projection_proof':proof,
            'shadow_model_digest':shadow.model_digest,'inner':success_effects.generate(shadow)}
def check(model,payload):
    require(payload['model_digest']==model.model_digest,'Goal projection model differs')
    shadow,proof=transform(model)
    require(payload['projection_proof']==proof and payload['shadow_model_digest']==shadow.model_digest,'Projection premises/branches altered')
    result=success_effects.check(shadow,payload['inner']);result['model_digest']=model.model_digest
    return result
def verdict(query,checked):
    result=success_effects.verdict(query,checked)
    if result['verdict'] is not None:result.update(scope='parallel_and_event_goal_projection',proof_class='successful_poststate_overapproximation')
    return result
