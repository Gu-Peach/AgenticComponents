"""Validate literal task data and typed call inputs without executing device actions."""
import math

class Quantity:
    def __init__(self,value,unit):self.value,self.unit=value,unit
class DynamicInventory(list):pass

def validate_inputs(ir,devices,goal,runtime_profile=None):
    task=ir['task'];locations={key for d in devices.values() for key in d['locations']}
    materials={j['material'] for j in task['jobs']}|{j['material'] for p in task['pallets'] for j in p['items']}
    subjects=materials|{p['id'] for p in task['pallets']}
    if not materials<=set(devices):raise ValueError('Task material has no device declaration')
    if goal['expected']['material_count']!=len(materials) or goal['expected']['pallet_count']!=task['pallet_count']:raise ValueError('Goal count differs')
    if goal['expected']['pallet_ids']!=[p['id'] for p in task['pallets']]:raise ValueError('Goal pallet identities differ')
    rows=task['jobs']+[j for p in task['pallets'] for j in p['items']]
    def need(ok,message):
        if not ok:raise ValueError(message)
    def evaluate(e,env):
        kind=e['kind']
        if kind=='literal':return e['value']
        if kind=='ref':
            if e['name']=='task':return task
            if e['name'] in env:return env[e['name']]
            need(e['name'] in devices,'Unknown symbol: '+e['name']);return e['name']
        if kind=='field':
            base=evaluate(e['base'],env)
            if isinstance(base,dict):need(e['field'] in base,'Missing field: '+e['field']);return base[e['field']]
            key=str(base)+'.'+e['field'];need(key in locations,'Unknown location: '+key);return key
        if kind in ('add','sub'):
            a,b=evaluate(e['left'],env),evaluate(e['right'],env);need(type(a)is int and type(b)is int,'Counts require integers');return a+b if kind=='add' else a-b
        args=[evaluate(a,env) for a in e.get('args',[])];kw={k:evaluate(v,env) for k,v in e.get('kwargs',{}).items()}
        if kind in ('quantity','seconds','milliseconds'):
            need(type(args[0])in(int,float) and math.isfinite(args[0]),'Quantity requires finite number')
            return Quantity(args[0],args[1] if kind=='quantity' else 's' if kind=='seconds' else 'ms')
        if kind=='calibration':
            need(type(args[1])is str,'Calibration key must be a string')
            d=devices[args[0]];record=d['calibrations'].get(args[0]+'.'+args[1]);need(record is not None,'Missing calibration')
            need(record['status']=='pending_calibration' and record['value'] is None or record['status']=='calibrated' and type(record['value'])in(int,float) and record['min']<=record['value']<=record['max'],'Invalid calibration value/status')
            return Quantity(record['value'],record['unit'])
        if kind=='subject_id':need(args[0] in subjects,'Unknown load identity');return (sorted(materials)+sorted(subjects-materials)).index(args[0])+1
        if kind=='items_at':
            need(args[0] in locations,'Unknown inventory location')
            return DynamicInventory([r for r in rows if 'source' in r and (not kw or r.get('category')==kw['category'])])
        if kind=='chunks':
            size=kw['size'];need(isinstance(args[0],list) and type(size)is int and 1<=size<=10000,'Invalid chunk size');return [args[0][i:i+size] for i in range(0,len(args[0]),size)]
        if kind=='select':
            need(isinstance(args[0],list),'Select requires list')
            for r in args[0]:need(set(kw)<=set(r),'Unknown selector field')
            return [r for r in args[0] if all(r[k]==v for k,v in kw.items())]
        if kind in ('eq','ne'):
            need(type(args[0])is type(args[1]),'Comparison types differ');return args[0]==args[1] if kind=='eq' else args[0]!=args[1]
        raise ValueError('Unsupported scene expression: '+kind)
    def check(value,typ,unit='1',schema=None):
        if unit!='1':need(isinstance(value,Quantity) and value.unit==unit,'Argument unit mismatch');value=value.value
        if value is None:return # Unresolved calibration remains an execution blocker.
        if typ=='material_ref':need(value in materials,'Invalid material reference')
        elif typ=='location_ref':need(value in locations,'Invalid location reference')
        elif typ=='robot_ref':
            need(isinstance(value,str) and devices.get(value,{}).get('contract',{}).get('device_type')=='robot_arm','Invalid robot reference')
        elif typ in ('number','integer'):
            need(type(value)in(int,float) and math.isfinite(value) and (typ!='integer' or type(value)is int),'Invalid numeric argument')
            need(not schema or schema.get('min',-math.inf)<=value<=schema.get('max',math.inf),'Argument outside contract range')
        elif typ=='boolean':need(type(value)is bool,'Expected Boolean')
        elif typ in ('string','recipe_ref'):need(type(value)is str,'Expected string')
        else:raise ValueError('Unsupported argument type: '+typ)
    visited=0
    def visit(n,env):
        nonlocal visited
        visited+=1
        need(visited<=200000,'Static expansion budget exceeded')
        kind=n['kind']
        if kind in ('seq','par'):
            for c in n['children']:visit(c,env)
        elif kind=='repeat':
            if 'count' in n:
                count=evaluate(n['count'],env);need(type(count)is int and 0<=count<=10000,'Invalid repeat count');visit(n['body'],env)
            else:
                values=evaluate(n['over'],env);limit=evaluate(n['limit'],env)
                need(isinstance(values,list) and type(limit)is int and 0<=limit<=10000,'Invalid bounded collection')
                need(limit>=task['max_items_per_pallet'] if isinstance(values,DynamicInventory) else len(values)<=limit,'Collection exceeds bound')
                need(n['bind'] not in env and n['bind'] not in devices,'Variable shadowing')
                need(bool(values),'Empty collection needs a declared element schema before compilation')
                for value in values:visit(n['body'],{**env,n['bind']:value})
        elif kind=='branch':
            for case in n['cases']:check(evaluate(case['condition'],env),'boolean');visit(case['body'],env)
            visit(n['otherwise'],env)
        elif kind=='invoke':
            id=evaluate(n['device'],env);device=devices[id];contract=device['contract'];experimental=contract.get('schema_type')!='DeviceSpec'
            bs=contract.get('transport_behaviors',contract.get('definition',{}).get('behaviors',[]))
            behavior=next(b for b in bs if b.get('behavior_id',b.get('id'))==n['behavior'])
            schema=behavior.get('arguments_schema',{p['id']:p for p in behavior.get('arguments',[])})
            for key,expr in n['arguments'].items():
                p=schema[key];value=evaluate(expr,env);check(value,p['type'],p.get('unit','1'),p)
                if p.get('semantic_type')=='location_ref':need(value in locations,'Unknown named location')
                if n['behavior']=='transport_to_position' and key=='target':need(value in device.get('position_targets',{}),'Unknown scene transport target')
                if n['behavior']=='rotate_to_station' and key=='angleTag':
                    policy=contract.get('type_specific_contract',{}).get('indexing_policy',{})
                    if 'home_deg' in policy and 'process_deg' in policy:
                        stations=policy.get('stations_deg',[policy['home_deg'],policy['process_deg']])
                        need(isinstance(stations,list) and all(type(v) in (float,int) and 0<=v<360 for v in stations)
                             and policy['home_deg'] in stations and policy['process_deg'] in stations,'Invalid indexing stations on '+id)
                        need(value.value is None or value.value in stations,'Unknown indexing station at '+n['id'])
                if p['type']=='recipe_ref':need(value in device.get('recipes',{}),'Unknown device recipe')
                if ((n['behavior'],key) in {('move_to_position','position_m'),('lift_to_level','move_to_level')}
                        and isinstance(value,Quantity) and value.value is not None):
                    sim=contract.get('type_specific_contract',{}).get('simulation',{})
                    if sim.get('limits_m'):
                        offset=0
                        if n['behavior']=='lift_to_level':
                            geom=sim.get('platform_geometry')
                            if geom and 'geometry' in device:
                                from scene_geometry import qmul
                                q=geom['world_rotation']
                                anchor=qmul(qmul(q,[*sim['anchor_local_m'],0]),[-q[0],-q[1],-q[2],q[3]])
                                offset=geom['world_position'][1]+anchor[1]-device['geometry']['world_position'][1]
                        lo,hi=sim['limits_m']
                        need(lo<=value.value-offset<=hi,f"{id}.{n['id']}.{key}: axis target outside travel limits")
            if 'payload' in n:
                payload=n['payload'];key=payload['args'][0]['value'];record=device['command_payloads'].get(key)
                allowed={n['behavior']}
                if runtime_profile=='robot-handoff@1' and contract.get('device_type')=='robot_arm' and n['behavior']=='pick_and_place':
                    # Explicit existing signatures choose the acquire/handoff or held/place phase.
                    allowed.update(b['behavior_id'] for b in bs if b.get('behavior_id') in ('pick_and_handoff','place_held_material') and key==id+'.'+b['behavior_id'])
                need(record and record['instance']==id and record['behavior'] in allowed,'Payload redirects behavior')
                required=record['fields'];optional=record.get('optional_fields',{})
                need(not (required.keys() & optional.keys()),'Ambiguous required and optional payload fields')
                need(required.keys() <= payload['kwargs'].keys() <= (required.keys() | optional.keys()),'Payload fields differ')
                types={**required,**optional}
                fields={key:evaluate(expr,env) for key,expr in payload['kwargs'].items()}
                for key in fields:
                    typ=types[key]
                    if typ=='grasp_frame_ref':
                        material=devices.get(fields.get('material'),{})
                        grasping=material.get('contract',{}).get('type_specific_contract',{}).get('grasping',{})
                        need(isinstance(fields[key],str) and fields[key] in grasping.get('frames',{}),'Unknown material grasp frame')
                    elif typ in ('tool_interface_ref','process_interface_ref'):
                        owner=device if typ=='tool_interface_ref' else devices.get(fields.get('material'),{})
                        matches=[port for port in owner.get('contract',{}).get('interfaces',[]) if port.get('interface_id')==fields[key]]
                        need(len(matches)==1,'Unknown or ambiguous interface on '+str(owner.get('instance_id'))+': '+str(fields[key]))
                    else:check(fields[key],typ)
                if 'tool_interface_ref' in record['fields'].values() and 'process_interface_ref' in record['fields'].values():
                    def interface(owner,typ):
                        key=next(k for k,v in record['fields'].items() if v==typ)
                        return next(p['capabilities']['snap'] for p in owner['contract']['interfaces'] if p['interface_id']==fields[key])
                    tool=interface(device,'tool_interface_ref')
                    port=interface(devices[fields['material']],'process_interface_ref')
                    need(tool['role'] in port['accepts'] and port['role'] in tool['accepts'],'Tool and material process interfaces are incompatible')
                if 'receiver' in fields and record['fields']['receiver']=='robot_ref':
                    need(fields['receiver']!=id,'Handoff receiver must differ from giver')
                if {'giver_grasp','receiver_grasp'}<=fields.keys():
                    need(fields['giver_grasp']!=fields['receiver_grasp'],'Handoff requires distinct grasp frames')
                routes=device.get('transfer_routes')
                if n['behavior'] in ('transfer_material','accept_material','release_material') and routes is not None:
                    source=evaluate(payload['kwargs']['source'],env) if 'source' in payload['kwargs'] else id+'.work'
                    target=evaluate(payload['kwargs']['target'],env) if 'target' in payload['kwargs'] else id+'.work'
                    need(any(source in route['sources'] and target in route['targets'] for route in routes),'Transfer route is not declared for this lift')
        elif kind=='delay':
            q=evaluate(n['duration'],env);need(isinstance(q,Quantity) and q.unit in ('s','ms') and q.value>=0,'Invalid delay')
        elif kind!='fail':raise ValueError('Unsupported scene operator: '+kind)
    visit(ir['body'],{})
