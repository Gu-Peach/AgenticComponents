"""S04 experimental binder; uses the existing ac-process parser and IR checks."""
import importlib.util
import json
import sys
from pathlib import Path


class InputError(ValueError):
    def __init__(self, code, message):
        self.code=code
        super().__init__(message)


def require(ok, code, message):
    if not ok: raise InputError(code,message)


def read(path):
    def pairs(items):
        result={}
        for k,v in items:
            require(k not in result,'INVALID_JSON',f'duplicate key {k}')
            result[k]=v
        return result
    def invalid(value): raise InputError('INVALID_JSON',f'nonfinite {value}')
    return json.loads(Path(path).read_text(encoding='utf-8-sig'),object_pairs_hook=pairs,parse_constant=invalid)


def parser_at(dsl_root):
    path=Path(dsl_root)/'tools/check_design.py'
    spec=importlib.util.spec_from_file_location('ac_pilot_existing_frontend',path)
    module=importlib.util.module_from_spec(spec)
    sys.modules[spec.name]=module
    spec.loader.exec_module(module)
    return module


def load_case(dataset, case_id, dsl_root):
    dataset=Path(dataset).resolve(); folder=dataset/'cases'/case_id
    descriptor=read(folder/'case.json')
    require(descriptor.get('profile_scope')=='s04-pilot-timed-microsteps/0.1','UNSUPPORTED_MODEL','use the corpus checker for non-pilot inputs; generic path solver pending')
    require(descriptor['case_id']==case_id,'INVALID_INPUT','case identity')
    paths={}
    for key,ref in descriptor['inputs'].items():
        p=(folder/ref).resolve()
        require(p.is_relative_to(dataset),'INVALID_INPUT','input path outside dataset')
        paths[key]=p
    parser=parser_at(dsl_root)
    try:
        ir,mapping=parser.lower(paths['process'].read_text(encoding='utf-8'),f'cases/{case_id}/process.acp')
    except parser.DesignError as error:
        raise InputError('INVALID_SYNTAX',str(error)) from error
    inputs={k:read(p) for k,p in paths.items() if k!='process'}
    env=inputs['environment']; initial=inputs['initial']
    require(descriptor['scene_id']=='S04','UNSUPPORTED_MODEL','pilot supports S04 only')
    require(ir['environment_ref']=='environment.json','INVALID_INPUT','logical environment name differs')
    require(ir['execution_profile_ref'] in env['profiles'],'INVALID_INPUT','unknown execution profile')
    require(len(initial['materials'])==1 and initial['material']==initial['materials'][0]['id'],
            'UNSUPPORTED_MODEL','pilot requires exactly one material')
    require(initial['material']=='M1','UNSUPPORTED_MODEL','pilot uses the fixed M1 identity')
    require(set(inputs['task']['goal'])=={'material','region','holder','support','held_by','drives','no_grants','no_active_request'},
            'UNSUPPORTED_MODEL','task goal fields outside pilot vocabulary')
    require(set(inputs['task']['goal']['drives'])=={'C1','C2'},'UNSUPPORTED_MODEL','task drive fields')
    require({p['id'] for p in inputs['properties']['properties']}=={'V01','V04','V05','V06','V07','V08','V09','V10a'},
            'UNSUPPORTED_MODEL','pilot property set differs')
    require(type(inputs['queries']['bound_ticks']) is int and inputs['queries']['bound_ticks']>0 and
            type(inputs['queries']['state_budget']) is int and inputs['queries']['state_budget']>0,
            'INVALID_INPUT','positive bounds and state budget required')
    scene=read(dataset/'scenes/S04/instances.json'); relations=read(dataset/'scenes/S04/relations.json')
    devices={d['id']:d for d in scene['devices']}; locations={p['id']:p for p in scene['locations']}
    contracts={d['id']:read(dataset/'shared/device-contracts'/f'{d["device_type"]}.json') for d in scene['devices']}
    models={m['id']:m for m in (read(p) for p in (dataset/'shared/verification-contracts').glob('*.json'))}
    bindings=env['bindings']; resolved={}
    known={'device':set(devices),'location':set(locations),'material':{initial['material']},'service':{'handoff@0.1'}}
    for alias, binding in bindings.items():
        require(binding['type'] in known and binding['id'] in known[binding['type']], 'INVALID_BINDING',f'unknown {alias}')
    for node in ir['nodes']:
        require(node['kind'] in ('seq','invoke','with-control','await'), 'UNSUPPORTED_MODEL',f'unsupported node {node["kind"]}')
        if node['kind'] in ('invoke','with-control'):
            require(node['policy_ref'] in env['policies'],'INVALID_INPUT','unknown policy')
        if node['kind']=='invoke':
            alias=node['target_ref']; behavior=node['behavior_id']
            require(alias in bindings and bindings[alias]['type']=='device','INVALID_BINDING','invoke target')
            dev=bindings[alias]['id']; caps=contracts[dev]['capabilities']
            require(behavior in caps,'UNKNOWN_CAPABILITY',f'{dev}.{behavior}')
            model=models[caps[behavior]['verification_ref']]
            require(model['id'] in ('transfer@0.1','transport@0.1'),'UNSUPPORTED_MODEL','unsupported action model')
            require(set(node['arguments'])==set(model['parameters']),'INVALID_TYPE','argument names differ')
            args={}
            for name,expr in node['arguments'].items():
                require(expr['kind']=='binding','UNSUPPORTED_MODEL','pilot accepts nominal binding arguments only')
                b=bindings.get(expr['binding_ref'])
                require(b is not None and b['type']==model['parameters'][name],'INVALID_TYPE',f'{node["node_id"]}.{name} requires {model["parameters"][name]}')
                args[name]=b['id']
            if model['id']=='transfer@0.1':
                require(any(e['device']==dev and e['source']==args['source'] and e['target']==args['target'] for e in relations['transfer_edges']),
                        'INVALID_BINDING','transfer edge not declared')
            resolved[node['node_id']]={'device':dev,'model':model,'args':args}
        if node['kind']=='with-control':
            require(node['control_ref'] in env['controls'],'INVALID_BINDING','unknown control')
            ref=env['controls'][node['control_ref']]
            require(any(c['id']==ref for c in relations['control_scopes']),'INVALID_BINDING','missing scene control')
    for p in parser.predicates(ir):
        for leaf in parser.leaves(p,ir['conditions']):
            r=leaf['read']
            require(r['source']=='observation','UNSUPPORTED_MODEL','pilot observation reads only')
            require(r['key'] in env['observations'].get(r['owner_ref'],[]),'INVALID_BINDING','unknown observation')
            require(leaf['equals']['kind']=='boolean','INVALID_TYPE','observation boolean expected')
            if 'subject_ref' in r:
                require(bindings.get(r['subject_ref'],{}).get('type')=='material','INVALID_TYPE','subject must be material')
            require('slot_ref' not in r,'UNSUPPORTED_MODEL','slots unsupported in S04 pilot')
    inputs.update(descriptor=descriptor,ir=ir,source_map=mapping,paths=paths,scene=scene,relations=relations,
                  resolved=resolved,models=models,dataset=dataset,dsl_root=Path(dsl_root))
    return inputs
