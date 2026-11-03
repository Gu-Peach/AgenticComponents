"""Explicit diagnostic definitions; never replace original corpus inputs."""
from .frontend import load
from .state import initial
from .common import clone,digest


def small(workspace,name='single',nondeterministic=False,faults=()):
    d=load(workspace,'S04-P01');s=initial(d);p=s['plant']
    d.descriptor['schema_type']='CorpusCase'
    d.initial={'materials':list(p['materials'].values()),'device_states':p['devices'],'occupancy':p['ledger'],
      'reservations':{},'external':{},'protocol':{'active_requests':[],'grants':{},'completed_requests':{},'attention_required':False}}
    d.env['bindings']['world']={'type':'service','id':'world'}
    d.profile.update(accept=[1,1],phase=[1,2] if nondeterministic else [1,1],stop=[1,1],feedback=[0,0],events=[],
                     faults=list(faults),max_faults=1 if faults else 0,response_window=40,pilot_migration=False,
                     source_scope='hand-authored-P2-fixture/0.1')
    for policy in d.env['policies'].values():policy.update(gate_ticks=24,accept_ticks=4,execute_ticks=32,stop_ticks=4)
    original=clone(d.nodes['load']);d.actions={'load':clone(d.actions['load'])}
    if name=='single':body=original
    elif name in ('disjoint','shared_material','capacity'):
        if name=='disjoint':
            d.devices['S2']={**clone(d.devices['S']),'id':'S2'}
            d.locations['S2.work']={**clone(d.locations['S.work']),'id':'S2.work','owner':'S2','zone_ref':'S2.zone'}
            d.relations['resources'].append({'id':'S2.zone'});d.initial['device_states']['S2']=clone(d.initial['device_states']['S'])
            d.initial['occupancy']['S2.work']=[]
            source,target,material='S2.work','C2.entry','M2'
        elif name=='capacity':source,target,material='C1.exit','C2.entry','M2'
        else:source,target,material='S.work','C2.entry','M1'
        if material=='M2':
            d.initial['materials'].append({'id':'M2','type':'workpiece','region':source,'support':source,
                                          'holder':d.locations[source]['owner'],'held_by':None})
            d.initial['occupancy'][source].append('M2')
        peer=clone(d.actions['load']);peer.update(device='R2',args={'material':material,'source':source,'target':target})
        d.actions['peer']=peer
        d.relations['transfer_edges'].append({'device':'R2','source':source,'target':target})
        if name=='capacity':
            d.actions['load']['args']['target']='C2.entry'
            d.relations['transfer_edges'].append({'device':'R1','source':'S.work','target':'C2.entry'})
            for a in d.actions.values():a['model']['resource_claims'].remove('target.zone')
        for alias,typ,value in [('peer_material','material',material),('peer_source','location',source),('peer_target','location',target)]:
            d.env['bindings'][alias]={'type':typ,'id':value}
        peer_node=['invoke','peer','r2','transfer_material',['args',
            ['material',['binding','peer_material']],['source',['binding','peer_source']],['target',['binding','peer_target']]],original[5]]
        if name=='capacity':
            d.env['bindings']['capacity_target']={'type':'location','id':'C2.entry'}
            original[4][-1]=['target',['binding','capacity_target']]
        body=['par','parallel',original,peer_node]
    elif name=='parallel_failure':body=['par','parallel',original,['seq','delayed_failure',['delay','short','4','ms'],['fail','failure','INJECTED']]]
    else:raise ValueError(name)
    d.task={'goal':{'op':'all','args':[{'op':'no_active_requests'},{'op':'no_grants'}]}}
    set_program(d,body);d.case_id='fixture-'+name
    d.input_digest=digest({'fixture':name,'definition':d.__dict__})
    return d


def set_program(d,body):
    nodes={}
    def visit(n):
        nodes[n[1]]=n
        children=n[2:] if n[0] in ('seq','par') else [n[3]] if n[0]=='repeat' else [n[4]] if n[0]=='with-control' else [x[-1] for x in n[4:]] if n[0]=='branch' else []
        for child in children:visit(child)
    visit(body);d.body=body;d.nodes=nodes;d.actions={k:v for k,v in d.actions.items() if k in nodes}
    return d
