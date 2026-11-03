"""Validate constructed cases without pretending to solve their execution paths."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from collections import Counter


class CorpusError(ValueError):
    def __init__(self,code,message):self.code=code;super().__init__(message)

def need(value,code,message):
    if not value:raise CorpusError(code,message)

def read(path):
    def pairs(items):
        result={}
        for key,value in items:
            need(key not in result,'INVALID_JSON','duplicate key '+key);result[key]=value
        return result
    return json.loads(Path(path).read_text(encoding='utf-8-sig'),object_pairs_hook=pairs)

def load_parser(dsl):
    spec=importlib.util.spec_from_file_location('corpus_existing_frontend',Path(dsl)/'tools/check_design.py')
    module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module);return module

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def bind_case(root,cid,parser,overrides=None):
    folder=root/'cases'/cid;case=read(folder/'case.json')
    need(case['case_id']==cid,'INVALID_INPUT','case ID mismatch')
    paths={k:(folder/v).resolve() for k,v in case['inputs'].items()}
    if overrides:
        key_by_filename={'process.acp':'process','environment.json':'environment','initial-state.json':'initial','task-spec.json':'task','property-set.json':'properties','query-plan.json':'queries'}
        for name,path in overrides.items():paths[key_by_filename[name]]=Path(path).resolve()
    need(all(p.is_relative_to(root.resolve()) and p.is_file() for p in paths.values()),'INVALID_INPUT','missing/outside input')
    try: ir,mapping=parser.lower(paths['process'].read_text(encoding='utf-8'),f'cases/{cid}/process.acp')
    except parser.DesignError as error:raise CorpusError('INVALID_SYNTAX',str(error)) from error
    env=read(paths['environment']);initial=read(paths['initial']);task=read(paths['task']);sid=case['scene_id']
    scene=read(root/f'scenes/{sid}/instances.json');rel=read(root/f'scenes/{sid}/relations.json')
    devs={d['id']:copy.deepcopy(d) for d in scene['devices']+env.get('auxiliary_devices',[])}
    locs={l['id']:copy.deepcopy(l) for l in scene['locations']+env.get('auxiliary_locations',[])}
    for dev,values in env.get('scene_parameter_overrides',{}).items():
        need(dev in devs,'INVALID_BINDING','unknown override device')
        devs[dev]['parameters'].update(values)
        for loc in locs.values():
            if loc['owner']==dev and not loc.get('slot'):loc['capacity']=devs[dev]['parameters']['capacity']
    mats={m['id']:m for m in initial['materials']};bind=env['bindings']
    need(len(mats)==len(initial['materials']),'INVALID_INPUT','duplicate material ID')
    known={'material':set(mats),'device':set(devs),'location':set(locs),'service':{'world@0.1','handoff@0.1'}}
    for key,b in bind.items():need(b['type'] in known and b['id'] in known[b['type']],'INVALID_BINDING','unknown alias '+key)
    contracts={dev:read(root/'shared/device-contracts'/f'{item["device_type"]}.json') for dev,item in devs.items()}
    resources={r['id']:r for r in rel['resources']+env.get('auxiliary_resources',[])}
    for loc in locs.values():need(loc['zone_ref'] in resources,'INVALID_BINDING','location zone resource missing')
    models={d['id']:d for d in (read(p) for p in (root/'shared/verification-contracts').glob('*.json'))}
    nodes={n['node_id']:n for n in ir['nodes']};controls={c['id']:c for c in rel['control_scopes']}
    resolved={}
    def visit(key,enclosing=None):
        n=nodes[key]
        if n['kind'] in ('with-control','invoke'):
            need(n['policy_ref'] in env['policies'],'INVALID_BINDING','unknown policy')
        if n['kind']=='with-control':
            ref=env['controls'].get(n['control_ref']);need(ref in controls,'INVALID_BINDING','unknown control')
            visit(n['child'],ref);return
        if n['kind']=='invoke':
            target=bind.get(n['target_ref']);need(target and target['type']=='device','INVALID_BINDING','invalid target')
            dev=target['id'];cap=contracts[dev]['capabilities'].get(n['behavior_id'])
            need(cap is not None,'UNKNOWN_CAPABILITY',dev+'.'+n['behavior_id'])
            model=models[cap['verification_ref']];params=model['parameters']
            need(set(n['arguments'])==set(params),'INVALID_TYPE','argument names mismatch')
            args={}
            for name,expr in n['arguments'].items():
                if expr['kind']=='binding':
                    b=bind.get(expr['binding_ref']);need(b is not None and b['type']==params[name],'INVALID_TYPE',key+'.'+name)
                    args[name]=b['id']
                else:
                    need(expr['kind']==params[name] and type(expr.get('value')) is int,'INVALID_TYPE',key+'.'+name)
                    args[name]=expr['value']
            if model['id']=='transfer@0.1':
                need(any(e['device']==dev and e['source']==args['source'] and e['target']==args['target'] for e in rel['transfer_edges']),
                     'INVALID_BINDING','undeclared transfer edge')
            if model['id'] in ('transport@0.1','circulate@0.1'):
                need(enclosing is not None and controls[enclosing]['owner']==dev,'INVALID_BINDING','transport/control owner mismatch')
            if model['id'] in ('process@0.1','clamp@0.1'):
                need(locs[args['location']]['owner']==dev,'INVALID_BINDING','operation location belongs to other device')
            for param,count in [('target_index','index_count'),('target_level','level_count')]:
                if param in args:need(0<=args[param]<devs[dev]['parameters'][count],'INVALID_TYPE','axis target outside range')
            resolved[key]={'device':dev,'behavior':n['behavior_id'],'arguments':args}
        for child in parser.edges(n):visit(child,enclosing)
    visit(ir['entry'])
    if case['schema_type']=='PilotCase':
        return {'ir':ir,'mapping':mapping,'paths':paths,'node_count':len(nodes),'schema':'pilot','resolved':resolved}
    definitions=env['observation_definitions']
    def expr(e):
        op=e['op']
        if op=='all':
            need(bool(e['args']),'INVALID_INPUT','empty all');[expr(x) for x in e['args']];return
        need(op in ('at','holder','supported','drive_stopped','operation_count','cycle_count','index_is','unclamped','tools_empty','drives_stopped','no_active_requests','no_grants','external'),
             'INVALID_INPUT','unknown expression '+op)
        if 'material' in e:need(e['material'] in mats,'INVALID_BINDING','unknown expression material')
        if 'location' in e:need(e['location'] in locs,'INVALID_BINDING','unknown expression location')
        if 'device' in e:need(e['device'] in devs,'INVALID_BINDING','unknown expression device')
        if op=='external':need(e['key'] in initial['external'],'INVALID_BINDING','unknown external fact')
        if op.endswith('_count'):need(type(e['count']) is int and e['count']>=0,'INVALID_TYPE','nonnegative count')
    for e in definitions.values():expr(e)
    expr(task['goal'])
    for p in parser.predicates(ir):
        for leaf in parser.leaves(p,ir['conditions']):
            r=leaf['read'];need(r['source']=='observation' and r['owner_ref']=='world' and r['key'] in definitions,'INVALID_BINDING','unknown world observation')
    occupied=Counter()
    for m in mats.values():
        need(m['region'] in locs and m['support']==m['region'] and m['holder']==locs[m['region']]['owner'],'INVALID_INITIAL','material region/support/holder mismatch')
        occupied[m['region']]+=1
    for loc,count in occupied.items():need(count<=locs[loc]['capacity'],'INVALID_INITIAL','location over capacity '+loc)
    for dev,item in devs.items():
        total=sum(n for loc,n in occupied.items() if locs[loc]['owner']==dev)
        need(total<=item['parameters']['capacity'],'INVALID_INITIAL','owner over capacity '+dev)
        need(dev in initial['device_states'],'INVALID_INITIAL','missing device initial state')
    need({k:sorted(v) for k,v in initial['occupancy'].items() if v}==
         {loc:sorted(m['id'] for m in mats.values() if m['region']==loc) for loc in occupied},'INVALID_INITIAL','occupancy ledger mismatch')
    for event in env['events']:
        need(type(event['tick']) is int and event['tick']>=0,'INVALID_INPUT','event tick')
        if event['kind']=='set_external':need(event['fact'] in initial['external'],'INVALID_BINDING','event fact')
        elif event['kind']=='replace_carrier':
            need(event['carrier'] in devs and event['destination'] in locs and set(event['materials'])<=set(mats),'INVALID_BINDING','carrier event refs')
            need(event['set_fact'] in initial['external'],'INVALID_BINDING','carrier event fact')
        else:raise CorpusError('INVALID_INPUT','unknown event kind')
    return {'ir':ir,'mapping':mapping,'paths':paths,'node_count':len(nodes),'schema':'corpus','resolved':resolved}


def canonical(data):
    ir=data['ir'];nodes={n['node_id']:n for n in ir['nodes']};env=read(data['paths']['environment'])
    def pred(p):
        if p['kind']=='ref':return pred(ir['conditions'][p['condition_ref']])
        if p['kind']=='is' and p['read'].get('owner_ref')=='world':return env.get('observation_definitions',{}).get(p['read']['key'],p)
        return p
    def node(key):
        n=nodes[key];out={'kind':n['kind']}
        if n['kind']=='invoke':out.update(data['resolved'][key])
        if n['kind']=='await':out.update(condition=pred(n['condition']),timeout=n['timeout'])
        if n['kind'] in ('seq','par'):out['children']=[node(c) for c in n['children']]
        if n['kind']=='with-control':out.update(control=env['controls'][n['control_ref']],child=node(n['child']))
        if n['kind']=='repeat':out.update(count=n['count'],child=node(n['child']))
        if n['kind']=='branch':out.update(cases=[{'condition':pred(c['condition']),'child':node(c['child'])} for c in n['cases']],otherwise=node(n['otherwise']))
        return out
    initial=read(data['paths']['initial']);task=read(data['paths']['task'])
    payload={'tree':node(ir['entry']),'initial':initial,'goal':task['goal'],'events':env.get('events',[]),'overrides':env.get('scene_parameter_overrides',{})}
    return hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def validate(root,dsl,output):
    root=Path(root).resolve();parser=load_parser(dsl);manifest=read(root/'manifest.json');ids=manifest['cases']
    need(len(ids)==576 and len(set(ids))==576,'INVALID_CORPUS','expected 576 unique cases')
    results=[];fingerprints={};bad=[]
    for index,cid in enumerate(ids,1):
        expected={'DS01':'INVALID_SYNTAX','DS02':'INVALID_TYPE','DS03':'UNKNOWN_CAPABILITY'}.get(cid.rsplit('-',1)[-1],'VALID')
        try:
            bound=bind_case(root,cid,parser);actual='VALID';diagnostic=''
            if read(root/'cases'/cid/'case.json')['parent_id'] is None:fingerprints[cid]=canonical(bound)
        except CorpusError as error:actual=error.code;diagnostic=str(error)
        match=actual==expected
        results.append({'case_id':cid,'structural_status':actual,'matches_construction_intent':match,'diagnostic':diagnostic,
                        'path_result':'not_inferred_from_structure'})
        if not match:bad.append(results[-1])
        desc=read(root/'cases'/cid/'case.json')
        if desc['parent_id']:
            parent=root/'cases'/desc['parent_id'];pd=read(parent/'case.json')
            actual_task=(root/'cases'/cid/desc['inputs']['task']).resolve();expected_task=(parent/pd['inputs']['task']).resolve()
            need(actual_task==expected_task,'TARGET_LEAK','mutant task differs')
        if index%48==0:print(f'Checked {index}/576 cases; unexpected={len(bad)}',flush=True)
    duplicate=[];seen={}
    for cid,fp in fingerprints.items():
        if fp in seen:duplicate.append([seen[fp],cid])
        else:seen[fp]=cid
    need(not duplicate,'DUPLICATE_PARENT',str(duplicate))
    counts=Counter(r['structural_status'] for r in results)
    summary={'case_count':576,'parent_count':len(fingerprints),'structural_counts':dict(counts),'unexpected_count':len(bad),
       'unexpected':bad,'exact_canonical_parent_duplicates':duplicate,
       'D-S':len(manifest['subsets']['D-S']),'D-V':len(manifest['subsets']['D-V']),
       'D-E':len(manifest['subsets']['D-E']),'D-R':len(manifest['subsets']['D-R']),'D-X':len(manifest['subsets']['D-X']),
       'path_truth_not_established':True,'cases':results}
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (output.parent/'parent-fingerprints.json').write_text(json.dumps(fingerprints,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in summary.items() if k!='cases'},ensure_ascii=False),flush=True)
    return not bad


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--dataset',type=Path,required=True);p.add_argument('--dsl-root',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    try:sys.exit(0 if validate(a.dataset,a.dsl_root,a.output) else 1)
    except CorpusError as error:print(f'{error.code}: {error}');sys.exit(1)
