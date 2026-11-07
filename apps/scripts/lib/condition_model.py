"""Validate ac-condition/0.1 declarations; this module does not evaluate runtime conditions."""
import math

VERSION = 'ac-condition/0.1'
TYPES = {'boolean', 'integer', 'number', 'string'}
SCOPES = {'run', 'run_subject', 'request', 'request_subject'}

def validate_condition_model(contract):
    runtime = contract.get('runtime_contract', {})
    model = runtime.get('condition_model')
    if model is None:
        if any('expression_ref' in d for table in ('observation_definitions','authorization_definitions') for d in runtime.get(table,{}).values()):
            raise ValueError('Condition model: expression references without model')
        return  # Explicit legacy path, not an expression-capable runtime claim.
    def need(ok, message):
        if not ok: raise ValueError('Condition model: ' + message)
    def shape(value, required, optional=()):
        need(isinstance(value, dict) and set(required) <= set(value) <= set(required) | set(optional), 'invalid fields')
    shape(model, ('schema_version', 'execution_mode', 'unknown_policy', 'bindings', 'expressions'))
    need(model['schema_version'] == VERSION, 'unsupported version')
    need(model['execution_mode'] == 'declaration_only', 'expression execution is not implemented by this compiler')
    need(model['unknown_policy'] == 'three_valued_fail_closed', 'invalid unknown policy')
    need(isinstance(model['bindings'], dict) and isinstance(model['expressions'], dict), 'expected binding/expression maps')
    behaviors = {b['behavior_id']: b for b in contract['transport_behaviors']}
    ports = {p['port_id']: p for p in contract['signal_ports']}
    definitions = {}
    for source, table in [('observation', 'observation_definitions'), ('authorization', 'authorization_definitions')]:
        for key, definition in runtime.get(table, {}).items():
            need(key not in definitions, 'duplicate condition key: ' + key)
            need(definition.get('expression_ref') == key, 'missing expression reference: ' + key)
            definitions[key] = source
    need(set(model['expressions']) == set(definitions), 'expression coverage differs from registered conditions')
    phases = {}
    for behavior in behaviors.values():
        for phase, checks in [('precondition', behavior['condition_contract']['preconditions']),
                              ('sustaining', behavior['condition_contract']['sustaining_conditions']),
                              ('completion', behavior['completion_contract']['checks'])]:
            for check in checks:
                if check['source'] == 'parameter': continue
                key = check['key']
                need(definitions.get(key) == check['source'], 'condition source mismatch: ' + key)
                need(type(check.get('equals')) is bool, 'Boolean conditions require Boolean equals')
                phases.setdefault(key, []).append((behavior['behavior_id'], phase, check['source']))
    need(set(phases) <= set(definitions), 'missing condition definition')
    common = {'kind', 'behavior', 'value_type', 'unit'}
    fields = {
        'signal': {'device', 'port', 'scope', 'required_quality', 'freshness'},
        'parameter': {'parameter'},
        'profile': {'profile', 'parameter', 'implementation_status'},
        'observation': {'provider', 'description', 'scope', 'arguments', 'sample_keys', 'max_age_ticks', 'implementation_status'},
        'authorization': {'provider', 'scope', 'arguments', 'resource_set', 'implementation_status'},
        'request': {'field', 'scope', 'implementation_status'},
    }
    statuses = {'profile': 'pending_profile_binding', 'observation': 'pending_provider_binding',
                'authorization': 'pending_provider_binding', 'request': 'pending_request_trace_binding'}
    for name, binding in model['bindings'].items():
        need(isinstance(binding, dict) and binding.get('kind') in fields, 'unsupported binding: ' + name)
        kind = binding['kind']
        shape(binding, common | fields[kind])
        need(binding['behavior'] in behaviors and name.startswith(binding['behavior'] + '.'), 'binding behavior mismatch: ' + name)
        need(binding['value_type'] in TYPES and isinstance(binding['unit'], str) and bool(binding['unit']), 'invalid binding type/unit')
        if binding['value_type'] not in ('number', 'integer'): need(binding['unit'] == '1', 'non-numeric unit')
        if 'scope' in binding: need(binding['scope'] in SCOPES, 'invalid correlation scope')
        if kind in statuses: need(binding['implementation_status'] == statuses[kind], 'unsupported binding status')
        if kind == 'signal':
            need(binding['device'] == 'self' and binding['port'] in ports, 'unknown signal port: ' + name)
            port = ports[binding['port']]
            need((binding['value_type'], binding['unit']) == (port['value_type'], port.get('unit', '1')), 'signal type/unit mismatch')
            need(binding['required_quality'] == 'good' and binding['freshness'] == 'signal_definition', 'invalid signal quality rule')
        elif kind == 'parameter':
            parameter = contract['params_schema'].get(binding['parameter'])
            need(parameter is not None, 'unknown parameter: ' + name)
            typ = 'string' if parameter['type'] == 'enum' else parameter['type']
            need((binding['value_type'], binding['unit']) == (typ, parameter.get('unit', '1')), 'parameter type/unit mismatch')
        elif kind == 'request':
            need(binding['field'] in ('matching_accepted', 'matching_success') and binding['value_type'] == 'boolean', 'invalid request evidence')
            need(binding['scope'] in ('request', 'request_subject'), 'request evidence requires request identity')
        elif kind == 'profile':
            need(binding['profile'] == 'scene.assembly@1' and binding['parameter'] in ('position_tolerance_m', 'speed_tolerance_mps'), 'unsupported execution profile parameter')
            expected_unit = {'position_tolerance_m':'m', 'speed_tolerance_mps':'m/s'}[binding['parameter']]
            need(binding['value_type'] == 'number' and binding['unit'] == expected_unit, 'profile type/unit mismatch')
        if kind in ('authorization', 'observation'):
            need(isinstance(binding['provider'], str) and binding['provider'].endswith('@1'), 'provider must have a version')
            need(isinstance(binding['arguments'], dict), 'invalid provider arguments')
            if kind == 'authorization':
                need(binding['resource_set'] == 'compiled_action_footprint' and binding['scope'].startswith('request') and binding['value_type'] == 'boolean', 'invalid authorization')
            else:
                need(type(binding['max_age_ticks']) is int and binding['max_age_ticks'] > 0, 'invalid observation freshness')
                need(isinstance(binding['sample_keys'], list) and bool(binding['sample_keys']) and all(isinstance(k,str) and k and '\\' not in k and '..' not in k for k in binding['sample_keys']), 'invalid sample keys')
            behavior = behaviors[binding['behavior']]
            payload = contract.get('runtime_execution_contract', {}).get('payload_templates', {}).get(binding['behavior'], {}).get('fields', {})
            for argument in binding['arguments'].values():
                need(isinstance(argument,dict), 'invalid argument selector')
                origin = argument.get('from')
                if origin == 'self': shape(argument, ('from',))
                else:
                    shape(argument, ('from', 'name'))
                    need(origin in ('argument','payload'), 'unknown argument selector')
                    need(argument['name'] in (behavior['arguments_schema'] if origin == 'argument' else payload), 'missing argument/payload reference')
    budget = 0
    def expression(node, key, behavior, phase, source, depth=0):
        nonlocal budget
        budget += 1
        need(depth <= 32 and budget <= 8192, 'expression complexity budget exceeded')
        need(isinstance(node, dict), 'expression must be an object')
        op = node.get('op')
        def child(n): return expression(n, key, behavior, phase, source, depth+1)
        if op == 'opaque':
            shape(node, ('op','source','key'))
            need(depth == 0 and node['key'] == key and node['source'] == definitions[key], 'opaque provider must delegate the original key')
            return ('boolean', '1')
        if op in ('all','any'):
            shape(node, ('op','args'))
            need(isinstance(node['args'],list) and bool(node['args']), 'empty logical group')
            need(all(child(n) == ('boolean','1') for n in node['args']), 'logical operands must be Boolean')
            return ('boolean','1')
        if op == 'not':
            shape(node, ('op','arg'))
            need(child(node['arg']) == ('boolean','1'), 'NOT requires Boolean')
            return ('boolean','1')
        if op == 'literal':
            shape(node, ('op','value','unit'))
            value = node['value']
            typ = 'boolean' if type(value) is bool else 'integer' if type(value) is int else 'number' if type(value) is float else 'string' if type(value) is str else None
            need(typ in TYPES and isinstance(node['unit'],str) and bool(node['unit']), 'invalid literal')
            if typ in ('number','integer'): need(math.isfinite(value), 'nonfinite literal')
            else: need(node['unit'] == '1', 'invalid literal unit')
            return (typ,node['unit'])
        if op == 'ref':
            shape(node, ('op','binding'))
            binding = model['bindings'].get(node['binding'])
            need(binding is not None and binding['behavior'] == behavior, 'unknown or foreign binding')
            need(not (phase == 'precondition' and source != 'authorization' and binding['kind'] == 'authorization'), 'resource grant cannot gate its own candidate')
            need(not (phase == 'completion' and binding['kind'] == 'signal' and binding['port'] in ('done','accepted','result_id')), 'completion feedback cycle')
            need(not (phase == 'precondition' and binding['kind'] == 'request'), 'request evidence cannot gate submission')
            need(not (phase == 'precondition' and binding['kind'] == 'signal' and binding['port'] in ('execute','start_pick','release_waiting_material')), 'self-trigger prerequisite cycle')
            if binding.get('scope') in ('run_subject','request_subject'):
                b = behaviors[behavior]
                payload = contract.get('runtime_execution_contract',{}).get('payload_templates',{}).get(behavior,{}).get('fields',{})
                need('subject_id' in b['arguments_schema'] or 'material' in b['arguments_schema'] or 'material' in payload, 'subject correlation without subject')
            return (binding['value_type'],binding['unit'])
        if op == 'compare':
            shape(node, ('op','operator','left','right'))
            need(node['operator'] in ('eq','ne','lt','le','gt','ge'), 'invalid comparison')
            left,right = child(node['left']),child(node['right'])
            numeric = left[0] in ('number','integer') and right[0] in ('number','integer')
            need(left[1] == right[1] and (numeric or left[0] == right[0]), 'comparison type/unit mismatch')
            need(numeric or node['operator'] in ('eq','ne'), 'ordered comparison requires numbers')
            return ('boolean','1')
        raise ValueError('Condition model: unsupported expression operator: ' + str(op))
    for key, entry in model['expressions'].items():
        shape(entry, ('status','expr'), ('note',))
        need(entry['status'] in ('structured','opaque'), 'invalid expression status')
        need(isinstance(entry['expr'],dict) and (entry['expr'].get('op') == 'opaque') == (entry['status'] == 'opaque'), 'expression status mismatch')
        if key not in phases: need(entry['status'] == 'opaque', 'unreferenced structured condition')
        for behavior, phase, source in phases.get(key, [('', 'definition', definitions[key])]):
            need(expression(entry['expr'],key,behavior,phase,source) == ('boolean','1'), 'condition root must be Boolean')
