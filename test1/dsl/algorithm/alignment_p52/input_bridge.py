"""Compare complete executable node meanings, not merely node-kind counts."""


def ref_expr(e):
    kind=e[0]
    if kind=='condition':return dict(kind='ref',condition_ref=e[1])
    if kind in ('all','any'):return dict(kind=kind,operands=[ref_expr(c) for c in e[1:]])
    if kind=='not':return dict(kind='not',operand=ref_expr(e[1]))
    if kind!='is' or e[1][0]!='observation':raise ValueError('Unmapped condition')
    read=e[1];r=dict(source='observation',owner_ref=read[1],key=read[2][1])
    for qualifier in read[3:]:
        if qualifier[0]=='subject':r['subject_ref']=qualifier[1]
        elif qualifier[0]=='request':r['request_node_ref']=qualifier[1]
        else:raise ValueError('Unmapped observation qualifier')
    return dict(kind='is',read=r,equals=dict(kind='boolean',value=e[-1]=='true'))


def compare_inputs(sut,ref):
    from acverify_v3.core import ticks
    from reference.common import duration
    left={};right={}
    for name,n in sut.nodes.items():
        value=dict(kind=n['kind']);kind=n['kind']
        if kind in ('seq','par'):value['children']=n['children']
        elif kind=='repeat':value.update(child=n['child'],count=n['count'])
        elif kind=='branch':value.update(mode=n['mode'],timeout=ticks(n['timeout']),cases=n['cases'],otherwise=n['otherwise'])
        elif kind=='await':value.update(condition=n['condition'],timeout=ticks(n['timeout']))
        elif kind=='delay':value['ticks']=ticks(n['duration'])
        elif kind=='fail':value['code']=n['code']
        elif kind=='with-control':value.update(child=n['child'],control=n['control_ref'],policy=n['policy_ref'])
        elif kind=='invoke':
            a=sut.actions[name];value.update(device=a['device'],behavior=a['behavior'],arguments=a['arguments'],model=a['model_ref'],policy=n['policy_ref'])
        else:raise ValueError('Unmapped SUT node')
        left[name]=value
    for name,n in ref.d.nodes.items():
        kind=n[0];value=dict(kind=kind)
        if kind in ('seq','par'):value['children']=[c[1] for c in n[2:]]
        elif kind=='repeat':value.update(child=n[3][1],count=int(n[2]))
        elif kind=='branch':value.update(mode=n[2],timeout=duration(n[3]),
            cases=[dict(condition=ref_expr(c[1]),child=c[-1][1]) for c in n[4:-1]],otherwise=n[-1][-1][1])
        elif kind=='await':value.update(condition=ref_expr(n[2]),timeout=duration(n[3]))
        elif kind=='delay':value['ticks']=duration(n[2:])
        elif kind=='fail':value['code']=n[2]
        elif kind=='with-control':value.update(child=n[4][1],control=n[2],policy=n[3][1])
        elif kind=='invoke':
            a=ref.d.actions[name];value.update(device=a['device'],behavior=a['behavior'],arguments=a['args'],model=a['model']['id'],policy=n[5][1])
        else:raise ValueError('Unmapped reference node')
        right[name]=value
    conditions={k:ref_expr(e) for k,e in ref.d.conditions.items()}
    fields=('accept','phase','stop','feedback','events','faults','max_faults','forced_stop_loss','max_age')
    return dict(nodes=left==right,conditions=sut.ir['conditions']==conditions,entry=sut.ir['entry']==ref.d.body[1],
        environment=sut.data['environment']==ref.d.env,models=sut.models==ref.d.models,devices=sut.devices==ref.d.devices,
        locations=sut.locations==ref.d.locations,task=sut.data['task']==ref.d.task,
        resource_relations=sut.data['relations']==ref.d.relations,
        profile=all(sut.profile[k]==ref.d.profile[k] for k in fields),response_window=sut.data['queries'].get('response_window_ticks')==ref.d.profile['response_window'])
