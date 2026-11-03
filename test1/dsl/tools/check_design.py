"""Reference front end and bounded design checks; no device execution."""
import argparse
import json
import math
import re
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
RESERVED = set('process environment profile conditions condition body seq par branch case else repeat await delay invoke args policy timeout with-control fail is all any not parameter observation authorization subject slot request binding index q ordered exclusive true false s ms'.split())
NUMBER = re.compile(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\Z')
IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_-]*\Z')

class DesignError(ValueError):
    pass

def require(ok, message):
    if not ok:
        raise DesignError(message)

def read_json(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f'duplicate JSON key: {key}')
            result[key] = value
        return result
    def invalid(value):
        raise DesignError(f'non-finite JSON: {value}')
    return json.loads(Path(path).read_text(encoding='utf-8-sig'), object_pairs_hook=pairs, parse_constant=invalid)

def read_source(path):
    # Preserve CRLF so byte spans refer to the actual source file.
    with Path(path).open(encoding='utf-8', newline='') as stream:
        return stream.read()

@dataclass
class Token:
    text: str
    start: int
    end: int

@dataclass
class Form:
    items: list
    start: int
    end: int

def tokenize(text):
    require(len(text.encode('utf-8')) <= 1024 * 1024, 'source exceeds 1 MiB')
    pattern = re.compile(r'\s+|;[^\r\n]*|"(?:[^"\\\x00-\x1f]|\\.)*"|[()]|[^\s();]+')
    tokens = []
    pos = 1 if text.startswith('\ufeff') else 0
    while pos < len(text):
        match = pattern.match(text, pos)
        require(match is not None, f'invalid token at offset {pos}')
        raw = match.group()
        if not raw.isspace() and not raw.startswith(';'):
            tokens.append(Token(raw, pos, match.end()))
        pos = match.end()
    return tokens

def parse(text):
    tokens = tokenize(text)
    pos = 0
    def item(depth=0):
        nonlocal pos
        require(depth <= 128, 'syntax nesting exceeds 128')
        require(pos < len(tokens), 'unexpected end of input')
        token = tokens[pos]
        pos += 1
        require(token.text != ')', 'unexpected closing parenthesis')
        if token.text != '(':
            return token
        items = []
        while pos < len(tokens) and tokens[pos].text != ')':
            items.append(item(depth + 1))
        require(pos < len(tokens), 'unclosed parenthesis')
        end = tokens[pos].end
        pos += 1
        return Form(items, token.start, end)
    root = item()
    require(pos == len(tokens), 'trailing input')
    return root

def atom(value):
    require(isinstance(value, Token), 'expected atom')
    return value.text

def identifier(value):
    text = atom(value)
    require(IDENT.fullmatch(text) and text not in RESERVED, f'invalid identifier: {text}')
    return text

def string(value):
    raw = atom(value)
    require(raw.startswith('"'), 'expected quoted string')
    try:
        result = json.loads(raw)
    except ValueError as error:
        raise DesignError('invalid JSON string') from error
    require(isinstance(result, str) and not any(0xd800 <= ord(c) <= 0xdfff for c in result), 'invalid string scalar')
    return result

def form(value, name=None, minimum=None, maximum=None):
    require(isinstance(value, Form) and value.items, 'expected nonempty form')
    kind = atom(value.items[0])
    require(name is None or kind == name, f'expected {name}, got {kind}')
    args = value.items[1:]
    require(minimum is None or len(args) >= minimum, f'{kind}: missing operands')
    require(maximum is None or len(args) <= maximum, f'{kind}: extra operands')
    return kind, args

def number(value):
    raw = atom(value)
    require(len(raw) <= 64 and NUMBER.fullmatch(raw), f'invalid number: {raw}')
    decimal = Decimal(raw)
    result = float(decimal)
    require(math.isfinite(result) and (not decimal or result != 0), 'number out of binary64 range')
    if not any(c in raw for c in '.eE'):
        result = int(raw)
        require(-2147483648 <= result <= 2147483647, 'integer out of DINT range')
        return 'integer', result
    return 'number', result if result else 0.0

def literal(value):
    if isinstance(value, Form):
        _, args = form(value, 'q', 2, 2)
        _, n = number(args[0])
        unit = string(args[1])
        require(bool(unit), 'empty unit')
        return {'kind': 'quantity', 'value': n, 'unit': unit}
    text = atom(value)
    if text in ('true', 'false'):
        return {'kind': 'boolean', 'value': text == 'true'}
    if text.startswith('"'):
        return {'kind': 'string', 'value': string(value)}
    kind, n = number(value)
    return {'kind': kind, 'value': n}

def value_expr(value):
    if isinstance(value, Form):
        kind, args = form(value)
        if kind == 'binding':
            form(value, kind, 1, 1)
            return {'kind': kind, 'binding_ref': identifier(args[0])}
        if kind == 'index':
            form(value, kind, 2, 2)
            return {'kind': kind, 'registry_ref': identifier(args[0]), 'binding_ref': identifier(args[1])}
    return literal(value)

def predicate(value):
    kind, args = form(value)
    if kind == 'condition':
        form(value, kind, 1, 1)
        return {'kind': 'ref', 'condition_ref': identifier(args[0])}
    if kind in ('all', 'any', 'not'):
        form(value, kind, 1, 1 if kind == 'not' else None)
        return {'kind': kind, **({'operand': predicate(args[0])} if kind == 'not'
                                 else {'operands': [predicate(a) for a in args]})}
    require(kind == 'is', f'unknown predicate: {kind}')
    form(value, kind, 2, 2)
    source, read_args = form(args[0], minimum=2, maximum=5)
    require(source in ('parameter', 'observation', 'authorization'), 'invalid read source')
    read = {'source': source, 'owner_ref': identifier(read_args[0]), 'key': string(read_args[1])}
    require(bool(read['key']), 'empty observation key')
    previous = -1
    for qualifier in read_args[2:]:
        name, qargs = form(qualifier, minimum=1, maximum=1)
        require(name in ('subject', 'slot', 'request'), 'invalid read qualifier')
        order = ('subject', 'slot', 'request').index(name)
        require(order > previous, 'qualifiers repeated or out of order')
        previous = order
        read[{'subject': 'subject_ref', 'slot': 'slot_ref', 'request': 'request_node_ref'}[name]] = identifier(qargs[0])
    return {'kind': 'is', 'read': read, 'equals': literal(args[1])}

def duration(args, positive=False):
    require(len(args) == 2, 'duration requires number and unit')
    raw, unit = atom(args[0]), atom(args[1])
    number(args[0])
    require(unit in ('s', 'ms') and not raw.startswith('-'), 'invalid duration')
    seconds = Decimal(raw) / (1000 if unit == 'ms' else 1)
    require(0 <= seconds <= 86400 and (not positive or seconds > 0), 'duration out of range')
    return {'value': raw, 'unit': unit}

def timeout(value):
    return duration(form(value, 'timeout', 2, 2)[1], positive=True)

def policy(value):
    return identifier(form(value, 'policy', 1, 1)[1][0])

def lower(text, filename='process.acp'):
    _, args = form(parse(text), 'process', 6, 6)
    require(string(args[0]) == '0.1', 'unsupported language version')
    process_id = identifier(args[1])
    environment = string(form(args[2], 'environment', 1, 1)[1][0])
    profile = identifier(form(args[3], 'profile', 1, 1)[1][0])
    conditions = {}
    for declaration in form(args[4], 'conditions')[1]:
        _, cargs = form(declaration, 'condition', 2, 2)
        key = identifier(cargs[0])
        require(key not in conditions, f'duplicate condition: {key}')
        conditions[key] = predicate(cargs[1])
    nodes, source_map = [], {}
    def node(value, depth=0):
        require(depth <= 64 and len(nodes) < 10000, 'control tree limit exceeded')
        kind, nargs = form(value, minimum=1)
        node_id = identifier(nargs[0])
        require(node_id not in source_map, f'duplicate node: {node_id}')
        prefix = text[:value.start]
        source_map[node_id] = {'file': filename, 'start_byte': len(prefix.encode('utf-8')),
            'end_byte': len(text[:value.end].encode('utf-8')), 'line': prefix.count('\n') + 1,
            'column': len(prefix.rsplit('\n', 1)[-1]) + 1}
        result = {'node_id': node_id, 'kind': kind}
        nodes.append(result)
        def child(v): return node(v, depth + 1)
        if kind in ('seq', 'par'):
            form(value, kind, 2 if kind == 'seq' else 3)
            result['children'] = [child(v) for v in nargs[1:]]
        elif kind == 'repeat':
            form(value, kind, 3, 3)
            typ, count = number(nargs[1])
            require(typ == 'integer' and 0 <= count <= 10000, 'invalid repeat count')
            result.update(count=count, child=child(nargs[2]))
        elif kind == 'delay':
            form(value, kind, 3, 3)
            result['duration'] = duration(nargs[1:])
        elif kind == 'await':
            form(value, kind, 3, 3)
            result.update(condition=predicate(nargs[1]), timeout=timeout(nargs[2]))
        elif kind == 'invoke':
            form(value, kind, 5, 5)
            arguments = {}
            for arg in form(nargs[3], 'args')[1]:
                key, operands = form(arg, minimum=1, maximum=1)
                identifier(arg.items[0])
                require(key not in arguments, f'duplicate argument: {key}')
                arguments[key] = value_expr(operands[0])
            result.update(target_ref=identifier(nargs[1]), behavior_id=identifier(nargs[2]),
                          arguments=arguments, policy_ref=policy(nargs[4]))
        elif kind == 'with-control':
            form(value, kind, 4, 4)
            result.update(control_ref=identifier(nargs[1]), policy_ref=policy(nargs[2]), child=child(nargs[3]))
        elif kind == 'fail':
            form(value, kind, 2, 2)
            code = string(nargs[1])
            require(bool(code), 'empty failure code')
            result['code'] = code
        elif kind == 'branch':
            form(value, kind, 5)
            mode = atom(nargs[1])
            require(mode in ('ordered', 'exclusive'), 'invalid branch mode')
            cases = []
            for case in nargs[3:-1]:
                _, cargs = form(case, 'case', 2, 2)
                cases.append({'condition': predicate(cargs[0]), 'child': child(cargs[1])})
            other = form(nargs[-1], 'else', 1, 1)[1][0]
            result.update(mode=mode, timeout=timeout(nargs[2]), cases=cases, otherwise=child(other))
        else:
            raise DesignError(f'unknown node: {kind}')
        return node_id
    entry = node(form(args[5], 'body', 1, 1)[1][0])
    ir = {'ir_version': '0.1', 'language': 'ac-process/0.1', 'process_id': process_id,
          'environment_ref': environment, 'execution_profile_ref': profile,
          'entry': entry, 'conditions': conditions, 'nodes': nodes}
    validate_ir(ir)
    return ir, source_map

def edges(node):
    if node['kind'] in ('seq', 'par'): return node['children']
    if node['kind'] in ('repeat', 'with-control'): return [node['child']]
    if node['kind'] == 'branch': return [c['child'] for c in node['cases']] + [node['otherwise']]
    return []

def predicates(ir):
    yield from ir['conditions'].values()
    for node in ir['nodes']:
        if node['kind'] == 'await': yield node['condition']
        if node['kind'] == 'branch': yield from (c['condition'] for c in node['cases'])

def leaves(condition, conditions, stack=()):
    kind = condition['kind']
    if kind == 'ref':
        key = condition['condition_ref']
        require(key in conditions and key not in stack, f'missing/cyclic condition: {key}')
        yield from leaves(conditions[key], conditions, (*stack, key))
    elif kind in ('all', 'any'):
        for child in condition['operands']: yield from leaves(child, conditions, stack)
    elif kind == 'not': yield from leaves(condition['operand'], conditions, stack)
    else: yield condition

def validate_ir(ir):
    def finite(value):
        if isinstance(value, dict):
            if value.get('kind') == 'integer':
                require(type(value.get('value')) is int, 'integer literal needs an integer value')
            for child in value.values(): finite(child)
        elif isinstance(value, list):
            for child in value: finite(child)
        elif isinstance(value, float):
            require(math.isfinite(value), 'non-finite IR number')
    finite(ir)
    schema = read_json(ROOT / 'process-ir.schema.json')
    Draft202012Validator.check_schema(schema)
    errors = list(Draft202012Validator(schema).iter_errors(ir))
    require(not errors, 'IR schema: ' + (errors[0].message if errors else ''))
    nodes = {n['node_id']: n for n in ir['nodes']}
    require(len(nodes) == len(ir['nodes']), 'duplicate node id')
    seen = set()
    def visit(key, depth):
        require(depth <= 64 and key in nodes and key not in seen, f'missing/shared/cyclic node: {key}')
        seen.add(key)
        for child in edges(nodes[key]): visit(child, depth + 1)
    visit(ir['entry'], 0)
    require(len(seen) == len(nodes), 'unreachable node')
    for condition in predicates(ir):
        for leaf in leaves(condition, ir['conditions']):
            request = leaf['read'].get('request_node_ref')
            require(request is None or request in nodes and nodes[request]['kind'] == 'invoke', 'invalid request node')
    for node in ir['nodes']:
        for key in ('duration', 'timeout'):
            if key in node:
                value = node[key]
                duration([Token(value['value'], 0, 0), Token(value['unit'], 0, 0)], key == 'timeout')
    # A request may only be read after its invocation has succeeded on this path.
    def scope(key, available):
        node = nodes[key]
        used = []
        if node['kind'] == 'await': used.append(node['condition'])
        if node['kind'] == 'branch': used.extend(c['condition'] for c in node['cases'])
        for condition in used:
            for leaf in leaves(condition, ir['conditions']):
                request = leaf['read'].get('request_node_ref')
                require(request is None or request in available, f'request not dominated on this activation path: {request}')
        kind = node['kind']
        if kind == 'seq':
            result = set(available)
            for child in node['children']: result = scope(child, result)
            return result
        if kind == 'par':
            results = [scope(child, set(available)) for child in node['children']]
            return set.union(set(available), *results)
        if kind == 'branch':
            results = [scope(child, set(available)) for child in edges(node)]
            return set.intersection(*results)
        if kind == 'with-control': return scope(node['child'], set(available))
        if kind == 'repeat':
            scope(node['child'], set(available))
            return set(available)  # Iteration-local identities do not escape the loop.
        return set(available) | ({key} if kind == 'invoke' else set())
    scope(ir['entry'], set())

def project_file(example_dir, relative, project_root):
    require(not Path(relative).is_absolute(), 'absolute contract/adapter path forbidden')
    candidates = [(example_dir / relative).resolve()]
    if example_dir.is_relative_to(ROOT):
        tail = example_dir.relative_to(ROOT)
        candidates.extend((base / tail / relative).resolve() for base in
                          [project_root / 'test1' / 'dsl', project_root / 'dsl'])
    for path in candidates:
        if path.is_file():
            require(path.is_relative_to(ROOT) or path.is_relative_to(project_root), 'contract outside project')
            return path
    raise DesignError(f'contract/adapter not found: {relative}')

def adapter_for(owner, behavior_id, contracts, env, example_dir, project_root):
    relative = env.get('capability_adapters', {}).get(owner, {}).get(behavior_id)
    if relative is None: return None
    adapter = read_json(project_file(example_dir, relative, project_root))
    schema = read_json(ROOT / 'capability-adapter.schema.json')
    Draft202012Validator.check_schema(schema)
    errors = list(Draft202012Validator(schema).iter_errors(adapter))
    require(not errors, 'adapter schema: ' + (errors[0].message if errors else ''))
    require(adapter['behavior_id'] == behavior_id and owner in contracts, 'adapter target mismatch')
    base, native = contracts[owner], adapter['native']
    for wanted, actual in [('spec_id', 'device_spec_id'), ('contract_version', 'contract_version'), ('definition_version', 'version')]:
        require(native[wanted] == base.get(actual), f'adapter native version mismatch: {wanted}')
    execution = base['runtime_execution_contract']
    for key in ('template_ref', 'payload_contract_ref'):
        require(native[key] == execution.get(key), f'adapter native backend mismatch: {key}')
    matches = [b for b in base['transport_behaviors'] if b['behavior_id'] == native['behavior_id']]
    require(len(matches) == 1 and matches[0]['completion_contract']['mode'] == 'observed', 'adapter native behavior missing')
    # Adapter conditions add requirements; inherited native conditions remain separate.
    for condition in adapter['condition_contract']['preconditions'] + adapter['condition_contract']['sustaining_conditions'] + adapter['completion_contract']['checks']:
        provider = env['providers'].get(condition['owner_ref'], {})
        require(condition['source'] == 'observation' and condition['key'] in provider.get('observations', {}), 'adapter fact provider missing')
        require(provider['observations'][condition['key']]['type'] == 'boolean', 'adapter fact type mismatch')
    steps = adapter['payload_recipe']['steps']
    grips = [i for i, step in enumerate(steps) if step['kind'] == 'grip']
    releases = [i for i, step in enumerate(steps) if step['kind'] == 'release']
    require(len(grips) == len(releases) == 1 and 0 < grips[0] < releases[0] < len(steps)-1, 'adapter grip/release order invalid')
    require(all(not s.get('support_clearance') or s.get('subject') == 'held_material' for s in steps), 'support clearance requires held material')
    return adapter

def resolve_argument(value, env):
    kind = value['kind']
    if kind not in ('binding', 'index'): return value
    key = value['binding_ref']
    require(key in env['bindings'], f'unknown binding: {key}')
    binding = env['bindings'][key]
    if kind == 'binding': return {'kind': binding['type'], 'value': binding['id']}
    registry = env['registries'].get(value['registry_ref'])
    require(registry is not None and registry['key_type'] == binding['type'], 'registry nominal type mismatch')
    require(binding['id'] in registry['entries'], 'identity absent from registry')
    return {'kind': 'integer', 'value': registry['entries'][binding['id']]}

def check_environment(ir, example_dir, project_root):
    relative = Path(ir['environment_ref'])
    require(not relative.is_absolute() and '..' not in relative.parts, 'environment path escapes example')
    env = read_json(example_dir / relative)
    require(env['schema_type'] == 'DesignEnvironment' and env['version'] == '0.1' and env['mode'] == 'design_only', 'not a design environment')
    require(ir['execution_profile_ref'] in env['profiles'], 'unknown profile')
    contracts = {}
    for name, binding in env['bindings'].items():
        if 'contract' not in binding: continue
        contracts[name] = read_json(project_file(example_dir, binding['contract'], project_root))
    if env.get('capability_adapters'):
        check_t0_controls(ir, contracts, env)
    for registry in env['registries'].values():
        values = list(registry['entries'].values())
        require(len(values) == len(set(values)) and all(type(v) is int and 0 < v <= 2147483647 for v in values), 'invalid registry indices')
        ids = {b['id'] for b in env['bindings'].values() if b['type'] == registry['key_type']}
        require(set(registry['entries']) <= ids, 'registry has unknown identity')
    for condition in predicates(ir):
        for leaf in leaves(condition, ir['conditions']):
            read = leaf['read']
            owner = read['owner_ref']
            if owner in contracts:
                contract = contracts[owner]
                definitions = (contract['params_schema'] if read['source'] == 'parameter' else
                    contract['runtime_contract'][read['source'] + '_definitions'])
            else:
                provider = env['providers'].get(owner)
                require(provider is not None and read['source'] == 'observation', 'missing provider')
                definitions = provider.get('observations', {})
            require(read['key'] in definitions, f'unknown fact: {owner}/{read["key"]}')
            definition = definitions[read['key']]
            expected = leaf['equals']
            require(expected['kind'] == definition['type'], 'fact comparison type mismatch')
            for key, typ in [('subject_ref', 'material'), ('slot_ref', 'slot')]:
                if key in read:
                    require(env['bindings'].get(read[key], {}).get('type') == typ, 'fact qualifier type mismatch')
            if definition.get('request_scoped') or definition.get('request'):
                require('request_node_ref' in read, 'request-scoped fact missing request')
    for node in ir['nodes']:
        if 'policy_ref' in node: require(node['policy_ref'] in env['policies'], 'unknown policy')
        if node['kind'] == 'with-control': require(node['control_ref'] in env['controls'], 'unknown control')
        if node['kind'] != 'invoke': continue
        contract = contracts.get(node['target_ref'])
        require(contract is not None, 'invoke target is not a device contract')
        adapter = adapter_for(node['target_ref'], node['behavior_id'], contracts, env, example_dir, project_root)
        matches = [adapter] if adapter else [b for b in contract['transport_behaviors'] if b['behavior_id'] == node['behavior_id']]
        require(len(matches) == 1, 'unknown/duplicate behavior')
        behavior = matches[0]
        require(behavior['schedulable'] and behavior['behavior_type'] in ('action', 'composite', 'service') and
                behavior['completion_contract']['mode'] == 'observed', 'behavior not discrete schedulable')
        specs = behavior['arguments_schema']
        require(node['arguments'].keys() <= specs.keys(), 'unknown action argument')
        for name, spec in specs.items():
            if name not in node['arguments']:
                require(not spec.get('required') or 'default' in spec, f'missing argument: {name}')
                continue
            actual = resolve_argument(node['arguments'][name], env)
            if spec['type'] == 'reference':
                require(actual['kind'] == spec['reference_type'], f'argument reference type mismatch: {name}')
                if actual['kind'] == 'location':
                    binding = env['bindings'][node['arguments'][name]['binding_ref']]
                    require(all(k in binding for k in adapter['binding_rules']['locations_require']), 'location metadata missing')
                    require(binding['owner_ref'] in env['bindings'], 'location owner missing')
                    owner_contract = contracts.get(binding['owner_ref'])
                    if owner_contract:
                        regions = owner_contract['type_specific_contract'].get('observation_regions', [])
                        require(binding['geometry_ref'] in {r['region_id'] for r in regions}, 'location geometry missing')
                continue
            wanted = 'quantity' if 'unit' in spec else spec['type']
            require(actual['kind'] == wanted, f'argument type mismatch: {name}')
            if wanted == 'quantity': require(actual['unit'] == spec['unit'], 'unit mismatch')
            v = actual['value']
            if 'min' in spec: require(v >= spec['min'], 'argument below minimum')
            if 'max' in spec: require(v <= spec['max'], 'argument above maximum')
        if adapter:
            references = {k: resolve_argument(v, env)['value'] for k, v in node['arguments'].items()}
            require(references['source'] != references['target'], 'transfer source equals target')
            rule = env['invocation_adapters'][node['node_id']]
            for argument, key in [('source', 'source_ref'), ('target', 'target_location_ref')]:
                require(env['bindings'][rule[key]]['id'] == references[argument], 'transfer location mapping mismatch')
    return env

def check_t0_controls(ir, contracts, env):
    node_map = {n['node_id']: n for n in ir['nodes']}
    parents = {child: n['node_id'] for n in ir['nodes'] for child in edges(n)}
    resources = env['resources']
    for left, right in env.get('resource_conflicts', []):
        require(left in resources and right in resources and left != right, 'invalid resource conflict')
    for control in env['controls'].values():
        owner = control['target_ref']
        require(owner in contracts and control['writer_resource'] in resources, 'control owner/resource missing')
        contract = contracts[owner]
        ports = {p['port_id']: p for p in contract['signal_ports']}
        for writes in (control['enter'], control['exit']):
            for key, value in writes.items():
                require(key in ports and ports[key]['direction'] == 'input', 'control writes unknown/output port')
                port = ports[key]
                require(port['signal_role'] in ('level_permission', 'setpoint'), 'control cannot write protocol identity/trigger')
                expected = 'quantity' if port.get('unit') else port['value_type']
                require(value['kind'] == expected, 'control value type mismatch')
                if expected == 'quantity':
                    require(value['unit'] == port['unit'], 'control unit mismatch')
                    require(isinstance(value['value'], (int, float)) and not isinstance(value['value'], bool) and math.isfinite(value['value']), 'non-finite control value')
                    drive = contract['type_specific_contract']['conveying_surface']['drive']
                    if key == drive['speed_signal']:
                        spec = contract['params_schema'][drive['speed_param']]
                        require(spec['min'] <= value['value'] <= spec['max'], 'control setpoint out of range')
                elif expected == 'boolean': require(type(value['value']) is bool, 'control value must be boolean')
        exit_condition = control['exit_condition']
        require(exit_condition['read']['owner_ref'] == owner and exit_condition['read']['key'] == 'surface_stopped' and exit_condition['equals'] == {'kind': 'boolean', 'value': True}, 'control missing actual stop confirmation')
        run_port = contract['type_specific_contract']['conveying_surface']['drive']['run_signal']
        require(control['exit'].get(run_port) == {'kind': 'boolean', 'value': False}, 'control must withdraw run on exit')
    for node in ir['nodes']:
        if node['kind'] != 'invoke': continue
        rule = env.get('invocation_adapters', {}).get(node['node_id'])
        require(rule is not None and rule['target_ref'] == node['target_ref'] and rule['behavior_id'] == node['behavior_id'], 'invocation adapter missing/mismatched')
        require(rule['writes_material_pose'] is False and all(r in resources for r in rule['claims']), 'invalid invocation claims/pose ownership')
        if 'drive_dependency' in rule:
            ancestor, found = parents.get(node['node_id']), False
            while ancestor:
                p = node_map[ancestor]
                found |= p['kind'] == 'with-control' and p['control_ref'] == rule['drive_dependency']
                ancestor = parents.get(ancestor)
            require(found and env['controls'][rule['drive_dependency']]['target_ref'] == node['target_ref'], 'transport requires matching enclosing drive scope')

def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--write', action='store_true', help='regenerate golden IR and source map')
    cli.add_argument('--project-root', type=Path, default=ROOT.parents[1])
    cli.add_argument('--example', default='pick-place', help='example directory name, or all')
    args = cli.parse_args()
    choices = [p.name for p in (ROOT / 'examples').iterdir() if (p / 'process.acp').is_file()]
    require(args.example == 'all' or args.example in choices, 'unknown example')
    for selected in sorted(choices) if args.example == 'all' else [args.example]:
        example = ROOT / 'examples' / selected
        source = example / 'process.acp'
        ir, mapping = lower(read_source(source), f'examples/{selected}/process.acp')
        env = check_environment(ir, example, args.project_root.resolve())
        outputs = [('process.ir.json', ir), ('process.map.json', mapping)]
        for name, data in outputs:
            path = example / name
            if args.write: path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            else: require(read_json(path) == data, f'{name} differs from source; regenerate explicitly')
        if env.get('capability_adapters'):
            from binding_report import build_report
            report = build_report(ir, env, source, example, args.project_root.resolve())
            path = example / 'process.binding.json'
            if args.write: path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            else: require(read_json(path) == report, 'binding report stale; regenerate explicitly')
        print(f'{selected}: Design checks passed: {len(ir["nodes"])} nodes; text/IR/source map agree.')
        print(f'Executable: false; {len(env["execution_blockers"])} declared integration blockers remain.')

if __name__ == '__main__':
    main()
