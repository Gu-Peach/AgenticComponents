"""Verify references to concrete cases without merging their implementation claims."""
import hashlib,json,os
from pathlib import Path
def read(p):return json.loads(Path(p).read_text(encoding='utf-8-sig'))
def validate_profiles(root):
    root=Path(root);path=root/'model-profiles.json'
    def resolve(relative):
        project=os.environ.get('DEVICE_CASE_PROJECT_ROOT')
        if project:
            if not relative.startswith('../../../apps/'):raise ValueError('Unexpected concrete profile source path')
            return Path(project)/relative[len('../../../'):]
        return (root/relative).resolve()
    if not path.exists():return []
    errors=[];data=read(path);seen=set()
    if data.get('schema_version')!='concrete-model-profiles/1.0':return ['Unknown model profile version']
    for p in data['profiles']:
        if p['id'] in seen:errors.append('Duplicate concrete model profile')
        seen.add(p['id'])
        for field in ('source','readme','model'):
            target=resolve(p[field])
            if hashlib.sha256(target.read_bytes()).hexdigest()!=p[field+'_sha256']:errors.append(p['id']+': source changed: '+field)
        source=read(resolve(p['source']))
        if source['device_spec_id']!=p['device_spec_id'] or source['contract_version']!=p['contract_version'] or source['version']!=p['definition_version']:errors.append(p['id']+': model identity/version differs')
        if source['asset'].get('sha256')!=p['model_sha256']:errors.append(p['id']+': GLB differs from DeviceSpec hash')
        if p.get('inherit_missing_template_fields') is not False:errors.append(p['id']+': implicit template inheritance is forbidden')
        if 'payload_schema_source'in p:
            if hashlib.sha256(resolve(p['payload_schema_source']).read_bytes()).hexdigest()!=p['payload_schema_sha256']:errors.append(p['id']+': payload schema changed; re-audit entry points')
        if 'supported_io'in p and p['supported_io']!=source['runtime_execution_contract']['supported_io']:errors.append(p['id']+': supported IO differs from actual case')
        if 'signal_count'in p and p['signal_count']!=len(source['signal_ports']):errors.append(p['id']+': signal count differs')
        if 'behavior_count'in p and p['behavior_count']!=len(source['transport_behaviors']):errors.append(p['id']+': behavior count differs')
        if 'mass_has_default'in p and p['mass_has_default']!=('default'in source['params_schema']['mass_kg']):errors.append(p['id']+': mass default claim differs')
    for file in (root/'assets').glob('*.json'):
        spec=read(file)
        for ref in spec.get('runtime_execution_contract',{}).get('model_profile_refs',[]):
            if ref not in seen:errors.append(file.name+': unknown concrete model reference')
    return errors
