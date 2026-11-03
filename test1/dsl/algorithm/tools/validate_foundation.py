"""Validate symbolic foundation structure and references; does not solve paths."""
import argparse
import json
from pathlib import Path


class ValidationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def load(root):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f'duplicate JSON key: {key}')
            result[key] = value
        return result

    def invalid(value):
        raise ValidationError(f'non-finite JSON constant: {value}')

    return {p.relative_to(root).as_posix(): json.loads(p.read_text(encoding='utf-8-sig'),
            object_pairs_hook=pairs, parse_constant=invalid)
            for p in sorted(root.rglob('*.json'))}


def unique(items, label):
    ids = [item['id'] for item in items]
    require(len(ids) == len(set(ids)), f'{label}: duplicate id')
    return {item['id']: item for item in items}


def validate(documents):
    require('dataset.json' in documents and 'manifest.json' in documents, 'missing dataset/manifest')
    for path, doc in documents.items():
        require(isinstance(doc, dict), f'{path}: object required')
    shared = {v['id']: v for k, v in documents.items() if k.startswith('shared/') and 'id' in v}
    require(len(shared) == sum(k.startswith('shared/') and 'id' in v for k, v in documents.items()), 'duplicate shared id')
    for key, value in shared.items():
        require(value.get('schema_version') == '0.1', f'{key}: unsupported version')
    vocab = shared['symbolic-vocabulary@0.1']
    models = {k:v for k,v in shared.items() if v['schema_type'] == 'VerificationContract'}
    devices = {k:v for k,v in shared.items() if v['schema_type'] == 'ExperimentalDeviceContract'}

    def check_call(call, category, parameters, label):
        name_key = 'predicate' if category == 'predicates' else 'effect'
        name = call[name_key]
        require(name in vocab[category], f'{label}: unknown {name_key} {name}')
        types = vocab[category][name]['argument_types']
        require(len(call['args']) == len(types), f'{label}: argument count for {name}')
        scope = dict(parameters, device='device', request='request')
        for argument, expected in zip(call['args'], types):
            if isinstance(argument, str) and argument.startswith('$'):
                require(scope.get(argument[1:]) == expected, f'{label}: typed argument {argument} expected {expected}')
            else:
                require((expected == 'boolean' and type(argument) is bool) or
                        (expected == 'integer' and type(argument) is int), f'{label}: invalid literal {argument}')

    for key, model in models.items():
        require(model['mode'] == 'abstract_only' and model['runtime_adapter'] == 'pending', f'{key}: misleading runtime status')
        require(model['protocol_ref'] in shared, f'{key}: missing protocol')
        for section in ('preconditions','sustaining_conditions','completion_conditions'):
            require(isinstance(model[section], list) and model[section], f'{key}: empty {section}')
            for call in model[section]: check_call(call, 'predicates', model['parameters'], key)
        phases = unique(model['phases'], key)
        require(bool(phases), f'{key}: no phases')
        for phase in phases.values():
            require(phase['successor'] == 'completed' or phase['successor'] in phases, f'{key}: invalid successor')
            require(phase['fault_successor'] == 'stopping', f'{key}: missing fault route')
            for call in phase['effects']: check_call(call, 'effects', model['parameters'], key)
        require(any(o.get('retain_isolation') for o in model['failure_outcomes']), f'{key}: missing unknown isolation')
        require(all(o.get('preserve_effects') for o in model['failure_outcomes']), f'{key}: failure rollback')
    for key, device in devices.items():
        require(device['mode'] == 'verification_only' and device['deployment_ready'] is False, f'{key}: deployment flag')
        unique(device['signals'], key)
        for signal in device['signals']:
            require(signal['direction'] in ('input','output'), f'{key}: port direction')
            require(signal['type'] in ('boolean','DINT','REAL'), f'{key}: port type')
        for behavior in device['capabilities'].values():
            require(behavior['verification_ref'] in models, f'{key}: missing verification model')
            require(behavior['protocol_ref'] in shared, f'{key}: missing protocol')
        if device['control_ref']:
            require(shared.get(device['control_ref'],{}).get('schema_type') == 'ControlContract', f'{key}: missing control')

    scenes = documents['manifest.json']['scene_ids']
    require(len(scenes) == len(set(scenes)), 'duplicate scene id')
    for sid in scenes:
        prefix = f'scenes/{sid}/'
        for name in ('scene.json','instances.json','relations.json','model-assumptions.json'):
            require(prefix+name in documents, f'{sid}: missing {name}')
        scene, instances, relations = [documents[prefix+n] for n in ('scene.json','instances.json','relations.json')]
        require(scene['id'] == sid and scene['deployment_ready'] is False, f'{sid}: scene identity/status')
        for service in scene['service_refs']: require(service in shared, f'{sid}: missing service')
        devs = unique(instances['devices'], sid+' devices')
        locations = unique(instances['locations'], sid+' locations')
        require(not (set(devs) & set(locations)), f'{sid}: nominal id collision')
        for dev in devs.values():
            require(dev['contract_ref'] in devices, f'{sid}: missing contract {dev["contract_ref"]}')
            require(dev['device_type'] == devices[dev['contract_ref']]['device_type'], f'{sid}: device type mismatch')
            capacity = dev['parameters']['capacity']
            require(type(capacity) is int and 1 <= capacity <= 64, f'{sid}: capacity range')
        resources = unique(relations['resources'], sid+' resources')
        for res in resources.values(): require(res['owner'] in devs and res['kind']=='exclusive', f'{sid}: resource owner/type')
        for loc in locations.values():
            require(loc['owner'] in devs and loc['zone_ref'] in resources, f'{sid}: location owner/zone')
            require(type(loc['capacity']) is int and 0 < loc['capacity'] <= devs[loc['owner']]['parameters']['capacity'], f'{sid}: location capacity')
        for left,right in relations['resource_conflicts']:
            require(left in resources and right in resources and left != right, f'{sid}: conflict reference')
        unique(relations['transfer_edges'], sid+' edges')
        for edge in relations['transfer_edges']:
            require(edge['device'] in devs, f'{sid}: transfer actor')
            caps = devices[devs[edge['device']]['contract_ref']]['capabilities']
            require('transfer_material' in caps, f'{sid}: actor lacks transfer')
            require(edge['source'] in locations and edge['target'] in locations and edge['source']!=edge['target'], f'{sid}: transfer endpoints')
            require(edge['geometry_verified'] is False, f'{sid}: unproven geometry')
        controls = unique(relations['control_scopes'], sid+' controls')
        for control in controls.values():
            require(control['owner'] in devs and control['writer'] in resources and control['contract_ref'] in shared, f'{sid}: control reference')
            require(0.01 <= control['speed_m_s'] <= 1, f'{sid}: drive speed')
        for edge in relations['transport_edges']:
            require(edge['device'] in devs and edge['source'] in locations and edge['target'] in locations, f'{sid}: transport endpoints')
            require(edge['requires_control'] in controls, f'{sid}: transport control')
            require(controls[edge['requires_control']]['owner'] == edge['device'], f'{sid}: wrong drive owner')
        for group in relations['capacity_groups']:
            require(group['owner'] in devs and group['capacity'] == devs[group['owner']]['parameters']['capacity'], f'{sid}: group capacity')
            require(set(group['locations']) == {k for k,v in locations.items() if v['owner']==group['owner']}, f'{sid}: capacity coverage')
    for path, doc in documents.items():
        if path.startswith('shared/environments/'):
            for field in ('phase_duration_ticks','accept_delay_ticks','stop_delay_ticks','feedback_delay_ticks'):
                values=doc[field]
                require(len(values)==2 and all(type(v) is int for v in values) and 0 <= values[0] <= values[1], f'{path}: duration interval')
    require(documents['dataset.json']['scene_count']==len(scenes), 'scene count mismatch')
    require(documents['dataset.json']['case_count']==len(documents['manifest.json']['cases']), 'case count mismatch')
    return {'checked':'foundation_structure_and_references_only','scenes':len(scenes),
            'experimental_device_contracts':len(devices),'action_models':len(models),
            'cases':documents['dataset.json']['case_count'],'path_verification_performed':False}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dataset',type=Path)
    args=parser.parse_args()
    try:
        print(json.dumps(validate(load(args.dataset.resolve())),ensure_ascii=False,indent=2))
    except (ValidationError, KeyError, TypeError, ValueError) as error:
        parser.exit(1,f'Foundation validation failed: {error}\n')
