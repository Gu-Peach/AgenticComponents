"""Compile data-only scene processes; never execute process.py or descriptive predicates."""
import argparse, ast, copy, hashlib, json, struct, sys
from pathlib import Path
from urllib.parse import quote
sys.path.insert(0, str(Path(__file__).parent / 'lib'))
from declarative_frontend import Parser
from scene_binding_check import validate_inputs
from scene_prefabs import expand_prefabs
from scene_devices import load_scene_devices
from scene_layout import validate_sorting_station, bind_position_targets

def read(path): return json.loads(path.read_text(encoding='utf-8-sig'))
def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def confined(root, value):
    p=(root/value).resolve()
    if root.resolve() not in p.parents: raise ValueError('Path escapes scene: '+value)
    return p
def walk(v):
    if isinstance(v,dict):
        yield v
        for x in v.values():yield from walk(x)
    elif isinstance(v,list):
        for x in v:yield from walk(x)

class SceneParser(Parser):
    def compile(self):
        self.need(len(self.tree.body)==1,self.tree,'Only a process declaration is permitted')
        root=self.tree.body[0];name,args,kw=self.header(root)
        self.need(name=='process' and len(args)==1 and set(kw)=={'version','devices','task','goal'},root,'Scene process requires version/devices/task/goal')
        self.need(self.literal(kw['version'])=='ac-declarative/0.4',root,'Scene process version must be 0.4')
        self.need(self.literal(kw['devices'])=='./device' and self.literal(kw['goal'])=='./task-spec.json',root,'Unsupported scene entry paths')
        constructor,pa,pk=self.call(kw['task'])
        self.need(constructor=='production' and not pa and set(pk) in ({'jobs','pallets'},{'carrier_template','count'}),root,'Production accepts finite jobs/pallets or carrier_template/count')
        request={k:ast.literal_eval(v) for k,v in pk.items()}
        if 'carrier_template' in request:
            self.need(type(request['carrier_template'])is str and type(request['count'])is int and 1<=request['count']<=10000,root,'Invalid prefab production')
            task={'jobs':[],'pallets':[]}
        else:task=request
        self.need(all(isinstance(v,list) and len(v)<=10000 for v in task.values()),root,'Production must be bounded lists')
        rows=task['jobs']+[x for p in task['pallets'] for x in p['items']]
        ids=[x['material'] for x in rows]
        self.need(len(ids)==len(set(ids)) and len(ids)<=10000,root,'Duplicate or excessive material identities')
        task.update(material_count=len(ids),pallet_count=len(task['pallets']),job_count=len(task['jobs']),max_items_per_pallet=max((len(p['items']) for p in task['pallets']),default=0))
        if 'carrier_template' in request:task['prefab_request']=request;task['pallet_count']=request['count']
        self.language='ac-declarative/0.3'
        body=self.one_child(root.body,root,0)
        if any(n.get('kind')=='ref' and n.get('name')=='batch' for n in walk(body)):raise ValueError('Use task, not legacy batch')
        return {'schema_version':'ac-coordination-ir/0.4','language':'ac-declarative/0.4','scene_id':self.literal(args[0]),'task':task,'body':body}

def migrate(source, output, contracts):
    for folder in sorted(source.glob('S[0-9][0-9]')):
        destination=output/folder.name
        if (destination/'scene.json').exists():continue
        bindings=read(folder/'bindings.json');batch=read(folder/'batch.json')
        models=list(folder.rglob('*.glb'))
        if len(models)!=1:raise ValueError('Expected one scene GLB: '+folder.name)
        model=models[0];model_relative=model.relative_to(folder).as_posix()
        destination.mkdir(parents=True,exist_ok=True)
        # Model bytes remain untouched; a separate destination is useful for staging.
        if source.resolve()!=output.resolve():
            (destination/model_relative).parent.mkdir(parents=True,exist_ok=True)
            (destination/model_relative).write_bytes(model.read_bytes())
        task={'jobs':batch.get('jobs',[]),'pallets':batch.get('pallets',[])}
        tree=ast.parse((folder/'process.py').read_text(encoding='utf-8'))
        class Names(ast.NodeTransformer):
            def visit_Name(self,n):
                if n.id=='batch':n.id='task'
                return n
        tree=Names().visit(tree);header=tree.body[0].items[0].context_expr
        header.keywords=[ast.keyword(arg='version',value=ast.Constant('ac-declarative/0.4')),
                         ast.keyword(arg='devices',value=ast.Constant('./device')),
                         ast.keyword(arg='task',value=ast.parse('production(jobs='+repr(task['jobs'])+', pallets='+repr(task['pallets'])+')',mode='eval').body),
                         ast.keyword(arg='goal',value=ast.Constant('./task-spec.json'))]
        ast.fix_missing_locations(tree)
        (destination/'process.py').write_text('# Scene assets are resolved from device; this is data-only DSL.\n'+ast.unparse(tree)+'\n',encoding='utf-8')
        (destination/'task-spec.json').write_bytes((folder/'task-spec.json').read_bytes())
        devices=[]
        for id,instance in bindings['instances'].items():
            contract=read(contracts/(instance['contract']+'.json'))
            file='device/'+id+'.json';devices.append(file)
            write(destination/file,{'schema_version':'scene-device/0.1','instance_id':id,'contract':contract,
                'parameters':instance['parameters'],'node_binding':{'status':'unresolved','model_sha256':digest(model),'node_indices':[]},
                'locations':{k:v for k,v in bindings['locations'].items() if v['owner']==id},
                'initial_inventory':bindings.get('initial',{}).get('carriers',{}).get(id),
                'calibrations':{k:v for k,v in bindings.get('calibrations',{}).items() if k.startswith(id+'.')},
                'recipes':{k:v for k,v in bindings.get('recipes',{}).items() if v['station']==id},
                'carrier_network':bindings.get('carrier_network',{}).get(id),
                'line_indexing':bindings.get('line_indexing',{}).get(id),
                'subject_id':bindings.get('identity_registry',{}).get('entries',{}).get(id),
                'command_payloads':{k:v for k,v in bindings.get('command_payloads',{}).items() if v['instance']==id},
                'condition_bindings':{k:v for k,v in bindings.get('condition_bindings',{}).items() if k.startswith(id+'/')}})
        write(destination/'scene.json',{'schema_version':'scene-package/0.1','id':folder.name,'name':folder.name,
            'model':model_relative,'model_sha256':digest(model),'process':'process.py','goal':'task-spec.json','devices':devices,
            'lifecycle':bindings.get('process_contract',{}),'iteration_contracts':bindings.get('iteration_contracts',{}),
            'collection_bindings':bindings.get('collection_bindings',{}),'environment':bindings.get('environment_events',[]),
            'initial':bindings.get('initial',{}),'legacy_inputs':'not_loaded_by_scene_runtime'})
        from scene_authoring import compact_scene
        compact_scene(destination)

def build(root, scene=None, output=None):
    output=Path(output) if output is not None else root
    if scene is not None and (len(scene)!=3 or not scene.startswith('S') or not scene[1:].isdigit()):raise ValueError('Invalid scene selection')
    entries=[]
    for folder in sorted(root.glob('S[0-9][0-9]')):
        if scene is not None and folder.name!=scene:continue
        manifest=read(folder/'scene.json');model=confined(folder,manifest['model'])
        if digest(model)!=manifest['model_sha256']:raise ValueError('Scene model hash changed: '+folder.name)
        source=confined(folder,manifest['process']);ir=SceneParser(source.read_text(encoding='utf-8'),manifest['process']).compile()
        if ir['scene_id']!=manifest['id']:raise ValueError('Scene identity mismatch')
        goal=read(confined(folder,manifest['goal']))
        materials=[j['material'] for j in ir['task']['jobs']]+[j['material'] for p in ir['task']['pallets'] for j in p['items']]
        raw=model.read_bytes();length,kind=struct.unpack_from('<II',raw,12)
        if raw[:4]!=b'glTF' or kind!=0x4e4f534a:raise ValueError('Invalid GLB')
        gltf=json.loads(raw[20:20+length].decode('utf-8'))
        inventory=[{'index':i,'name':n.get('name',''),'children':n.get('children',[]),'mesh':n.get('mesh')} for i,n in enumerate(gltf.get('nodes',[]))]
        devices,device_sources=load_scene_devices(folder,manifest,gltf)
        sorting_station=validate_sorting_station(manifest,devices)
        bind_position_targets(manifest,devices)
        inputs={manifest['process']:digest(source),manifest['goal']:digest(confined(folder,manifest['goal'])),'scene.json':digest(folder/'scene.json'),**device_sources};blockers=[]
        mesh_owners={}
        for id,d in devices.items():
            if d['node_binding']['model_sha256']!=manifest['model_sha256']:raise ValueError('Stale device node binding')
            selection=d['node_binding']['node_indices'];status=d['node_binding']['status']
            if status not in ('unresolved','bound') or status=='bound' and not selection:raise ValueError('Invalid node binding status')
            if len(selection)!=len(set(selection)) or any(type(i)is not int or i<0 or i>=len(inventory) for i in selection):raise ValueError('Invalid node indices')
            if status=='bound':
                bound_root=d['node_binding'].get('root')
                if bound_root:
                    index=bound_root['index']
                    if index not in selection or inventory[index]['name']!=bound_root['name']:raise ValueError('Bound node identity differs from GLB')
                for index in d['node_binding'].get('owned_mesh_indices',[]):
                    if type(index)is not int or index<0 or index>=len(inventory) or inventory[index]['mesh'] is None:raise ValueError('Invalid owned mesh node')
                    if index in mesh_owners:raise ValueError('Physical geometry has multiple owners: '+str(index))
                    mesh_owners[index]=id
            blockers.append({'code':'NODE_BINDING_REQUIRED','device':id}) if d['node_binding']['status']=='unresolved' else None
            blockers.append({'code':'PHYSICS_ADAPTER_REQUIRED','device':id})
            if d.get('required_confirmations'):blockers.extend({'code':'CALIBRATION_REQUIRED','device':id,'requirement':key} for key in d['required_confirmations'])
            referenced={n['args'][0]['name']+'.'+n['args'][1]['value'] for n in walk(ir['body']) if n.get('kind')=='calibration'}
            for key,calibration in d.get('calibrations',{}).items():
                if key in referenced and calibration.get('status')=='pending_calibration':blockers.append({'code':'CALIBRATION_REQUIRED','device':id,'requirement':key})
        authored_count=len(devices)
        if sorting_station:blockers.append({'code':'SORTING_STATION_CALIBRATION_REQUIRED','device':sorting_station['support_device']})
        devices=expand_prefabs(ir,devices)
        physical_mesh_owners={}
        for device in devices.values():
            if device.get('asset_kind') in ('carrier_prefab','material_prefab') or device['node_binding']['status']!='bound':continue
            for mesh in device['node_binding'].get('owned_mesh_indices',[]):
                if mesh in physical_mesh_owners:raise ValueError('Runtime geometry ownership overlaps')
                physical_mesh_owners[mesh]=device['instance_id']
        if any(d.get('creation_policy')=='clone_on_admission' for d in devices.values()):blockers.append({'code':'PREFAB_INSTANTIATION_REQUIRED'})
        if manifest.get('drive_groups'):blockers.append({'code':'COORDINATED_DRIVE_ADAPTER_REQUIRED'})
        if any(d.get('node_binding',{}).get('status')=='bound' for d in devices.values()):blockers.append({'code':'CONTACT_AND_MOTION_CALIBRATION_REQUIRED'})
        materials=[j['material'] for j in ir['task']['jobs']]+[j['material'] for p in ir['task']['pallets'] for j in p['items']]
        if materials!=goal['expected']['material_ids']:raise ValueError('Independent goal identities differ')
        calls=[]
        for n in walk(ir['body']):
            if n.get('kind')!='invoke':continue
            id=n['device'].get('name');d=devices.get(id)
            if not d:raise ValueError('Unknown device '+str(id))
            c=d['contract'];experimental=c.get('schema_type')!='DeviceSpec'
            behaviors=c.get('transport_behaviors',c.get('definition',{}).get('behaviors',[]))
            b=next((b for b in behaviors if b.get('behavior_id',b.get('id'))==n['behavior']),None)
            if not b:raise ValueError('Unknown contract behavior '+id+'.'+n['behavior'])
            if not experimental and (not b['schedulable'] or b['completion_contract']['mode']=='continuous'):raise ValueError('Not a finite callable behavior')
            args=b.get('arguments_schema',{p['id']:{'required':True} for p in b.get('arguments',[])})
            if set(n['arguments'])-set(args) or {k for k,p in args.items() if p.get('required')}-set(n['arguments']):raise ValueError('Behavior arguments differ')
            calls.append({'node':n['id'],'device':id,'behavior':n['behavior'],'experimental':experimental})
            if experimental:blockers.append({'code':'EXPERIMENTAL_CONTRACT_NOT_ADMITTED','device':id})
        validate_inputs(ir,devices,goal)
        bundle={'schema_version':'scene-bundle/0.1','id':manifest['id'],'name':manifest['name'],'model_sha256':manifest['model_sha256'],
                'model_url':'/scene/'+folder.name+'/'+quote(manifest['model'],safe='/'),'source_hashes':inputs,
                'process':ir,'devices':list(devices.values()),'calls':calls,'nodes':inventory,'blockers':blockers,'executable':False,
                'authored_device_count':authored_count,'runtime_instance_count':sum(d.get('asset_kind')not in ('carrier_prefab','material_prefab') for d in devices.values())}
        if sorting_station:
            bundle['coordinate_system']=manifest['coordinate_system']
            bundle['sorting_station']=sorting_station
        bundle['drive_groups']=manifest.get('drive_groups',{})
        bundle['environment']=manifest.get('environment',[])
        target=output/folder.name/'.generated/scene.bundle.json';write(target,bundle)
        entries.append({'id':manifest['id'],'name':manifest['name'],'bundleUrl':'/scene/'+folder.name+'/.generated/scene.bundle.json',
                        'bundleSha256':digest(target),'deviceCount':authored_count,'nodeCount':len(inventory),'blockerCount':len(blockers)})
    if scene is not None:
        if len(entries)!=1:raise ValueError('Selected scene not found')
        existing=read(root/'index.json')['entries'] if (root/'index.json').exists() else []
        entries=sorted([e for e in existing if e['id']!=scene]+entries,key=lambda e:e['id'])
    write(output/'index.json',{'version':1,'entries':entries});return entries

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]/'public/scene')
    parser.add_argument('--migrate-from',type=Path);parser.add_argument('--contracts',type=Path)
    parser.add_argument('--scene');parser.add_argument('--output-root',type=Path)
    args=parser.parse_args()
    if args.migrate_from:
        if not args.contracts:parser.error('--contracts required for one-time migration')
        migrate(args.migrate_from,args.root,args.contracts)
    entries=build(args.root,args.scene,args.output_root)
    print('Compiled',len(entries),'scene packages; runtime blockers retained.')
