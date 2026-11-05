"""Validate declarations and their automatic contract gates without running devices."""
import math


def validate_declaration(ir, binding, specs, interfaces, batch):
    errors, blockers = [], []
    instances = binding['instances']
    locations = binding.get('locations', {})
    automatic = ir['language'] == 'ac-declarative/0.3'
    field_types = binding.get('batch_field_types', {})
    job_fields = {k: field_types.get(k, 'string') for row in batch.get('jobs', []) for k in row}
    item_fields = {k: field_types.get(k, 'string') for p in batch.get('pallets', []) for row in p['items'] for k in row}
    pallet_fields = {'id': 'pallet_ref', 'items': ('collection', item_fields, batch.get('max_items_per_pallet', 0))}

    def error(code, message, node):
        errors.append(dict(code=code, message=message, source=node.get('source')))

    def blocked(code, **details):
        blockers.append(dict(code=code, **details))

    def need(condition, message):
        if not condition:
            raise ValueError(message)

    def literal(expr):
        need(expr.get('kind') == 'literal', '需要常量')
        return expr['value']

    def expr_type(expr, scope):
        kind = expr['kind']
        if kind == 'literal':
            value = expr['value']
            return {bool: 'boolean', int: 'integer', float: 'number', str: 'string'}[type(value)]
        if kind == 'ref':
            name = expr['name']
            if name == 'batch':
                return {'pallet_count': 'integer', 'max_items_per_pallet': 'integer', 'material_count': 'integer', 'job_count': 'integer',
                        'jobs': ('collection', job_fields, len(batch.get('jobs', []))),
                        'pallets': ('collection', pallet_fields, len(batch.get('pallets', [])))}
            if name in scope:
                return scope[name]
            need(name in instances, '未绑定名称：' + name)
            return 'device_ref'
        if kind == 'field':
            base = expr['base']
            if base['kind'] == 'ref' and base['name'] in instances:
                key = base['name'] + '.' + expr['field']
                need(key in locations, '未绑定位置：' + key)
                return 'location_ref'
            fields = expr_type(base, scope)
            need(isinstance(fields, dict) and expr['field'] in fields, '字段或变量作用域无效：' + expr['field'])
            return fields[expr['field']]
        if kind in ('add', 'sub'):
            need(expr_type(expr['left'], scope) == expr_type(expr['right'], scope) == 'integer', '计数仅允许整数加减')
            return 'integer'
        if kind in ('quantity', 'seconds', 'milliseconds'):
            need(expr_type(expr['args'][0], scope) in ('number', 'integer'), '数量必须是数字')
            if expr['args'][0]['kind']=='literal':
                value = literal(expr['args'][0]);need(type(value) in (int, float) and math.isfinite(value), '数量必须是有限数字')
            return ('quantity', literal(expr['args'][1]) if kind == 'quantity' else 's' if kind == 'seconds' else 'ms')
        if kind in ('select', 'chunks'):
            typ=expr_type(expr['args'][0],scope)
            need(isinstance(typ,tuple) and typ[0]=='collection', '筛选或分组需要有限集合')
            if kind=='select':
                for key,value in expr['kwargs'].items():
                    need(key in typ[1] and expr_type(value,scope)==typ[1][key], '筛选字段不存在或类型不符')
                return typ
            size=literal(expr['kwargs']['size']);need(type(size)is int and 1<=size<=10000,'分组大小无效')
            return ('collection',('collection',typ[1],min(size,typ[2])),math.ceil(typ[2]/size))
        if kind == 'calibration':
            need(automatic and expr['args'][0]['kind'] == 'ref', '标定必须引用固定实例')
            device = expr['args'][0]['name']
            need(device in instances, '标定实例不存在')
            key = device + '.' + literal(expr['args'][1])
            record = binding.get('calibrations', {}).get(key)
            need(record is not None and record.get('type') == 'number', '缺少数值标定声明：' + key)
            need(record.get('unit') and record.get('min', 0) <= record.get('max', 0), '标定单位或范围无效')
            value = record.get('value')
            if record.get('status') == 'pending_calibration':
                need(value is None, '待标定值不得冒充有效数值')
                blocked('CALIBRATION_REQUIRED', calibration=key)
            else:
                need(record.get('status') == 'calibrated' and type(value) in (int, float) and math.isfinite(value), '无有效标定值')
                need(record['min'] <= value <= record['max'], '标定值超范围')
            return ('quantity', record['unit'])
        if kind == 'subject_id':
            need(automatic and expr_type(expr['args'][0], scope) == 'material_ref', 'subject_id需要已声明的物料身份')
            need(binding.get('identity_registry', {}).get('entries'), '缺少身份登记表')
            blocked('IDENTITY_REGISTRY_RUNTIME_BINDING_REQUIRED')
            return 'integer'
        if kind == 'fact':
            name = literal(expr['args'][0])
            desc = interfaces['facts'].get(name)
            need(desc is not None, '未登记事实：' + name)
            need(set(expr['kwargs']) == set(desc['parameters']), '事实参数不匹配：' + name)
            for key, typ in desc['parameters'].items():
                need(expr_type(expr['kwargs'][key], scope) == typ, '事实参数类型错误：' + name + '.' + key)
            record = binding.get('fact_bindings', {}).get(name)
            need(record is not None and record.get('side_effects') is False, '事实缺少只读场景绑定：' + name)
            for source in record.get('sources', []):
                if '/' in source:
                    device, port = source.split('/', 1)
                    need(device in instances, '事实信号实例不存在：' + source)
                    spec = specs[instances[device]['contract']]
                    need(any(p['port_id'] == port and p['direction'] == 'output' for p in spec['signal_ports']), '事实必须读取已声明反馈：' + source)
            blocked('PENDING_SCENE_FACT_PROVIDER', fact=name)
            return desc['value_type']
        if kind == 'items_at':
            need(expr_type(expr['args'][0], scope) == 'location_ref', 'items_at需要已绑定工位')
            if expr['kwargs']:
                need(expr_type(expr['kwargs']['category'], scope) == 'string', '类别必须为字符串')
            desc = binding.get('collection_bindings', {}).get('items_at')
            need(desc is not None and desc.get('side_effects') is False and desc.get('unknown_policy') == 'block_not_empty', '库存集合缺少有效提供者声明')
            if automatic:
                admission = desc.get('admission', {})
                need(admission.get('mode') == 'automatic_before_snapshot' and admission.get('requirements') and admission.get('timeout_policy') == 'process_contract.collection_timeout_s', '集合缺少自动准入及超时规则')
            blocked('PENDING_COLLECTION_PROVIDER', collection='items_at')
            return ('collection', desc['fields'])
        if kind in ('all_of', 'any_of', 'not_'):
            need(all(expr_type(a, scope) == 'boolean' for a in expr['args']), '逻辑组合需要布尔条件')
            return 'boolean'
        if kind in ('eq', 'ne', 'lt', 'le', 'gt', 'ge'):
            left, right = [expr_type(a, scope) for a in expr['args']]
            need(left == right, '比较类型或单位不一致')
            if kind not in ('eq', 'ne'):
                need(left in ('integer', 'number') or isinstance(left, tuple) and left[0] == 'quantity', '有序比较需要数值')
            return 'boolean'
        raise ValueError('此位置不支持的表达式：' + kind)

    def count_value(expr, scope):
        need(expr_type(expr, scope) == 'integer', '循环上限必须为整数')
        if expr['kind'] == 'literal':
            return expr['value']
        if expr['kind'] == 'field':
            need(expr['base'] == {'kind': 'ref', 'name': 'batch'}, '循环上限只允许batch统计')
            value = batch[expr['field']]
            need(type(value) is int, 'batch计数不是整数')
            return value
        if expr['kind'] in ('add', 'sub'):
            a, b = count_value(expr['left'], scope), count_value(expr['right'], scope)
            return a + b if expr['kind'] == 'add' else a - b
        raise ValueError('无法静态求值的循环上限')

    def duration(expr, scope, positive=True):
        need(expr_type(expr, scope) in (('quantity', 's'), ('quantity', 'ms')), '时间单位错误')
        value = literal(expr['args'][0]) / (1000 if expr['kind'] == 'milliseconds' else 1)
        need((value > 0 if positive else value >= 0) and value <= 86400, '时间范围错误')

    def visit(node, scope):
        writers = set()
        try:
            kind = node['kind']
            if kind in ('seq', 'par'):
                for child in node['children']:
                    other = visit(child, scope)
                    need(kind != 'par' or not writers & other, '并行分支存在持续信号写冲突')
                    writers |= other
            elif kind == 'repeat':
                over=node.get('over',{})
                needs_receipt=(over.get('kind')=='chunks' or over.get('kind')=='field' and over.get('field')=='pallets' and over.get('base')=={'kind':'ref','name':'batch'})
                if needs_receipt:need(node['id'] in binding.get('iteration_contracts',{}), '载具批次循环缺少外部交接准入和收尾绑定')
                if 'count' in node:
                    need(0 <= count_value(node['count'], scope) <= 10000, '循环计数越界')
                    writers |= visit(node['body'], scope)
                else:
                    typ = expr_type(node['over'], scope)
                    need(isinstance(typ, tuple) and typ[0] == 'collection', 'repeat需要有限集合')
                    limit = count_value(node['limit'], scope)
                    bound=typ[2] if len(typ)>2 else batch['max_items_per_pallet']
                    need(0 <= limit <= 10000 and limit >= bound, '集合循环上限不足或越界')
                    need(node['bind'] not in scope and node['bind'] not in instances, '循环变量遮蔽')
                    # Validate the body even when the station is currently empty.
                    writers |= visit(node['body'], {**scope, node['bind']: typ[1]})
            elif kind == 'await':
                need(not automatic, '0.3禁止显式等待节点')
                need(expr_type(node['condition'], scope) == 'boolean', 'wait_for需要布尔条件')
                duration(node['timeout'], scope)
            elif kind == 'delay':
                duration(node['duration'], scope, False)
            elif kind == 'branch':
                duration(node['timeout'], scope)
                for case in node['cases']:
                    need(expr_type(case['condition'], scope) == 'boolean', '分支条件需要布尔值')
                    writers |= visit(case['body'], scope)
                writers |= visit(node['otherwise'], scope)
            elif kind == 'invoke':
                device = node['device'].get('name')
                need(device in instances, '动作实例不存在')
                spec = specs[instances[device]['contract']]
                if spec.get('schema_type')=='ExperimentalAssetContract':
                    behavior=next((b for b in spec['definition']['behaviors'] if b['id']==node['behavior']),None)
                    need(behavior is not None and behavior['invocable'], '实验资产中不存在此可调用行为')
                    arguments={p['id']:p for p in behavior['arguments']}
                    need(set(arguments)==set(node['arguments']), '实验行为参数不匹配')
                    for key,value in node['arguments'].items():
                        typ=expr_type(value,scope);expected=arguments[key]['type']
                        if expected=='recipe_ref' and value['kind']=='literal':
                            recipe=literal(value);need(recipe in binding.get('recipes',{}) and binding['recipes'][recipe]['station']==device,'配方不属于加工设备')
                        else:need(typ==expected,'实验行为参数类型不匹配')
                    legacy=binding.get('experimental_condition_bindings',{}).get(device+'/'+node['behavior'])
                    need(legacy is not None and legacy.get('status')=='pending_normative_contract','缺少实验条件来源绑定')
                    need(legacy['preconditions']==behavior['preconditions'] and legacy['sustaining_conditions']==behavior['sustaining_conditions'] and legacy['completion']==behavior['completion'],'实验条件与原始定义不一致')
                    blocked('EXPERIMENTAL_CONTRACT_NOT_ADMITTED',node=node['id'],behavior=node['behavior'])
                    return writers
                behavior = next((b for b in spec.get('transport_behaviors', []) if b['behavior_id'] == node['behavior']), None)
                need(behavior is not None, '动作不在设备契约中')
                for name, argument in node['arguments'].items():
                    typ = expr_type(argument, scope)
                    parameter = behavior['arguments_schema'].get(name)
                    need(parameter is not None, '未知行为标量参数：' + name)
                    expected = ('quantity', parameter['unit']) if parameter.get('unit', '1') != '1' else parameter['type']
                    need(typ == expected or expected == 'number' and typ == 'integer', '行为参数类型或单位错误：' + name)
                    if argument['kind']=='literal' or argument['kind']=='quantity' and argument['args'][0]['kind']=='literal':
                        value = literal(argument if argument['kind'] == 'literal' else argument['args'][0])
                        if type(value) in (int, float):
                            need(math.isfinite(value) and parameter.get('min', -math.inf) <= value <= parameter.get('max', math.inf), '行为参数超范围：' + name)
                    elif argument['kind'] == 'calibration':
                        key = argument['args'][0]['name'] + '.' + literal(argument['args'][1])
                        record = binding['calibrations'][key]
                        need(parameter.get('min', -math.inf) <= record['min'] <= record['max'] <= parameter.get('max', math.inf), '标定范围超出行为契约')
                if automatic:
                    for condition in behavior['condition_contract']['preconditions'] + behavior['condition_contract']['sustaining_conditions'] + behavior['completion_contract']['checks']:
                        key = device + '/' + condition['key']
                        provider = binding.get('condition_bindings', {}).get(key)
                        need(provider is not None, '缺少自动契约条件绑定：' + key)
                        need(provider['contract'] == instances[device]['contract'] and provider['version'] == spec['version'] and provider['source'] == condition['source'] and provider['key'] == condition['key'], '自动条件来源或版本不符')
                        registry = 'authorization_definitions' if condition['source'] == 'authorization' else 'observation_definitions'
                        definition = spec['runtime_contract'][registry][condition['key']]
                        expected_signals = {device + '/' + s for s in definition.get('signal_refs', [])}
                        need(set(provider['signals']) == expected_signals, '自动条件信号与契约不一致')
                        for path in expected_signals:
                            port = path.split('/', 1)[1]
                            signal = instances[device].get('signal_bindings', {}).get(port)
                            declared = next(p for p in spec['signal_ports'] if p['port_id'] == port)
                            need(signal is not None and signal['logical_signal'] == path and signal['plc_type'] == declared['plc_type'] and signal['direction'] == declared['direction'], '实例条件信号未绑定或类型错误')
                        need(provider['status'] == 'pending_provider', '条件提供者尚未实现，不得声明可执行')
                        blocked('PENDING_CONTRACT_CONDITION_PROVIDER', node=node['id'], condition=key)
                payload = node.get('payload')
                if device in instances and instances[device]['contract'] == 'robot_arm':
                    need(payload is not None, '机械臂调用必须显式声明待适配载荷')
                if payload is not None:
                    key = literal(payload['args'][0])
                    desc = binding.get('command_payloads', {}).get(key)
                    need(desc is not None, '未登记命令载荷：' + key)
                    need(node['device']['kind'] == 'ref' and desc['instance'] == node['device']['name'] and desc['behavior'] == node['behavior'], '载荷不能更换设备或行为')
                    need(desc.get('status') == 'pending_model_adapter', '当前仅支持待适配载荷声明，不能声称已实现')
                    spec = specs[instances[desc['instance']]['contract']]
                    need(desc['contract_version'] == spec['version'], '载荷绑定契约版本过期')
                    need(set(desc['fields']) == set(payload['kwargs']), '载荷字段不匹配：' + key)
                    for field, typ in desc['fields'].items():
                        need(expr_type(payload['kwargs'][field], scope) == typ, '载荷字段类型错误：' + key + '.' + field)
                    blocked('PENDING_TYPED_PAYLOAD_ADAPTER', binding=key, node=node['id'])
            elif kind == 'with-control':
                need(node['device']['kind'] == 'ref', '持续控制要求固定实例')
                device = node['device']['name']
                need(device in instances, '未知持续控制实例')
                spec = specs[instances[device]['contract']]
                need(instances[device]['contract'] == 'conveyor' and node['control'] == 'forward_drive', '当前0.2只实现传送带forward_drive的配置检查')
                control = binding.get('controls', {}).get(device + '.' + node['control'])
                need(control is not None, '持续控制未绑定')
                need(control['instance'] == device and control['contract'] == instances[device]['contract'] and control['contract_version'] == spec['version'], '持续控制绑定对象或版本错误')
                behaviors = {b['behavior_id']: b for b in spec['transport_behaviors']}
                entry, exit_ = behaviors.get(control['behavior']), behaviors.get(control['exit_behavior'])
                need(entry is not None and exit_ is not None, '持续控制引用不存在的契约行为')
                need(entry['schedulable'] and entry['behavior_type'] not in ('internal', 'observer', 'passive') and entry['completion_contract']['mode'] == 'continuous', '进入行为必须可调度且持续')
                need(exit_['schedulable'] and exit_['completion_contract']['mode'] != 'continuous', '退出必须是可调度的有限行为')
                for b, key, section in ((entry, 'enter_confirm', 'checks'), (exit_, 'exit_confirm', 'checks')):
                    need(control[key] in {c['key'] for c in b['completion_contract'][section]}, '进入/退出证据不在行为契约')
                need(control['sustaining'] in {c['key'] for c in entry['condition_contract']['sustaining_conditions']}, '持续条件不在契约')
                need(0 < control['enter_timeout_s'] <= 86400 and 0 < control['exit_timeout_s'] <= 86400, '控制超时无效')
                need(not control['delegates'], '当前版本不支持隐式控制授权委托')
                need(control['exit_policy'] == 'always_stop_on_success_failure_timeout_cancel; unknown_stop_keeps_ownership_and_requires_attention', '控制必须覆盖全部退出路径')
                ports = {p['port_id']: p for p in spec['signal_ports']}
                settings = node['setpoints']
                need(settings['kind'] == 'map' and set(settings['items']) == set(control['setpoint_bindings']), '持续控制设定项不匹配')
                destinations = list(control['setpoint_bindings'].values()) + list(control['enter_constants'])
                need(len(set(destinations)) == len(destinations) and set(destinations) == set(control['writer_ports']) == set(control['exit_setpoints']), '持续控制写入和退出集合不完整或重复')
                for port in destinations:
                    need(port in ports and ports[port]['direction'] == 'input', '不能写未知端口或设备输出：' + port)
                    need(port in entry['input_signals'], '写入端口不属于进入行为：' + port)
                    signal = instances[device].get('signal_bindings', {}).get(port)
                    need(signal is not None and signal['logical_signal'] == device + '/' + port and signal['plc_type'] == ports[port]['plc_type'], '实例信号映射错误')
                for key, value in settings['items'].items():
                    port = ports[control['setpoint_bindings'][key]]
                    typ = ('quantity', port['unit']) if port.get('unit', '1') != '1' else port['value_type']
                    need(expr_type(value, scope) == typ, '持续设定单位或类型错误')
                    if value['kind'] == 'quantity':
                        need(0 < literal(value['args'][0]) <= spec['params_schema']['speed_mps']['max'], 'forward_drive速度必须在正向范围内')
                need(control['enter_constants'] == {'runTag': True} and control['exit_setpoints'] == {'runTag': False, 'speedTag': {'value': 0, 'unit': 'm/s'}}, 'forward_drive必须按约定进入并停机退出')
                own = {(device, p) for p in destinations}
                children = visit(node['body'], scope)
                need(not own & children, '持续控制嵌套写冲突')
                writers |= own | children
                blocked('PENDING_CONTINUOUS_CONTROL_ADAPTER', device=device, entry=control['behavior'], exit=control['exit_behavior'])
            elif kind != 'fail':
                raise ValueError('未知控制节点')
        except (ValueError, KeyError, TypeError) as exc:
            error('DECLARATION_BINDING_INVALID', str(exc), node)
        return writers

    try:
        pallets = batch.get('pallets',[])
        rows=batch.get('jobs',[])+[item for pallet in pallets for item in pallet['items']]
        materials=[row['material'] for row in rows]
        need(batch['pallet_count'] == len(pallets) and len({p['id'] for p in pallets}) == len(pallets), '托盘计数或身份重复')
        need(batch['material_count'] == len(materials) == len(set(materials)), '物料计数或身份重复')
        need(batch['max_items_per_pallet'] == max((len(p['items']) for p in pallets), default=0), '单盘上限与清单不符')
        need(all(m in instances and instances[m]['contract'] == 'material' for m in materials), '清单物料没有实例绑定')
        need(all(p['id'] in instances and instances[p['id']]['contract'] == 'pallet' for p in pallets), '清单托盘没有实例绑定')
        for pallet in pallets:
            for item in pallet['items']:
                slot=item.get('source',item.get('target'))
                need(slot in locations and locations[slot]['owner'] == pallet['id'], '初始或目标槽位不属于托盘')
        if field_types:
            need(batch.get('job_count',0)==len(batch.get('jobs',[])), '订单计数错误')
            for row in rows:
                for key,value in row.items():
                    need(key in field_types,'未声明批次字段类型：'+key)
                    typ=field_types[key]
                    if typ=='location_ref':need(value in locations,'批次位置未绑定')
                    elif typ in ('material_ref','device_ref'):need(value in instances,'批次身份未绑定')
                    elif typ=='recipe_ref':need(value in binding.get('recipes',{}),'批次配方未登记')
                    elif typ=='boolean':need(type(value)is bool,'批次布尔字段类型错误')
                    elif typ=='number':need(type(value)in(int,float) and math.isfinite(value),'批次数值无效')
                    else:need(type(value)is str,'批次字符串类型错误')
        for record in binding.get('iteration_contracts',{}).values():
            need(record.get('status')=='pending_provider' and record.get('entry') and record.get('completion') and record.get('unknown_policy')=='block_then_fail_on_deadline','循环交接契约无效')
            blocked('PENDING_ITERATION_HANDOFF_PROVIDER')
        if batch.get('jobs') and all(j.get('input')==j.get('target') for j in batch['jobs']):
            need(binding.get('iteration_contracts'), '共用进出料位置的循环缺少交接屏障')
        if automatic:
            lifecycle = binding.get('process_contract', {})
            need(lifecycle.get('task_specification') == 'task-spec.json' and lifecycle.get('completion') == 'independent_goal_monitor', '缺少自动独立验收配置')
            need(lifecycle.get('unknown_policy') == 'block_then_fail_on_deadline', '未知证据必须阻塞并受期限约束')
            need(lifecycle.get('on_failure') == 'stop_admissions_cancel_siblings_stop_drives_confirm_or_attention', '缺少失败与取消停止规则')
            for key in ('precondition_timeout_s', 'acceptance_timeout_s', 'execution_timeout_s', 'stop_timeout_s', 'collection_timeout_s', 'finalization_timeout_s'):
                value = lifecycle.get(key)
                need(type(value) in (int, float) and math.isfinite(value) and 0 < value <= 86400, '缺少有效期限：' + key)
            registry = binding.get('identity_registry', {})
            entries = registry.get('entries', {})
            need(registry.get('plc_type') == 'DINT' and registry.get('zero_reserved') is True, '身份表必须声明DINT及零保留')
            need(set(entries) == set(materials) and len(set(entries.values())) == len(entries), '身份登记缺失或重复')
            need(all(type(n) is int and 1 <= n <= 2147483647 for n in entries.values()), '身份编号超出DINT范围')
            blocked('PENDING_PROCESS_LIFECYCLE_RUNTIME')
            blocked('PENDING_INDEPENDENT_FINALIZATION', specification='task-spec.json')
        else:
            root = ir['body']
            need(root['kind'] == 'seq' and root['children'][-1]['kind'] == 'await', '流程必须以独立验收等待结束')
            condition = root['children'][-1]['condition']
            need(condition['kind'] == 'fact' and literal(condition['args'][0]) == 'batch_goal_satisfied' and literal(condition['kwargs']['specification']) == 'task-spec.json', '缺少独立批次目标')
    except (ValueError, KeyError, TypeError) as exc:
        error('DECLARATION_BINDING_INVALID', str(exc), ir['body'])
    visit(ir['body'], {})
    return errors, blockers
