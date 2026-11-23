"""Author the S07 virtual-linear simulation profile from verified GLB measurements.

Explicit candidate configuration, not hardware calibration. Run only to regenerate
this authoring baseline; the ordinary catalog build never overwrites author files.
"""
import copy, hashlib, json, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent/'lib'))
from scene_geometry import quaternion, qmul
root=Path(__file__).resolve().parents[1]/'public/scene/S07'
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def write(p,d):p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
report=read(root/'evidence/glb-node-geometry.json');manifest=read(root/'scene.json')
assert hashlib.sha256((root/manifest['model']).read_bytes()).hexdigest()==report['model_sha256']
nodes={n['three_name']:n for n in report['nodes']}
def parameter(value,unit,lo,hi):return {'type':'number','required':True,'default':value,'unit':unit,'min':lo,'max':hi,'mutability':'stopped_only','description':'Explicit candidate simulation parameter; not a hardware measurement'}
def new_behavior(c,name,args,fields=None):
 b={'behavior_id':name,'display_name':name,'behavior_type':'action','schedulable':True,'executor_ref':c['device_type']+'.warehouse@1','implementation_status':'pending_adapter','arguments_schema':args,
    'trigger':{'authority':'single_gateway','request_context':'run/instance/activation/request/subject'},'input_signals':['execute','request_id'],'output_signals':['accepted','busy','done','error','result_id'],
    'condition_contract':{'preconditions':[],'sustaining_conditions':[],'missing_value_policy':'unknown_blocks_execution'},
    'completion_contract':{'mode':'observed','description':'Correlated actual pose, support and ownership evidence','checks':[],'timer_or_progress_is_success':False}}
 for phase in ['ready','authorized','sustaining','completion']:
  key=name+'.'+phase;source='authorization' if phase=='authorized' else 'observation'
  label={'ready':'Valid named target, stopped axes and source/receiver availability','authorized':'All movement, material and endpoint resources owned','sustaining':'Current run and active transfer remain valid','completion':'This request has confirmed physical completion'}[phase]
  cond={'id':phase,'label':label,'source':source,'key':key,'equals':True}
  (b['completion_contract']['checks'] if phase=='completion' else b['condition_contract']['sustaining_conditions'] if phase=='sustaining' else b['condition_contract']['preconditions']).append(cond)
  c['runtime_contract'][source+'_definitions'][key]={'value_type':'boolean','provider':'warehouse_runtime','implementation_status':'pending_provider','signal_refs':[],'description':label}
 c['transport_behaviors'].append(b)
 if fields:c['runtime_execution_contract'].setdefault('payload_templates',{})[name]={'fields':fields,'status':'pending_model_adapter','encoding':'typed_references'}
target={'target':{'type':'string','required':True,'semantic_type':'location_ref','description':'Named scene endpoint'}}
for typ,version in [('lift_table','1.2.0'),('linear_rail','1.1.0')]:
 c=read(root/f'contracts/{typ}.json');c['version']=version
 c['transport_behaviors']=[];c['runtime_contract']={'observation_definitions':{},'authorization_definitions':{}}
 c['runtime_execution_contract'].update(profile='warehouse.virtual-linear@1',payload_templates={})
 if typ=='lift_table':
  c['type_specific_contract']['transfer']={'mode':'virtual_linear','orientation_policy':'preserve','load_anchor_ref':'platform.load_anchor'}
  for key,value,unit,lo,hi in [('transfer_speed_mps',.35,'m/s',.001,2),('transfer_accel_mps2',.7,'m/s²',.001,5),('transfer_max_distance_m',2,'m',.01,5)]:c['params_schema'][key]=parameter(value,unit,lo,hi)
  c['runtime_execution_contract']['transfer_policy']={'completion':'actual arrival, contact support, settled velocity and ownership commit','stop':'retain in-flight grasp and reservation; require attention','handler_motion':'not simulated'}
  new_behavior(c,'accept_material',{}, {'material':'material_ref','source':'location_ref'})
  new_behavior(c,'release_material',{}, {'material':'material_ref','target':'location_ref'})
  new_behavior(c,'transfer_material',{}, {'material':'material_ref','source':'location_ref','target':'location_ref'})
  new_behavior(c,'lift_to_location',target)
  new_behavior(c,'lift_to_level',{'move_to_level':{'type':'number','unit':'m','required':True}})
  new_behavior(c,'hold_lift',{})
 else:
  new_behavior(c,'move_to_location',target)
  new_behavior(c,'move_to_position',{'position_m':{'type':'number','unit':'m','required':True}})
  new_behavior(c,'stop_motion',{})
 write(root/f'contracts/{typ}.json',c)

for rid,lid,platform in [('T1','L1','Z_00En'),('T2','L2','Z_005n')]:
 r=read(root/f'device/{rid}.json');l=read(root/f'device/{lid}.json')
 q=quaternion(nodes[r['node_binding']['node']]['world_matrix']);inv=[-q[0],-q[1],-q[2],q[3]]
 axis=qmul(qmul(inv,[1,0,0,0]),q)[:3]
 r['calibrations']={};r['model']['simulation']={'profile':'warehouse.virtual-linear@1','axis_local':axis,'limits_m':[-4.0,.05],'limits_source':'candidate stop envelope inside measured rail; not hardware limits'}
 l['calibrations']={};l['model']['simulation']={'profile':'warehouse.virtual-linear@1','platform_node':platform,'anchor_local_m':[0,0,0],'support_size_m':[.65,.04,1.0],'limits_m':[-.11,2.0], 'limits_source':'candidate vertical travel covering belt and four shelf levels','support_source':'declared support proxy at measured Handler top'}
 l['model']['handler']['status']='visual_only_virtual_transfer'
 write(root/f'device/{rid}.json',r);write(root/f'device/{lid}.json',l)
for id,mesh in [('C1','Mesh_01cg'),('C2','Mesh_05bg')]:
 d=read(root/f'device/{id}.json');b=nodes[mesh]['bounds'];lo=b['min'];hi=b['max'];x=(lo[0]+hi[0])/2;y=hi[1]
 # Material is the user-confirmed 45 cm box. Keep its whole footprint on the belt.
 d['locations']={id+'.entry':{'frame':'scene_world_m','position':[x,y,hi[2]-.25],'status':'candidate'},id+'.exit':{'frame':'scene_world_m','position':[x,y,lo[2]+.25],'status':'candidate'}}
 d['model']['simulation']={'profile':'warehouse.virtual-linear@1','support_mesh':mesh,'flow_world':[0,0,-1]}
 write(root/f'device/{id}.json',d)
box=nodes['Visual_Components_Box_00Mn']
material={'schema_version':'scene-device/0.2','instance_id':'Workpiece','asset_kind':'material_prefab','contract_ref':'../contracts/workpiece.json','parameters':{'mass_kg':1,'height_m':box['bounds']['size'][1]},'node_binding':{'status':'bound','node':box['three_name'],'model_sha256':manifest['model_sha256']},'model':{'calibration':{'status':'pending'},'simulation':{'profile':'warehouse.virtual-linear@1','provenance':'User-confirmed GLB box; geometry measured, 1 kg retained simulation mass'}}}
write(root/'device/Workpiece.json',material)
for i in range(1,5):
 p=root/f'device/M{i:02}.json'
 if p.exists():
  dest=root/'legacy/pre-virtual-profile/device'/p.name;dest.parent.mkdir(parents=True,exist_ok=True);p.replace(dest)
manifest['devices']=[p for p in manifest['devices'] if not any(p==f'device/M{i:02}.json' for i in range(1,5))]
if 'device/Workpiece.json' not in manifest['devices']:manifest['devices'].append('device/Workpiece.json')
manifest['runtime_profile']='warehouse.virtual-linear@1'
f=read(root/'device/F1.json');bounds=nodes['Feeder_00Kn']['bounds']
f['locations']={'F1.output':{'frame':'scene_world_m','position':[(bounds['min'][0]+bounds['max'][0])/2,bounds['max'][1],bounds['min'][2]],'status':'measured_mesh_boundary'}}
write(root/'device/F1.json',f)
manifest['environment']=[{'kind':'finite_material_supply','source_device':'F1','target':'C1.entry'},{'kind':'material_takeaway','sources':['C2.exit']}]
write(root/'scene.json',manifest)
path=root/'process.py';text=path.read_text(encoding='utf-8')
import re
text=re.sub(r", 'rail_key': 'slot\d+_m', 'height_key': 'slot\d+_height_m'",'',text)
text=re.sub(r"'material': '(M\d+)'",r"'material': '\1', 'prototype': 'Workpiece'",text) if "'prototype'" not in text else text
text=text.replace("'move_to_position', position_m=calibration(T1, 'dock_m')","'move_to_location', target=C1.exit").replace("'lift_to_level', move_to_level=calibration(L1, 'dock_height_m')","'lift_to_location', target=C1.exit")
text=text.replace("'move_to_position', position_m=calibration(T2, 'dock_m')","'move_to_location', target=C2.entry").replace("'lift_to_level', move_to_level=calibration(L2, 'dock_height_m')","'lift_to_location', target=C2.entry")
for rail,lift in [('T1','L1'),('T2','L2')]:
 text=text.replace(f"'move_to_position', position_m=calibration({rail}, job.rail_key)","'move_to_location', target=job.slot").replace(f"'lift_to_level', move_to_level=calibration({lift}, job.height_key)","'lift_to_location', target=job.slot")
for lift in ['L1','L2']:
 lines=[]
 for line in text.splitlines():
  if f"{lift}, 'transfer_material'" in line:
   accept=f'target={lift}.work' in line;behavior='accept_material' if accept else 'release_material'
   line=line.replace("'transfer_material'",repr(behavior)).replace(lift+'.transfer_material',lift+'.'+behavior)
   line=line.replace(f', target={lift}.work','') if accept else line.replace(f', source={lift}.work','')
  lines.append(line)
 text='\n'.join(lines)+'\n'
text=text.replace('# Data-only DSL. Axis targets require calibration; handoffs use each lift\'s Handler.','# Named-target DSL; warehouse.virtual-linear@1 is an explicit candidate simulation profile.')
path.write_text(text,encoding='utf-8')
for name in ['conveyor','lift_table','linear_rail']:
 p=root/f'contracts/{name}.json';c=read(p)
 model={'schema_version':'ac-condition/0.1','execution_mode':'declaration_only','unknown_policy':'three_valued_fail_closed','bindings':{},'expressions':{}}
 for behavior in c['transport_behaviors']:
  conditions=behavior['condition_contract']['preconditions']+behavior['condition_contract']['sustaining_conditions']+behavior['completion_contract']['checks']
  for condition in conditions:
   if condition['source']=='parameter':continue
   key=condition['key'];c['runtime_contract'][condition['source']+'_definitions'][key]['expression_ref']=key
   model['expressions'][key]={'status':'opaque','expr':{'op':'opaque','source':condition['source'],'key':key}}
 for source in ['observation','authorization']:
  for key,definition in c['runtime_contract'][source+'_definitions'].items():
   definition['expression_ref']=key
   model['expressions'][key]={'status':'opaque','expr':{'op':'opaque','source':source,'key':key}}
 c['runtime_contract']['condition_model']=model;write(p,c)
