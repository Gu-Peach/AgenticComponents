"""Validate DeviceSpec declarations against the three source documents."""
import argparse,hashlib,json,math,sys
from pathlib import Path
from jsonschema import Draft202012Validator
from spec_sources import load_norms,TYPES
ROOT=Path(__file__).resolve().parents[1]
def read(p):return json.loads(Path(p).read_text(encoding='utf-8-sig'))
def validate_spec(spec,schema,norms):
    errors=[]
    for e in Draft202012Validator(schema).iter_errors(spec):errors.append('.'.join(map(str,e.absolute_path))+': '+e.message)
    if errors:return errors
    def check(ok,msg):
        if not ok:errors.append(msg)
    def unique(items,key,label):
        result={x[key]:x for x in items};check(len(result)==len(items),'duplicate '+label);return result
    check(spec['schema_id']==spec['device_spec_id'],'device definition IDs differ')
    check(spec['contract_version']=='1.1','Generic uncalibrated templates must remain 1.1')
    typ=spec['device_type'];params=spec['params_schema'];expected=norms['parameters'][typ]['params_schema']
    check(set(params)<=set(expected),'Parameter names not declared by source template')
    for name,p in params.items():
        if name in expected:
            for key in ('type','required','mutability','unit','options','required_when'):check(p.get(key)==expected[name].get(key),f'{name}: normative parameter metadata differs: {key}')
        if 'default'in p:
            value=p['default'];t=p['type']
            if t in ('number','integer'):check(type(value) in (int,float) and type(value)is not bool and math.isfinite(value) and (t!='integer' or type(value)is int),name+': invalid numeric default')
            elif t=='boolean':check(type(value)is bool,name+': invalid boolean default')
            elif t=='enum':check(value in p['options'],name+': enum default outside options')
            else:check(isinstance(value,str),name+': string default required')
            if type(value) in (int,float):check(p.get('min',-math.inf)<=value<=p.get('max',math.inf),name+': default outside range')
        check(p.get('min',-math.inf)<=p.get('max',math.inf),name+': reversed range')
        if 'required_when'in p:check(p['required_when']['parameter'] in params,name+': missing required_when dependency')
    def refs(value):
        if isinstance(value,dict):
            for k,v in value.items():
                if k.endswith('_param') and isinstance(v,str):check(v in params,'dangling parameter reference '+v)
                refs(v)
        elif isinstance(value,list):
            for x in value:refs(x)
    refs(spec['type_specific_contract'])
    ports=unique(spec['signal_ports'],'port_id','port ID')
    allowed=dict(norms['signals'][typ])
    if typ not in ('workpiece','workpiece_carrier'):
        for name,direction,plc in [('request_id','input','DINT'),('execute','input','BOOL'),('reset','input','BOOL'),('accepted','output','BOOL'),('busy','output','BOOL'),('done','output','BOOL'),('result_id','output','DINT'),('error','output','BOOL'),('error_code','output','INT')]:allowed.setdefault(name,dict(direction=direction,plc_type=plc))
    for p in ports.values():
        check(p['value_type']=={'BOOL':'boolean','INT':'integer','DINT':'integer','REAL':'number'}[p['plc_type']],'PLC/value type mismatch '+p['port_id'])
        check(p['port_id'] in allowed,'signal not in normative interface table: '+p['port_id'])
        if p['port_id'] in allowed:check(all(p[k]==allowed[p['port_id']][k] for k in ('direction','plc_type')),'normative signal direction/type differs: '+p['port_id'])
    if typ in ('workpiece','workpiece_carrier'):check(all(p['direction']=='output' for p in ports.values()),'Passive physical asset has input commands')
    interfaces=unique(spec['interfaces'],'interface_id','spatial ID')
    for x in interfaces.values():check(sum(k in x for k in ('local_frame','local_frame_rule','local_frame_pending'))==1,'spatial frame source must be unique')
    bs=unique(spec['transport_behaviors'],'behavior_id','behavior ID');canonical=norms['behaviors'][typ]
    check(set(bs)<=set(canonical),'Behavior not declared by normative table')
    registries={'parameter':params,'observation':spec['runtime_contract']['observation_definitions'],'authorization':spec['runtime_contract']['authorization_definitions']}
    for id,b in bs.items():
        check(b['implementation_status']=='pending_adapter',id+': unsupported implementation claim')
        if b['behavior_type'] in ('passive','observer','internal'):check(not b['schedulable'],id+': passive/internal/observer is schedulable')
        for direction,key in [('input','input_signals'),('output','output_signals')]:
            check(len(b[key])==len(set(b[key])),id+': duplicate signal reference')
            for name in b[key]:check(name in ports and ports[name]['direction']==direction,id+': signal reference/direction '+name)
        for c in b['condition_contract']['preconditions']+b['condition_contract']['sustaining_conditions']+b['completion_contract']['checks']:
            check(c['key'] in registries[c['source']],id+': unresolved condition '+c['key'])
        if b['completion_contract']['mode']=='observed':check(bool(b['completion_contract']['checks']),id+': missing observed completion')
        if id in canonical:check(b['completion_contract']['description']==canonical[id][4],id+': completion semantics differ from source row')
        for name,p in b['arguments_schema'].items():
            check(p['type'] in ('number','integer','boolean','string','enum'),id+': noncanonical argument type '+name)
        for gate in b.get('applicability',{}).get('conditions',[]):check(gate['parameter'] in params,id+': undeclared feature parameter')
    for registry in ('observation_definitions','authorization_definitions'):
        for key,f in spec['runtime_contract'][registry].items():
            check(f.get('implementation_status')=='pending_provider',key+': provider is not implemented')
            for signal in f.get('signal_refs',[]):check(signal in ports,key+': unknown supporting signal')
    check(spec['runtime_execution_contract']['real_execution_available'] is False,'Uncalibrated template claims runnable')
    if typ=='conveyor':
        surface=spec['type_specific_contract']['conveying_surface'];check(surface['material_motion']=='physics_contact_only','Conveyor must not move cargo by interpolation')
        check(surface['implementation_status']=='pending_engine','Generic conveyor incorrectly marked implemented')
        for r in spec['type_specific_contract']['observation_regions']:
            check(r['surface_ref']==surface['surface_id'],'invalid observation surface')
            for key in r['observation_keys']:check(key in registries['observation'],'unknown region observation')
    return errors

def validate_bundle(root=ROOT,source_docs=None):
    root=Path(root).resolve();docs=Path(source_docs) if source_docs else root.parent.parent/'docs';report={'standard':[],'experimental':[],'errors':[],'execution_ready':False}
    try:
        manifest=read(root/'reference-manifest.json')
        for item in manifest['documents']:
            p=docs/Path(item['path']).name
            if hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:report['errors'].append('Normative source changed: '+p.name)
        norms=load_norms(docs);schema=read(root/'schema/device-spec.schema.json');Draft202012Validator.check_schema(schema)
        catalog=read(root/'catalog.json');seen=set()
        for entry in catalog['assets']:
            if entry['id'] in seen:report['errors'].append('duplicate catalog ID')
            seen.add(entry['id']);p=(root/entry['path']).resolve()
            if root not in p.parents:raise ValueError('Asset path outside root')
            spec=read(p)
            if entry['scope']=='experimental':
                if spec.get('schema_type')!='ExperimentalAssetContract' or spec.get('standard_device_type') is not False:report['errors'].append('Extension falsely claims standard DeviceSpec')
                report['experimental'].append({'id':entry['id'],'status':'PENDING_NORMATIVE_CONTRACT'});continue
            errors=validate_spec(spec,schema,norms);report['standard'].append({'id':entry['id'],'device_type':spec.get('device_type'),'valid':not errors,'behaviors':len(spec.get('transport_behaviors',[]))})
            report['errors'].extend(entry['id']+': '+e for e in errors)
        if len(report['standard'])!=8 or len(report['experimental'])!=1:report['errors'].append('Expected eight standard assets and one extension')
        if {row['device_type'] for row in report['standard']}!=set(TYPES):report['errors'].append('Canonical device types are missing or duplicated')
        from model_profiles import validate_profiles
        report['errors'].extend(validate_profiles(root))
    except (OSError,ValueError,KeyError,TypeError) as e:report['errors'].append(str(e))
    report['valid']=not report['errors'];return report
def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT);p.add_argument('--source-docs',type=Path);a=p.parse_args();r=validate_bundle(a.root,a.source_docs);print(json.dumps(r,ensure_ascii=False,indent=2));return 0 if r['valid'] else 1
if __name__=='__main__':sys.exit(main())
