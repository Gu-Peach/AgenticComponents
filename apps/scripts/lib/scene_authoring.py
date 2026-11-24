"""One-time conversion to shared contracts and compact scene instance declarations."""
import copy, json, re
from pathlib import Path

ROBOT_PARAMETERS={'joint_speed_rad_s','joint_accel_rad_s2','settle_speed_rad_s','ik_position_tolerance_m',
                  'ik_max_iterations','ik_mode','max_payload_kg','lift_height'}

def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def contract_core(raw,manifest):
    contract=copy.deepcopy(raw)
    for key in ('source','modeling_status','notes','description'):contract.pop(key,None)
    if contract.get('schema_type')!='DeviceSpec':return contract
    contract['asset']={'model_format':'glb','model_key':'../'+manifest['model'],'sha256':manifest['model_sha256']}
    t=contract['type_specific_contract']
    for key in ('scene_geometry','scene_conveying_geometry','scene_material_geometry','calibration_status','model_binding_status'):t.pop(key,None)
    if contract['device_type']=='robot_arm':
        contract['params_schema']={k:v for k,v in contract['params_schema'].items() if k in ROBOT_PARAMETERS}
        contract['params_schema']['ik_mode']['options']=['position_only']
        t.clear();t.update(coordinate_system={'length_unit':'m','joint_angle_unit':'rad','up_axis':'Y'},
            ik={'solver':'ccd_position','mode_param':'ik_mode','position_tolerance_param':'ik_position_tolerance_m','max_iterations_param':'ik_max_iterations'},
            trajectoryConfig={'motion_mode':'joint_ptp','joint_speed_param':'joint_speed_rad_s','joint_acceleration_param':'joint_accel_rad_s2'})
    elif contract['device_type']=='conveyor':
        t['node_bindings']=[{'role':'upper_belt_surface','status':'requires_instance_mapping'}]
    elif contract['device_type']=='workpiece_carrier' and t.get('slots',{}).get('layout')=='explicit_measured':
        t['slots']={'layout':'explicit_from_prefab'}
        for key in ('collision_geometry_roots','excluded_material_roots'):t.get('physics',{}).pop(key,None)
    for behavior in contract['transport_behaviors']:
        behavior.pop('source',None)
        applicability=behavior.get('applicability')
        if applicability is not None:applicability.pop('description',None)
    for registry in contract['runtime_contract'].values():
        if isinstance(registry,dict):
            for definition in registry.values():
                if not isinstance(definition,dict):continue
                for key in ('description','source_requirement','semantic_source','identity','evaluation'):definition.pop(key,None)
    execution=contract['runtime_execution_contract']
    for key in ('payload_contract_reference','payload_binding_rule','model_profile_refs'):execution.pop(key,None)
    return contract

def compact_device(old,reference,core):
    binding=old['node_binding'];compact={'schema_version':'scene-device/0.2','instance_id':old['instance_id'],'contract_ref':reference}
    if old.get('asset_kind') and old['asset_kind']!='device':compact['asset_kind']=old['asset_kind']
    if core.get('schema_type')=='DeviceSpec':base={k:v['default'] for k,v in core['params_schema'].items() if 'default'in v};allowed=set(core['params_schema'])
    else:base={p['id']:p['default'] for p in core['definition']['parameters'] if 'default'in p};allowed={p['id'] for p in core['definition']['parameters']}
    parameters={k:v for k,v in old.get('parameters',{}).items() if k in allowed and (k not in base or v!=base[k])}
    if parameters:compact['parameters']=parameters
    compact['node_binding']={'status':binding['status']}
    if binding['status']=='bound':
        compact['node_binding'].update(node=binding['root']['three_name'],model_sha256=binding['model_sha256'])
        if binding.get('owned_geometry_roots'):compact['node_binding']['geometry_nodes']=[n['three_name'] for n in binding['owned_geometry_roots']]
    locations=copy.deepcopy(old.get('locations',{}))
    for key,location in locations.items():
        location.pop('owner',None)
        if key.endswith('.home') and old.get('robot_geometry'):
            location.clear();location.update(node=old['robot_geometry']['flange']['node']['three_name'],frame='flange_pose_scene_world_m',status='rest_pose_only_clearance_unvalidated')
    if old.get('asset_kind')=='carrier_prefab':locations={}
    if locations:compact['locations']=locations
    for key in ('calibrations','command_payloads','recipes','initial_inventory','subject_id'):
        if old.get(key) not in (None,{},[]):
            compact[key]=copy.deepcopy(old[key])
            if key=='calibrations':
                for value in compact[key].values():value.pop('source',None)
    templates=core.get('runtime_execution_contract',{}).get('payload_templates',{})
    payloads=compact.get('command_payloads',{})
    if payloads and all(key==old['instance_id']+'.'+value['behavior'] and value['behavior'] in templates and
                        value['fields']==templates[value['behavior']]['fields'] and value.get('optional_fields',{})==templates[value['behavior']].get('optional_fields',{}) and value['status']==templates[value['behavior']]['status']
                        for key,value in payloads.items()):compact.pop('command_payloads')
    robot=old.get('robot_geometry');model={}
    if robot:
        specific=old['contract']['type_specific_contract']
        model['urdf']={'joints':[{'nodeName':j['node']['three_name'],'axis':j.get('axis'),'limit':j.get('limit')} for j in robot['joint_chain']]}
        tooling=specific['tooling']
        model['tooling']={k:copy.deepcopy(tooling[k]) for k in ('flange_node_name','tcp_local_frame','simulation_tool') if k in tooling}
        if tooling.get('tcp_node_name')!=tooling['flange_node_name']:model['tooling']['tcp_node_name']=tooling['tcp_node_name']
        model['gripper']=copy.deepcopy(specific['gripper'])
    elif old.get('conveying_geometry'):
        g=old['conveying_geometry'];model['surface']={k:g[k] for k in ('frame','flow_axis','candidate_support_height_m','collision_proxy')}
    elif old.get('source_service'):
        model['supply']={k:old['source_service'][k] for k in ('unit','carrier_template','output_target','status')}
    elif old.get('material_geometry'):
        model['collision']={k:old['material_geometry']['collision_proxy'][k] for k in ('kind','status')}
    for key in ('carrier_network','line_indexing'):
        if old.get(key):model[key]=old[key]
    if old.get('required_confirmations'):model['calibration']={'status':'pending'}
    if model:compact['model']=model
    if old.get('prefab'):
        compact['prefab']={'kind':'loaded_carrier','material_template':old['prefab']['material_template'],
            'slots':[{'id':s['id'],'node':s['source_node']['three_name'],'category':s['appearance']['semantic_category'],'variant':s['appearance']['visual_variant']} for s in old['prefab']['slots']]}
    return compact

def compact_scene(folder):
    folder=Path(folder);manifest=json.loads((folder/'scene.json').read_text(encoding='utf-8-sig'))
    originals={}
    for file in manifest['devices']:
        path=(folder/file).resolve()
        if folder.resolve() not in path.parents:raise ValueError('Device path escapes scene')
        originals[file]=json.loads(path.read_text(encoding='utf-8-sig'))
    if all(d.get('schema_version')=='scene-device/0.2' for d in originals.values()):return
    if any(d.get('schema_version')!='scene-device/0.1' for d in originals.values()):raise ValueError('Mixed device authoring versions')
    provenance={d['instance_id']:d['parameter_evidence'] for d in originals.values() if d.get('parameter_evidence')}
    if provenance:write(folder/'evidence/parameter-provenance.json',{'schema_version':'parameter-provenance/0.1','note':'Measurement/configuration evidence; active parameters are defined by shared contracts and instance overrides.','devices':provenance})
    cores={};references={}
    for file,device in originals.items():
        raw=device['contract'];name=raw.get('device_type','processing_station')
        if not re.fullmatch(r'[a-z][a-z0-9_]*',name):raise ValueError('Invalid shared contract name')
        core=contract_core(raw,manifest)
        payloads={p['behavior']:{**{k:p.get(k) for k in ('fields','status','target_payload_schema')}, **({'optional_fields':p['optional_fields']} if 'optional_fields' in p else {})} for p in device.get('command_payloads',{}).values()}
        if payloads:core.setdefault('runtime_execution_contract',{})['payload_templates']=payloads
        if name in cores and core!=cores[name]:raise ValueError('Different contracts cannot silently share a profile: '+name)
        # A scene shares the behavior definition; model binding is always per instance.
        if name not in cores:
            cores[name]=core;target=folder/'contracts'/f'{name}.json';write(target,core)
            references[name]='../contracts/'+name+'.json'
        compact=compact_device(device,references[name],cores[name]);write(folder/file,compact)
