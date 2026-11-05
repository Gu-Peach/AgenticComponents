"""Validate declarations and cross references without executing device behavior."""
import argparse
import json
from itertools import product
import math
from pathlib import Path
import sys

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
NUMERIC = {'integer', 'number'}
TEXT_TYPES = {'string', 'material_ref', 'location_ref', 'slot_ref', 'recipe_ref', 'transport_plan_ref', 'pallet_ref'}
PROTOCOL_PORTS = {'enable', 'request_id', 'execute', 'command_code', 'cancel',
                  'accepted', 'accepted_id', 'busy', 'done', 'result_id', 'error',
                  'error_code', 'cancelled', 'stop_ack_id', 'stopped'}
PROTOCOL_COMMANDS = {'enable', 'request_id', 'execute', 'cancel'}


def read_json(path):
    def reject_constant(value):
        raise ValueError(f'Non-finite JSON number: {value}')
    return json.loads(Path(path).read_text(encoding='utf-8-sig'), parse_constant=reject_constant)


def typed(value, descriptor):
    kind = descriptor['type']
    if kind == 'boolean':
        return type(value) is bool
    if kind == 'integer':
        return type(value) is int
    if kind == 'number':
        return type(value) in (int, float) and math.isfinite(value)
    return kind in TEXT_TYPES and type(value) is str and (kind == 'string' or bool(value))


def validate_documents(catalog, protocols, assets, schema):
    """Return all detected errors for a complete in-memory catalog."""
    errors = []

    def fail(where, message):
        errors.append(f'{where}: {message}')

    def shape(value, definition, where):
        selected = schema if definition is None else {
            '$ref': '#/$defs/' + definition, '$defs': schema['$defs']}
        found = sorted(Draft202012Validator(selected).iter_errors(value),
                       key=lambda error: str(list(error.absolute_path)))
        for error in found:
            suffix = '.'.join(map(str, error.absolute_path))
            fail(where + ('.' + suffix if suffix else ''), error.message)
        return not found

    def index(items, where):
        result = {}
        for item in items:
            ident = item['id']
            if ident in result:
                fail(where, f'duplicate ID {ident}')
            result[ident] = item
        return result

    def field_check(item, where):
        if item['type'] not in NUMERIC and item['unit'] != '1':
            fail(where, 'non-numeric field must have unit 1')
        if item['type'] not in NUMERIC and ('minimum' in item or 'maximum' in item):
            fail(where, 'only numeric fields can have a range')
        for bound in ('minimum', 'maximum'):
            if bound in item and (type(item[bound]) not in (int, float)
                                  or not math.isfinite(item[bound])):
                fail(where, f'{bound} must be a finite number, not a boolean')
        if item.get('minimum', -math.inf) > item.get('maximum', math.inf):
            fail(where, 'minimum exceeds maximum')
        values = [('enum', value) for value in item.get('enum', [])]
        if 'default' in item:
            values.append(('default', item['default']))
        for origin, value in values:
            if not typed(value, item):
                fail(where, f'{origin} value {value!r} does not match {item["type"]}')
                continue
            if item['type'] in NUMERIC:
                if value < item.get('minimum', -math.inf) or value > item.get('maximum', math.inf):
                    fail(where, f'{origin} value {value!r} is outside its range')
        if 'default' in item and 'enum' in item and item['default'] not in item['enum']:
            fail(where, 'default is outside enum')

    catalog_schema = {
        'type': 'object', 'additionalProperties': False,
        'required': ['schema_version', 'version', 'assets', 'protocols'],
        'properties': {
            'schema_version': {'const': 'asset-catalog/0.1'},
            'version': {'type': 'string', 'pattern': r'^\d+\.\d+\.\d+$'},
            'protocols': {'const': 'shared/protocols.json'},
            'assets': {'type': 'array', 'minItems': 9, 'maxItems': 9,
                       'items': {'type': 'object', 'additionalProperties': False,
                                 'required': ['id', 'path'],
                                 'properties': {'id': schema['$defs']['id'],
                                                'path': {'type': 'string'}}}}}}
    for error in Draft202012Validator(catalog_schema).iter_errors(catalog):
        fail('catalog', error.message)
    if errors:
        return errors
    entries = index(catalog['assets'], 'catalog.assets')
    for ident, entry in entries.items():
        if entry['path'] != f'assets/{ident}.json':
            fail('catalog', f'asset path must be assets/{ident}.json')
    if set(assets) != set(entries):
        fail('catalog', 'loaded asset IDs do not equal catalog IDs')
    if not isinstance(protocols, dict) or protocols.get('schema_version') != 'asset-protocols/0.1':
        fail('protocols', 'expected asset-protocols/0.1 object')
        return errors
    protocol_items = protocols.get('protocols')
    if not isinstance(protocol_items, list) or any(not isinstance(p, dict) for p in protocol_items):
        fail('protocols', 'protocols must be an array of objects')
        return errors
    if any(not isinstance(p.get('id'), str) for p in protocol_items):
        fail('protocols', 'every protocol requires a string ID')
        return errors
    pmap = index(protocol_items, 'protocols')
    if set(pmap) != {'request_v1', 'passive_v1'}:
        fail('protocols', 'exactly request_v1 and passive_v1 must be declared')
    protocol_valid = True
    for ident, protocol in pmap.items():
        for key, definition in (('signal_ports', 'port'), ('context', 'field')):
            values = protocol.get(key)
            if not isinstance(values, list):
                fail(ident, f'{key} must be an array')
                protocol_valid = False
                continue
            valid = [shape(value, definition, ident + '.' + key) for value in values]
            if not all(valid):
                protocol_valid = False
                continue
            index(values, ident + '.' + key)
            for value in values:
                field_check(value, ident + '.' + key + '.' + value['id'])
        if ident == 'passive_v1' and protocol.get('signal_ports'):
            fail(ident, 'passive protocol must not inject signal ports')
    if not protocol_valid:
        return errors
    request_ports = {p['id']: p for p in pmap.get('request_v1', {}).get('signal_ports', [])}
    if set(request_ports) != PROTOCOL_PORTS:
        fail('request_v1', 'request protocol signal set differs from the versioned contract')
    for ident, port in request_ports.items():
        direction = 'input' if ident in PROTOCOL_COMMANDS | {'command_code'} else 'output'
        if port['direction'] != direction:
            fail('request_v1', f'{ident} must be a device {direction}')
        kind = 'integer' if ident in {'request_id', 'command_code', 'accepted_id', 'result_id', 'stop_ack_id', 'error_code'} else 'boolean'
        if port['type'] != kind:
            fail('request_v1', f'{ident} must have type {kind}')
        if port['unit'] != '1':
            fail('request_v1', f'{ident} must be dimensionless')
    for ident, protocol in pmap.items():
        context = {field['id']: field for field in protocol['context']}
        required = {'run_id': 'string', 'instance_id': 'string'}
        if ident == 'request_v1':
            required['request_id'] = 'integer'
        for name, kind in required.items():
            if context.get(name, {}).get('type') != kind or context.get(name, {}).get('unit') != '1':
                fail(ident, f'context {name} must have type {kind} and unit 1')
        runtime = protocol.get('runtime_control_context', [])
        bindings = protocol.get('runtime_bindings', [])
        if not isinstance(runtime, list) or not isinstance(bindings, list):
            fail(ident, 'runtime context and bindings must be arrays')
            continue
        if not all([shape(item, 'field', ident + '.runtime_control_context') for item in runtime]):
            continue
        if not all([shape(item, 'command', ident + '.runtime_bindings') for item in bindings]):
            continue
        controls = index(runtime, ident + '.runtime_control_context')
        for item in runtime:
            field_check(item, ident + '.runtime_control_context.' + item['id'])
        if set(controls) & set(context):
            fail(ident, 'runtime control context duplicates identity context')
        scope = dict(context, **controls)
        signals = {port['id']: port for port in protocol['signal_ports']}
        if ident == 'request_v1' and {b['signal'] for b in bindings} != PROTOCOL_COMMANDS:
            fail(ident, 'runtime bindings must cover enable/request_id/execute/cancel')
        if len({b['signal'] for b in bindings}) != len(bindings):
            fail(ident, 'duplicate runtime binding target')
        for binding in bindings:
            target = signals.get(binding['signal'])
            value = binding['value']
            if target is None or target['direction'] != 'input':
                fail(ident, f'runtime binding target must be an input: {binding["signal"]}')
                continue
            if value['source'] != 'context' or value.get('ref') not in scope:
                fail(ident, 'runtime binding must reference a declared context field')
                continue
            source = scope[value['ref']]
            if (target['type'], target['unit']) != (source['type'], source['unit']):
                fail(ident, 'runtime binding type/unit mismatch')
    if errors:
        return errors

    for asset_id, asset in assets.items():
        where = 'asset.' + asset_id
        if not shape(asset, None, where):
            continue
        if asset['id'] != asset_id:
            fail(where, 'asset ID differs from catalog ID')
        parameters = index(asset['parameters'], where + '.parameters')
        features = index(asset['features'], where + '.features')
        observations = index(asset['observations'], where + '.observations')
        authorizations = index(asset['authorizations'], where + '.authorizations')
        interfaces = index(asset['spatial_interfaces'], where + '.spatial_interfaces')
        index(asset['behaviors'], where + '.behaviors')
        ports = index(asset['signal_ports'], where + '.signal_ports')
        contexts = {}
        imported_ports = set()
        for ident in asset['protocol_imports']:
            protocol = pmap[ident]
            for port in protocol['signal_ports']:
                if port['id'] in ports:
                    fail(where, f'protocol port redeclared: {port["id"]}')
                ports[port['id']] = port
                imported_ports.add(port['id'])
            for context in protocol['context']:
                previous = contexts.get(context['id'])
                if previous and (previous['type'], previous['unit']) != (context['type'], context['unit']):
                    fail(where, f'conflicting protocol context: {context["id"]}')
                contexts[context['id']] = context
        for label, values in (('parameters', parameters), ('signals', ports),
                              ('observations', observations), ('authorizations', authorizations)):
            for ident, item in values.items():
                field_check(item, where + '.' + label + '.' + ident)
        for item in list(observations.values()) + list(authorizations.values()):
            if set(item['arguments']) != set(item['argument_types']):
                fail(where, f'fact {item["id"]} argument names and types differ')
        for port in ports.values():
            expected = 'controller' if port['direction'] == 'input' else 'adapter'
            if port['writer'] != expected:
                fail(where, f'port {port["id"]} has inconsistent writer/direction')
        for interface in interfaces.values():
            for feature in interface.get('requires_features', []):
                if feature not in features:
                    fail(where, f'spatial interface references unknown feature {feature}')
        constraints = asset.get('configuration_constraints', [])
        for constraint in constraints:
            if constraint['kind'] == 'at_least_one_feature':
                if any(f not in features for f in constraint['features']):
                    fail(where, 'configuration constraint references unknown feature')
                elif not any(features[f]['default'] for f in constraint['features']):
                    fail(where, 'default configuration violates at_least_one_feature')
            else:
                lhs, rhs = parameters.get(constraint['left']), parameters.get(constraint['right'])
                if lhs is None or rhs is None:
                    fail(where, 'configuration constraint references unknown parameter')
                elif lhs['type'] not in NUMERIC or rhs['type'] not in NUMERIC or lhs['unit'] != rhs['unit']:
                    fail(where, 'parameter_le requires numeric parameters with the same unit')
                elif 'default' not in lhs or 'default' not in rhs:
                    fail(where, 'parameter_le requires declared defaults to validate the default configuration')
                elif typed(lhs['default'], lhs) and typed(rhs['default'], rhs) and lhs['default'] > rhs['default']:
                    fail(where, 'default configuration violates parameter_le')
        if asset['category'] == 'passive':
            if asset['protocol_imports'] != ['passive_v1']:
                fail(where, 'passive asset must import only passive_v1')
            if any(p['direction'] == 'input' for p in ports.values()):
                fail(where, 'passive asset cannot expose command input ports')
        rules = asset.get('activation_rules', [])
        gated_features = [rule['feature'] for rule in rules]
        if len(set(gated_features)) != len(gated_features):
            fail(where, 'duplicate feature activation rule')
        for rule in rules:
            if rule['feature'] not in features:
                fail(where, f'activation rule uses unknown feature {rule["feature"]}')
            for protocol in rule['protocols']:
                if protocol not in asset['protocol_imports']:
                    fail(where, f'activation rule uses unimported protocol {protocol}')
            for signal in rule['signals']:
                if signal not in ports:
                    fail(where, f'activation rule uses unknown signal {signal}')
        if asset['category'] == 'configurable' and len(features) <= 16:
            feature_names = sorted(features)
            for flags in product((False, True), repeat=len(feature_names)):
                enabled = dict(zip(feature_names, flags))
                if any(c['kind'] == 'at_least_one_feature' and
                       not any(enabled.get(f, False) for f in c['features']) for c in constraints):
                    continue
                effective = dict(ports)
                for rule in rules:
                    if not enabled.get(rule['feature'], False):
                        for protocol in rule['protocols']:
                            for port in pmap[protocol]['signal_ports']:
                                effective.pop(port['id'], None)
                        for signal in rule['signals']:
                            effective.pop(signal, None)
                invocable = [b for b in asset['behaviors'] if b['invocable'] and
                             all(enabled.get(f, False) for f in b['requires_features'])]
                if not invocable and any(p['direction'] == 'input' for p in effective.values()):
                    fail(where, f'passive feature configuration retains input ports: {enabled}')
        elif asset['category'] == 'configurable':
            fail(where, 'more than 16 features requires a separately reviewed activation validator')
        codes = set()
        for behavior in asset['behaviors']:
            bw = where + '.behavior.' + behavior['id']
            args = index(behavior['arguments'], bw + '.arguments')
            for argument in args.values():
                field_check(argument, bw + '.arguments.' + argument['id'])
            used = set()
            maps = {'signal': ports, 'parameter': parameters, 'argument': args,
                    'observation': observations, 'authorization': authorizations, 'context': contexts}

            def resolve(reference, rw, consume=False):
                source, ident = reference['source'], reference.get('ref')
                item = maps.get(source, {}).get(ident)
                if item is None:
                    fail(rw, f'unknown {source} reference {ident}')
                    return None
                if source == 'argument' and consume:
                    used.add(ident)
                if source in ('observation', 'authorization'):
                    bindings = reference.get('bindings', {})
                    if set(bindings) != set(item['arguments']):
                        fail(rw, f'fact bindings must exactly match {item["arguments"]}')
                    for fact_argument, arg in bindings.items():
                        if arg not in args:
                            fail(rw, f'fact binding references unknown argument {arg}')
                        else:
                            used.add(arg)
                            expected_type = item['argument_types'].get(fact_argument)
                            if expected_type is not None and args[arg]['type'] != expected_type:
                                fail(rw, f'fact argument {fact_argument} expects {expected_type}, got {args[arg]["type"]}')
                elif reference.get('bindings'):
                    fail(rw, 'only observation/authorization references accept fact bindings')
                return item

            def compatible(left, right, cw, consume=False):
                if left is None:
                    return
                if right['source'] == 'literal':
                    if not typed(right['value'], left):
                        fail(cw, f'literal does not match {left["type"]}')
                    return
                descriptor = resolve(right, cw, consume)
                if descriptor is None:
                    return
                if descriptor['type'] != left['type'] and not {descriptor['type'], left['type']} <= NUMERIC:
                    fail(cw, f'type mismatch: {left["type"]} versus {descriptor["type"]}')
                if descriptor['unit'] != left['unit']:
                    fail(cw, f'unit mismatch: {left["unit"]} versus {descriptor["unit"]}')

            for feature in behavior['requires_features']:
                if feature not in features:
                    fail(bw, f'unknown feature {feature}')
            active = behavior['kind'] in ('action', 'continuous')
            if behavior['invocable'] != active:
                fail(bw, 'invocable must agree with behavior kind')
            if asset['category'] == 'passive' and active:
                fail(bw, 'passive asset cannot contain invocable actions')
            expected_protocol = 'request_v1' if active else 'passive_v1'
            if behavior['protocol'] != expected_protocol:
                fail(bw, 'behavior protocol does not match kind')
            if behavior['protocol'] not in asset['protocol_imports']:
                fail(bw, 'behavior protocol is not imported')
            if behavior['completion']['mode'] != ('scope' if behavior['kind'] == 'continuous' else 'evidence'):
                fail(bw, 'continuous behavior requires scope completion; other kinds require evidence')
            commands = behavior['command_bindings']
            targets = [command['signal'] for command in commands]
            if len(set(targets)) != len(targets):
                fail(bw, 'duplicate command target')
            if not active and commands:
                fail(bw, 'passive/observer behavior cannot write command ports')
            for command in commands:
                target = ports.get(command['signal'])
                if target is None:
                    fail(bw, f'unknown command signal {command["signal"]}')
                    continue
                if target['direction'] != 'input':
                    fail(bw, f'command target {target["id"]} must be an input port')
                if target['id'] in PROTOCOL_COMMANDS:
                    fail(bw, f'{target["id"]} is owned by the request protocol')
                if command['value']['source'] not in ('literal', 'argument', 'parameter', 'context'):
                    fail(bw, 'command values must come from literal/argument/parameter/context')
                compatible(target, command['value'], bw + '.command.' + target['id'], consume=True)
                if target['type'] == 'integer' and command['value']['source'] != 'literal':
                    value_type = maps.get(command['value']['source'], {}).get(command['value'].get('ref'), {}).get('type')
                    if value_type == 'number':
                        fail(bw, 'number payload cannot implicitly narrow to integer')
            if active:
                code = next((c['value'] for c in commands if c['signal'] == 'command_code'), None)
                if code is None or code.get('source') != 'literal' or type(code.get('value')) is not int or code['value'] <= 0:
                    fail(bw, 'active behavior requires a positive literal integer command_code')
                elif code['value'] in codes:
                    fail(bw, f'duplicate command_code {code["value"]}')
                else:
                    codes.add(code['value'])
            groups = (behavior['preconditions'], behavior['sustaining_conditions'], behavior['completion']['checks'])
            for conditions in groups:
                index(conditions, bw + '.conditions')
                for condition in conditions:
                    cw = bw + '.condition.' + condition['id']
                    descriptor = resolve(condition['left'], cw)
                    compatible(descriptor, condition['right'], cw)
                    if descriptor and condition['operator'] in ('lt', 'le', 'gt', 'ge') and descriptor['type'] not in NUMERIC:
                        fail(cw, 'ordered comparison requires numeric operands')
            checks = behavior['completion']['checks']
            business_evidence = any(c['left']['source'] == 'observation' or
                                    (c['left']['source'] == 'signal' and c['left']['ref'] not in imported_ports)
                                    for c in checks)
            if not business_evidence:
                fail(bw, 'completion requires business evidence beyond protocol status')
            if behavior['kind'] == 'continuous' and any(c['left']['source'] == 'signal' and c['left']['ref'] == 'done' for c in checks):
                fail(bw, 'continuous scope cannot finish from one done signal')
            for ident in set(args) - used:
                fail(bw, f'argument {ident} is unused by commands or fact bindings')
    return errors


def validate_bundle(root=ROOT):
    root = Path(root).resolve()
    try:
        schema = read_json(root / 'schema/asset-contract.schema.json')
        Draft202012Validator.check_schema(schema)
        catalog = read_json(root / 'catalog.json')
        protocols = read_json(root / 'shared/protocols.json')
        assets = {}
        for entry in catalog.get('assets', []):
            ident = entry.get('id')
            expected = f'assets/{ident}.json'
            if entry.get('path') != expected:
                return [f'catalog: invalid asset path {entry.get("path")!r}']
            path = (root / expected).resolve()
            if root not in path.parents:
                return ['catalog: asset path escapes contract root']
            assets[ident] = read_json(path)
        return validate_documents(catalog, protocols, assets, schema)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        return [f'Cannot validate bundle: {exc}']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    errors = validate_bundle(args.root)
    print(json.dumps({'valid': not errors, 'errors': errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
