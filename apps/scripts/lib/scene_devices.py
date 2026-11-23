"""Resolve compact authored devices into the representation consumed by the compiler."""
import copy, hashlib, json
import math
from pathlib import Path
from scene_geometry import SceneGeometry, quaternion, relative_pose
from condition_model import validate_condition_model

def defaults(contract):
    if contract.get('schema_type')=='DeviceSpec':return {k:v['default'] for k,v in contract['params_schema'].items() if 'default'in v}
    return {p['id']:p['default'] for p in contract['definition']['parameters'] if 'default'in p}

def derive_robot(model,geometry,root_index,base):
    result=copy.deepcopy(base);result.update(copy.deepcopy(model));result['rootNodeName']=geometry.selector(root_index)['three_name']
    result.setdefault('coordinate_system',{'length_unit':'m','joint_angle_unit':'rad','up_axis':'Y'})
    calibration=result.setdefault('calibration',{'status':'pending'})
    calibration.setdefault('source','GLB-derived rest poses; axes/limits require validation')
    joints=result.get('urdf',{}).get('joints',[]);previous=root_index;compiled=[]
    if joints and len(joints)!=6:raise ValueError('Current articulated profile requires six joints')
    for i,joint in enumerate(joints):
        axis=joint.get('axis');limit=joint.get('limit')
        if 'limit' not in joint:raise ValueError('Joint limit must be explicit: null means unbounded; omitted means unspecified')
        if axis is not None and (not isinstance(axis,list) or len(axis)!=3 or not all(type(v)in(int,float) and math.isfinite(v) for v in axis) or abs(math.sqrt(sum(v*v for v in axis))-1)>1e-5):raise ValueError('Invalid joint axis')
        if limit is not None and (not isinstance(limit,dict) or not all(type(limit.get(k))in(int,float) and math.isfinite(limit[k]) for k in ('lower','upper')) or not limit['lower']<limit['upper'] or not limit['lower']<=0<=limit['upper']):raise ValueError('Invalid joint limits')
        index=geometry.resolve(joint['nodeName']);position,rotation=relative_pose(geometry.world(previous),geometry.world(index))
        ancestor=index
        while ancestor!=previous and ancestor in geometry.parents:ancestor=geometry.parents[ancestor]
        if ancestor!=previous or index==previous:raise ValueError('Joint chain does not follow GLB hierarchy')
        compiled.append({'name':joint.get('name',f'joint_{i+1}'),'nodeName':geometry.selector(index)['three_name'],
            'parent_joint':None if i==0 else compiled[-1]['name'],'type':'revolute','axis_frame':'joint_local',
            'axis':joint.get('axis'),'limit':joint.get('limit'),'rest_position':position,'rest_quaternion':rotation,
            'render_rest_quaternion':geometry.nodes[index].get('rotation',[0,0,0,1]),
            'velocity_limit_param':'joint_speed_rad_s','acceleration_limit_param':'joint_accel_rad_s2'})
        previous=index
    if joints:result['urdf']={'format':'project_urdf_like','structure_mode':'serial','joints':compiled}
    tooling=result.get('tooling')
    if tooling:
        flange=geometry.resolve(tooling['flange_node_name']);tcp=geometry.resolve(tooling.get('tcp_node_name',tooling['flange_node_name']))
        position,rotation=relative_pose(geometry.world(previous),geometry.world(tcp))
        tooling.update(flange_node_name=geometry.selector(flange)['three_name'],tcp_node_name=geometry.selector(tcp)['three_name'],
                       rest_position=position,rest_quaternion=rotation)
    return result

def generated_signals(instance,contract):
    return {p['port_id']:{'logical_signal':instance+'/'+p['port_id'],'direction':p['direction'],'plc_type':p['plc_type'],
                         'unit':p.get('unit','1'),'retention':p['retention']} for p in contract.get('signal_ports',[])}

def load_scene_devices(folder,manifest,gltf):
    folder=Path(folder).resolve();geometry=SceneGeometry(gltf);devices={};inputs={}
    def path(value,base=folder):
        result=(base/value).resolve()
        if folder not in result.parents:raise ValueError('Device reference escapes scene package')
        return result
    def read(file):
        inputs[file.relative_to(folder).as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
        return json.loads(file.read_text(encoding='utf-8-sig'))
    for file in manifest['devices']:
        filename=path(file);authored=read(filename)
        if authored.get('schema_version')!='scene-device/0.2':raise ValueError('Compact scene-device/0.2 required')
        reference=authored['contract_ref'];contract_file=path(reference,filename.parent)
        contract=read(contract_file);instance=authored['instance_id']
        if contract.get('schema_type')=='DeviceSpec':
            if not all(key in contract for key in ('version','params_schema','signal_ports','transport_behaviors','type_specific_contract','runtime_contract','runtime_execution_contract')):raise ValueError('Invalid shared contract')
            validate_condition_model(contract)
        elif contract.get('schema_type')!='ExperimentalAssetContract' or 'definition' not in contract:raise ValueError('Invalid shared contract')
        if instance in devices:raise ValueError('Duplicate instance identity')
        allowed=set(contract.get('params_schema',{})) if contract.get('schema_type')=='DeviceSpec' else {p['id'] for p in contract['definition']['parameters']}
        if set(authored.get('parameters',{}))-allowed:raise ValueError('Unsupported instance parameter')
        params={**defaults(contract),**authored.get('parameters',{})}
        if contract.get('schema_type')=='DeviceSpec':
            for key,value in params.items():
                spec=contract['params_schema'][key];kind=spec['type']
                if kind in ('number','integer'):
                    if type(value)not in(int,float) or not math.isfinite(value) or kind=='integer' and type(value)is not int or not spec.get('min',-math.inf)<=value<=spec.get('max',math.inf):raise ValueError('Invalid parameter value: '+key)
                elif kind=='enum':
                    if value not in spec['options']:raise ValueError('Unsupported parameter option: '+key)
                elif kind=='boolean' and type(value)is not bool:raise ValueError('Invalid Boolean parameter')
        binding=authored['node_binding'];resolved={'status':binding['status'],'model_sha256':binding.get('model_sha256',manifest['model_sha256']),'node_indices':[]}
        if resolved['model_sha256']!=manifest['model_sha256']:raise ValueError('Stale node binding')
        root_index=None
        if binding['status']=='bound':
            root_index=geometry.resolve(binding['node']);owned_roots=[geometry.resolve(n) for n in binding.get('geometry_nodes',[binding['node']])]
            for selected in owned_roots:
                ancestor=selected
                while ancestor!=root_index and ancestor in geometry.parents:ancestor=geometry.parents[ancestor]
                if ancestor!=root_index:raise ValueError('Geometry lies outside device root')
            resolved.update(node_indices=[root_index],root=geometry.selector(root_index),owned_mesh_indices=geometry.meshes(owned_roots))
        elif binding['status']!='unresolved':raise ValueError('Invalid authored binding status')
        device={k:copy.deepcopy(v) for k,v in authored.items() if k not in ('contract_ref','model','calibration')}
        device.update(contract=contract,parameters=params,node_binding=resolved,locations=copy.deepcopy(authored.get('locations',{})))
        device['calibrations']=copy.deepcopy(authored.get('calibrations',{}))
        templates=contract.get('runtime_execution_contract',{}).get('payload_templates',{})
        device['command_payloads']={instance+'.'+key:{'instance':instance,'behavior':key,'contract_version':contract['version'],**copy.deepcopy(value)} for key,value in templates.items()}
        device['command_payloads'].update(copy.deepcopy(authored.get('command_payloads',{})))
        model=authored.get('model',{})
        device['required_confirmations']=['contact_and_motion_validation'] if model.get('calibration',{}).get('status')=='pending' else []
        for ordinal,joint in enumerate(model.get('urdf',{}).get('joints',[]),1):
            for key in ('axis',):
                if joint.get(key) is None:device['required_confirmations'].append(f'joint_{ordinal}.{key}')
        if root_index is not None:
            device['geometry']=geometry.geometry(root_index,resolved['owned_mesh_indices'])
            if contract.get('schema_type')=='DeviceSpec':
                contract['asset'].update(root_node_index=root_index,root_node_name=geometry.nodes[root_index].get('name',''))
        if contract.get('schema_type')=='DeviceSpec':
            specific=contract.setdefault('type_specific_contract',{})
            if contract['device_type']=='robot_arm' and root_index is not None:
                contract['type_specific_contract']=derive_robot(model,geometry,root_index,specific)
                contract['type_specific_contract']['calibration']['asset_sha256']=manifest['model_sha256']
            else:specific.update(copy.deepcopy(model))
        for location,record in device['locations'].items():
            record.setdefault('owner',instance)
            if 'node' in record:
                index=geometry.resolve(record.pop('node'));matrix=geometry.world(index)
                record.update(position=matrix[12:15],rotation_quaternion=quaternion(matrix))
        if authored.get('asset_kind')=='carrier_prefab' and authored['prefab']['kind'] not in ('loaded_carrier','empty_carrier'):
            raise ValueError('Unknown carrier prefab kind')
        if authored.get('asset_kind')=='carrier_prefab' and authored['prefab']['kind']=='loaded_carrier':
            prefab=authored['prefab'];slots=[]
            support_bounds=None
            if 'slot_support_node' in prefab:
                support_meshes=geometry.meshes([geometry.resolve(prefab['slot_support_node'])])
                if not support_meshes or not set(support_meshes)<=set(resolved['owned_mesh_indices']):
                    raise ValueError('Slot support must belong to its carrier geometry')
                support_bounds=geometry.bounds(support_meshes)
            for slot in prefab['slots']:
                index=geometry.resolve(slot['node'])
                anchor=geometry.world(index)
                if support_bounds is not None:
                    if any(not support_bounds['min'][i]<=anchor[12+i]<=support_bounds['max'][i] for i in (0,2)):
                        raise ValueError('Slot is outside its declared support')
                    anchor=list(anchor)
                    anchor[13]=support_bounds['max'][1]
                position,_=relative_pose(geometry.world(root_index),anchor)
                normalized={'id':slot['id'],'source_node':geometry.selector(index),'source_mesh_indices':geometry.meshes([index]),
                    'source_world':geometry.geometry(index),'carrier_relative_position_m':position,'material_template':prefab['material_template'],
                    'appearance':{'semantic_category':slot['category'],'visual_variant':slot['variant']}}
                slots.append(normalized)
                device['locations'][instance+'.'+slot['id']]={'owner':instance,'frame':'carrier_local_m','position':position,'status':'measured_explicit_slot'}
            device['prefab']={**prefab,'slots':slots};device['node_binding']['excluded_subtrees']=[s['source_node']['index'] for s in slots]
        device['signal_bindings']=generated_signals(instance,contract)
        devices[instance]=device
    def descendant(child,root):
        while child!=root and child in geometry.parents:child=geometry.parents[child]
        return child==root
    for instance,device in devices.items():
        specific=device['contract'].get('type_specific_contract',{})
        if device['contract'].get('device_type')=='linear_rail':
            mounted=devices.get(specific.get('mounted_device'))
            if not mounted or mounted['contract'].get('device_type')!='lift_table':raise ValueError('Rail requires a declared mounted lift')
            if mounted['contract']['type_specific_contract'].get('mounted_on')!=instance:raise ValueError('Rail/lift mounting references disagree')
            moving=geometry.resolve(specific['moving_node'])
            if moving!=mounted['node_binding']['root']['index']:raise ValueError('Rail moving node differs from mounted lift root')
            if not descendant(moving,device['node_binding']['root']['index']):raise ValueError('Mounted lift is outside rail assembly')
        if specific.get('transfer',{}).get('kind')=='platform_handler' or specific.get('transfer',{}).get('mode')=='virtual_linear':
            root=device['node_binding'].get('root',{}).get('index')
            platform=geometry.resolve(specific['lift_motion']['platform_node'])
            handler=geometry.resolve(specific['handler']['node'])
            if root is None or not descendant(platform,root) or not descendant(handler,platform):raise ValueError('Lift platform/handler hierarchy differs')
        simulation=specific.get('simulation',{})
        if simulation.get('profile')=='warehouse.virtual-linear@1' and device['node_binding'].get('root'):
            root=device['node_binding']['root']['index']
            simulation['root_rotation']=quaternion(geometry.world(root))
            if 'platform_node' in simulation:
                platform=geometry.resolve(simulation['platform_node'])
                simulation['platform_geometry']=geometry.geometry(platform)
                simulation['platform_meshes']=geometry.meshes([platform])
            if 'support_mesh' in simulation:
                index=geometry.resolve(simulation['support_mesh'])
                if not descendant(index,root):raise ValueError('Support mesh outside device')
                simulation['support_geometry']=geometry.geometry(index)
    return devices,inputs
