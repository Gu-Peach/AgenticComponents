"""Deterministic design report. Does not assemble poses or run a device."""
import hashlib
import json
from pathlib import Path

import check_design as d

def build_report(ir, env, source, example, repository):
    dependencies = {}
    def dependency(path):
        path = Path(path).resolve()
        if path.is_relative_to(d.ROOT):
            ref = 'dsl:' + path.relative_to(d.ROOT).as_posix()
        else:
            d.require(path.is_relative_to(repository), 'dependency outside repository')
            ref = 'project:' + path.relative_to(repository).as_posix()
        dependencies[ref] = hashlib.sha256(path.read_bytes()).hexdigest()
        return ref
    for path in [source, example / ir['environment_ref'], d.ROOT / 'process-ir.schema.json',
                 d.ROOT / 'capability-adapter.schema.json', d.ROOT / 'tools/check_design.py',
                 d.ROOT / 'tools/binding_report.py']:
        dependency(path)
    contracts, contract_refs = {}, {}
    for alias, binding in env['bindings'].items():
        if 'contract' in binding:
            path = d.project_file(example, binding['contract'], repository)
            contracts[alias] = d.read_json(path)
            contract_refs[alias] = dependency(path)
    invocations = []
    blockers = set(env['execution_blockers'])
    for alias, binding in env['bindings'].items():
        if binding.get('type') == 'location' and binding.get('calibration_status') != 'calibrated':
            blockers.add('location_pending:' + alias)
    for node in ir['nodes']:
        if node['kind'] != 'invoke': continue
        owner, behavior_id = node['target_ref'], node['behavior_id']
        contract = contracts[owner]
        adapter = d.adapter_for(owner, behavior_id, contracts, env, example, repository)
        if adapter:
            path = d.project_file(example, env['capability_adapters'][owner][behavior_id], repository)
            adapter_ref = dependency(path)
            native_id = adapter['native']['behavior_id']
            blockers.add('capability_adapter_pending:' + owner + '/' + behavior_id)
        else:
            native_id, adapter_ref = behavior_id, None
        native = next(b for b in contract['transport_behaviors'] if b['behavior_id'] == native_id)
        if native['implementation_status'] != 'implemented':
            blockers.add('native_action_pending:' + owner + '/' + native_id)
        rule = env['invocation_adapters'][node['node_id']]
        invocations.append({
            'node_id': node['node_id'], 'instance_id': env['bindings'][owner]['id'],
            'capability': behavior_id, 'native_behavior': native_id,
            'device_spec_id': contract['device_spec_id'], 'definition_version': contract['version'],
            'device_contract_ref': contract_refs[owner], 'capability_adapter_ref': adapter_ref,
            'resolved_arguments': {name: d.resolve_argument(value, env) for name, value in node['arguments'].items()},
            'backend': {'template_ref': contract['runtime_execution_contract'].get('template_ref'),
                        'payload_contract_ref': contract['runtime_execution_contract'].get('payload_contract_ref'),
                        'payload_status': 'not_assembled_requires_calibration' if adapter else 'native_request_bridge_pending'},
            'native_obligations': {'preconditions': native['condition_contract']['preconditions'],
                                   'sustaining_conditions': native['condition_contract']['sustaining_conditions'],
                                   'completion': native['completion_contract']},
            'additional_obligations': None if not adapter else {
                'condition_contract': adapter['condition_contract'], 'completion_contract': adapter['completion_contract'],
                'payload_recipe': adapter['payload_recipe'], 'stop_contract': adapter['stop_contract']},
            'claims': rule['claims'], 'drive_dependency': rule.get('drive_dependency'),
            'request_identity': {'process': 'generated per activation at runtime',
                                 'native': 'positive DINT mapping retained with the same process request'},
            'protocol_recipe': ['wait_gate', 'atomic_resource_grant', 'recheck_snapshot', 'submit_request',
                                'confirm_accept', 'observe_completion', 'confirm_release'],
            'failure_recipe': ['request_controlled_stop', 'confirm_stop_and_handoff_state',
                               'release_only_confirmed_grants', 'quarantine_if_unknown'],
        })
    lock = [{'ref': ref, 'sha256': sha} for ref, sha in sorted(dependencies.items())]
    digest = hashlib.sha256(json.dumps(lock, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {
        'schema_type': 'ProcessBindingReport', 'version': '0.1', 'process_id': ir['process_id'],
        'status': 'reference_design_checked', 'mode': env['mode'], 'executable': False,
        'is_bound_process': False,
        'checks': ['text_and_ir_structure', 'conservative_request_dominance', 'registered_conditions',
                   'nominal_arguments_and_indices', 'adapter_native_version', 'control_inputs_units_and_stop_rule',
                   'matching_drive_scope', 'adapter_payload_recipe_order'],
        'unverified': ['provider freshness and actual state', 'request/subject scope metadata at the native robot boundary',
                       'complete environment/service schema', 'geometric reachability and collisions',
                       'actual payload validation and resource arbitration', 'protocol/physical execution'],
        'node_count': len(ir['nodes']), 'entry': ir['entry'], 'invocations': invocations,
        'controls': env['controls'], 'resources': env['resources'], 'resource_conflicts': env['resource_conflicts'],
        'acceptance': env['acceptance'], 'execution_blockers': sorted(blockers),
        'dependencies': lock, 'dependency_digest': digest,
    }
