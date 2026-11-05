"""Strictly audit current DSL calls against the authoritative DeviceSpec catalog."""
import argparse,json,sys
from pathlib import Path
from declarative_frontend import compile_source
ROOT=Path(__file__).resolve().parents[1]
def read(p):return json.loads(Path(p).read_text(encoding='utf-8-sig'))
def walk(value):
    if isinstance(value,dict):
        yield value
        for child in value.values():yield from walk(child)
    elif isinstance(value,list):
        for child in value:yield from walk(child)
def audit_scene(ir,binding,specs,interfaces=None,batch=None):
    errors=[];blockers=[];calls=0
    def error(code,message,node=None):errors.append(dict(code=code,message=message,source=node.get('source') if node else None))
    for id,instance in binding['instances'].items():
        spec=specs.get(instance['contract'])
        if spec is None:error('UNKNOWN_CONTRACT',id+': '+instance['contract']);continue
        if spec.get('schema_type')!='DeviceSpec':blockers.append(dict(code='EXPERIMENTAL_ASSET',instance=id,contract=instance['contract']));continue
        if instance.get('version')!=spec['version']:error('INSTANCE_VERSION_REBIND_REQUIRED',id+': instance revision differs from canonical DeviceSpec')
        unknown=set(instance.get('parameters',{}))-set(spec['params_schema'])
        if unknown:error('INSTANCE_PARAMETERS_REBIND_REQUIRED',id+': '+', '.join(sorted(unknown)))
        blockers.append(dict(code='PENDING_ADAPTER_AND_CALIBRATION',instance=id))
    for node in walk(ir['body']):
        if node.get('kind')=='fact':blockers.append(dict(code='SCENE_FACT_PROVIDER_REQUIRES_BINDING',fact=node['args'][0].get('value')))
        if node.get('kind')!='invoke':continue
        calls+=1;target=node['device']
        if target['kind']!='ref':error('DYNAMIC_DEVICE_REQUIRES_TYPED_BINDING','Resolve dynamic instance before checking',node);continue
        id=target['name'];instance=binding['instances'].get(id)
        if instance is None:error('UNKNOWN_INSTANCE',id,node);continue
        spec=specs.get(instance['contract'])
        if spec is None:continue
        if spec.get('schema_type')!='DeviceSpec':
            if not any(b['id']==node['behavior'] for b in spec.get('definition',{}).get('behaviors',[])):error('BEHAVIOR_NOT_IN_DEVICE_CONTRACT',id+'.'+node['behavior'],node)
            error('EXPERIMENTAL_BEHAVIOR_NOT_ADMITTED',id+'.'+node['behavior'],node);continue
        behavior=next((b for b in spec['transport_behaviors'] if b['behavior_id']==node['behavior']),None)
        if behavior is None:error('BEHAVIOR_NOT_IN_DEVICE_CONTRACT',id+'.'+node['behavior'],node);continue
        if not behavior['schedulable'] or behavior['behavior_type'] in ('internal','observer','passive') or behavior['completion_contract']['mode']=='continuous':error('NOT_DISCRETE_SCHEDULABLE',id+'.'+node['behavior'],node)
        schema=behavior['arguments_schema'];given=set(node['arguments']);required={k for k,v in schema.items() if v.get('required')}
        if given-set(schema) or required-given:error('ARGUMENTS_DIFFER_FROM_CONTRACT',f"{id}.{node['behavior']}: missing={sorted(required-given)}, unknown={sorted(given-set(schema))}",node)
        variants=spec['runtime_execution_contract'].get('argument_variants',{}).get(behavior['behavior_id'])
        if variants:
            selector=variants['selector_parameter'];mode=instance.get('parameters',{}).get(selector,spec['params_schema'][selector].get('default'));variant=variants['variants'].get(mode)
            if variant is None or set(variant['required'])-given or set(variant['forbidden'])&given:error('ARGUMENT_MODE_MISMATCH',id+'.'+behavior['behavior_id'],node)
        for name,expr in node['arguments'].items():
            if name not in schema:continue
            p=schema[name]
            if expr['kind']=='quantity':
                unit=expr['args'][1].get('value')
                if unit!=p.get('unit'):error('ARGUMENT_UNIT_MISMATCH',id+'.'+name,node)
            elif expr['kind']=='calibration' and ir['language']=='ac-declarative/0.3':pass
            elif p.get('unit') and p['unit']!='1':error('ARGUMENT_UNIT_REQUIRED',id+'.'+name,node)
            elif expr['kind']=='field' and p['type']=='integer':blockers.append(dict(code='IDENTITY_REGISTRY_ADAPTER_REQUIRED',node=node['id'],argument=name))
        for gate in behavior.get('applicability',{}).get('conditions',[]):
            name=gate['parameter'];resolved=instance.get('parameters',{}).get(name,spec['params_schema'][name].get('default'))
            if resolved!=gate['equals']:error('BEHAVIOR_NOT_APPLICABLE',id+'.'+node['behavior'],node)
        blockers.append(dict(code='PENDING_BEHAVIOR_IMPLEMENTATION',node=node['id'],behavior=behavior['behavior_id']))
        if behavior['trigger'].get('payload_binding_status')=='pending_model_specific_payload':
            blockers.append(dict(code='MODEL_SPECIFIC_PAYLOAD_BINDING_REQUIRED',node=node['id']))
            error('ACTION_PAYLOAD_ADAPTER_REQUIRED',id+'.'+behavior['behavior_id']+': scalar arguments do not constitute the required model command payload',node)
    if ir['language'] in ('ac-declarative/0.2','ac-declarative/0.3'):
        from declarative_bindings import validate_declaration
        if interfaces is None or batch is None:error('DECLARATION_CONTEXT_REQUIRED','Declaration requires registered interfaces and batch')
        else:
            declaration_errors,declaration_blockers=validate_declaration(ir,binding,specs,interfaces,batch)
            errors.extend(declaration_errors);blockers.extend(declaration_blockers)
    references_valid=not any(e['code'] not in ('ACTION_PAYLOAD_ADAPTER_REQUIRED','EXPERIMENTAL_BEHAVIOR_NOT_ADMITTED') for e in errors)
    result=dict(scene=ir['scene_id'],syntax_valid=True,declaration_references_valid=references_valid,contract_binding_valid=not errors,executable=False,calls=calls,errors=errors,blockers=blockers)
    if ir['language']=='ac-declarative/0.3':
        obligations=[]
        for node in walk(ir['body']):
            if node.get('kind')!='invoke' or node['device']['kind']!='ref':continue
            device=node['device']['name'];instance=binding['instances'].get(device)
            if instance is None:continue
            spec=specs.get(instance['contract'],{})
            if spec.get('schema_type')=='ExperimentalAssetContract':
                b=next((b for b in spec['definition']['behaviors'] if b['id']==node['behavior']),None)
                if b:obligations.append(dict(node=node['id'],instance=device,behavior=b['id'],scope='experimental_not_admitted',preconditions=b['preconditions'],sustaining=b['sustaining_conditions'],completion=b['completion'],unknown_policy='block_not_success'))
                continue
            behavior=next((b for b in spec.get('transport_behaviors',[]) if b['behavior_id']==node['behavior']),None)
            if behavior is None:continue
            obligations.append(dict(node=node['id'],instance=device,behavior=behavior['behavior_id'],
                preconditions=[device+'/'+c['key'] for c in behavior['condition_contract']['preconditions']],
                sustaining=[device+'/'+c['key'] for c in behavior['condition_contract']['sustaining_conditions']],
                completion=[device+'/'+c['key'] for c in behavior['completion_contract']['checks']],
                request_identity='run/instance/request/activation',unknown_policy='block_not_success'))
        result['automatic_obligations']=dict(behaviors=obligations,process=binding.get('process_contract'),collections=binding.get('collection_bindings'),iterations=binding.get('iteration_contracts',{}))
    return result
def audit_all(root=ROOT):
    root=Path(root);sys.path.insert(0,str(root/'asset_contracts/tools'))
    from validate_device_specs import validate_bundle
    validation=validate_bundle(root/'asset_contracts')
    if not validation['valid']:return dict(schema_version='strict-device-binding-audit/1.0',asset_definition_valid=False,contract_binding_valid=False,executable=False,errors=validation['errors'],scenes=[])
    catalog=read(root/'asset_contracts/catalog.json');specs={e['id']:read(root/'asset_contracts'/e['path']) for e in catalog['assets']};results=[]
    for entry in read(root/'process-catalog.json')['scenes']:
        p=root/entry['path'];ir=compile_source((p/'process.py').read_text(encoding='utf-8'),(Path(entry['path'])/'process.py').as_posix());results.append(audit_scene(ir,read(p/'bindings.json'),specs,read(root/'declarative_dsl/interfaces.json'),read(p/'batch.json')))
        if ir['language']=='ac-declarative/0.3':
            task=read(p/'task-spec.json');batch=read(p/'batch.json');pallets=batch.get('pallets',[])
            expected=task.get('expected',{});materials=[x['material'] for x in batch.get('jobs',[])]+[x['material'] for pallet in pallets for x in pallet['items']]
            if expected.get('material_ids')!=materials or expected.get('pallet_ids')!=[x['id'] for x in pallets] or expected.get('material_count')!=len(materials) or expected.get('pallet_count')!=len(pallets):
                results[-1]['errors'].append(dict(code='INDEPENDENT_GOAL_MISMATCH',message='Batch identities/counts differ from independent task-spec',source=None))
                results[-1]['contract_binding_valid']=False;results[-1]['declaration_references_valid']=False
    return dict(schema_version='strict-device-binding-audit/1.0',asset_definition_valid=True,contract_binding_valid=all(r['contract_binding_valid'] for r in results),executable=False,scenes=results)
def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT);p.add_argument('--output',type=Path);a=p.parse_args()
    try:
        result=audit_all(a.root);text=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
        if a.output:a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(text,encoding='utf-8')
        else:print(text,end='')
        return 0 if result['contract_binding_valid'] else 2
    except (ValueError,KeyError,TypeError,OSError) as e:print(str(e),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
