"""Mutation tests start from the complete delivered nine-asset catalog."""
import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('validate_contracts', ROOT / 'tools/validate_contracts.py')
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class ContractValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_catalog = VALIDATOR.read_json(ROOT / 'catalog.json')
        cls.original_protocols = VALIDATOR.read_json(ROOT / 'shared/protocols.json')
        cls.schema = VALIDATOR.read_json(ROOT / 'schema/asset-contract.schema.json')
        cls.original_assets = {item['id']: VALIDATOR.read_json(ROOT / item['path'])
                               for item in cls.original_catalog['assets']}

    def setUp(self):
        self.catalog = copy.deepcopy(self.original_catalog)
        self.protocols = copy.deepcopy(self.original_protocols)
        self.assets = copy.deepcopy(self.original_assets)

    def errors(self):
        return VALIDATOR.validate_documents(self.catalog, self.protocols, self.assets, self.schema)

    def assert_rejected(self, fragment):
        errors = self.errors()
        self.assertTrue(errors, 'Invalid mutation was accepted')
        self.assertTrue(any(fragment in error for error in errors), '\n'.join(errors))

    def active(self):
        for asset in self.assets.values():
            for behavior in asset['behaviors']:
                if behavior['kind'] == 'action' and len(behavior['command_bindings']) > 1:
                    return asset, behavior
        self.fail('Catalog requires a callable action with payload')

    def parameterized_fact(self):
        for asset in self.assets.values():
            for behavior in asset['behaviors']:
                for condition in behavior['preconditions'] + behavior['sustaining_conditions'] + behavior['completion']['checks']:
                    left = condition['left']
                    if left.get('bindings'):
                        group = asset['observations'] if left['source'] == 'observation' else asset['authorizations']
                        fact = next(f for f in group if f['id'] == left['ref'])
                        return asset, behavior, condition, fact
        self.fail('Catalog requires parameterized business evidence')

    def test_complete_catalog_is_valid(self):
        self.assertEqual(9, len(self.assets))
        self.assertEqual([], self.errors())
        self.assertEqual([], VALIDATOR.validate_bundle(ROOT))

    def test_unknown_signal_is_rejected(self):
        _, behavior = self.active()
        behavior['preconditions'][0]['left'] = {'source': 'signal', 'ref': 'not_a_port'}
        self.assert_rejected('unknown signal reference')

    def test_output_cannot_receive_command(self):
        _, behavior = self.active()
        behavior['command_bindings'].append({'signal': 'done', 'value': {'source': 'literal', 'value': True}})
        self.assert_rejected('must be an input port')

    def test_command_parameter_type_mismatch(self):
        asset, behavior = self.active()
        asset['parameters'].append({'id': 'wrong_type', 'type': 'boolean', 'unit': '1', 'description': 'mutation'})
        command = next(c for c in behavior['command_bindings'] if c['signal'] != 'command_code')
        port = next(p for p in asset['signal_ports'] if p['id'] == command['signal'])
        asset['parameters'][-1]['type'] = 'string' if port['type'] == 'boolean' else 'boolean'
        command['value'] = {'source': 'parameter', 'ref': 'wrong_type'}
        self.assert_rejected('type mismatch')

    def test_condition_unit_mismatch(self):
        asset, behavior = self.active()
        asset['parameters'].extend([
            {'id': 'length_mutation', 'type': 'number', 'unit': 'm', 'description': 'mutation'},
            {'id': 'time_mutation', 'type': 'number', 'unit': 's', 'description': 'mutation'}])
        behavior['preconditions'].append({'id': 'unit_mutation', 'left': {'source': 'parameter', 'ref': 'length_mutation'},
                                          'operator': 'le', 'right': {'source': 'parameter', 'ref': 'time_mutation'}})
        self.assert_rejected('unit mismatch')

    def test_passive_asset_cannot_be_invocable(self):
        asset = next(a for a in self.assets.values() if a['category'] == 'passive')
        asset['behaviors'][0]['invocable'] = True
        self.assert_rejected('invocable must agree')

    def test_passive_asset_cannot_have_input_ports(self):
        asset = next(a for a in self.assets.values() if a['category'] == 'passive')
        asset['signal_ports'].append({'id': 'move_me', 'type': 'boolean', 'unit': '1', 'direction': 'input',
                                     'retention': 'state', 'description': 'mutation', 'writer': 'controller'})
        self.assert_rejected('passive asset cannot expose')

    def test_missing_fact_binding_is_rejected(self):
        _, _, condition, _ = self.parameterized_fact()
        condition['left'].pop('bindings')
        self.assert_rejected('fact bindings must exactly match')

    def test_unknown_bound_argument_is_rejected(self):
        _, _, condition, _ = self.parameterized_fact()
        key = next(iter(condition['left']['bindings']))
        condition['left']['bindings'][key] = 'missing_argument'
        self.assert_rejected('unknown argument')

    def test_fact_argument_nominal_type_mismatch(self):
        _, behavior, condition, fact = self.parameterized_fact()
        key, arg = next(iter(condition['left']['bindings'].items()))
        descriptor = next(a for a in behavior['arguments'] if a['id'] == arg)
        fact['argument_types'][key] = 'location_ref' if descriptor['type'] != 'location_ref' else 'material_ref'
        self.assert_rejected('fact argument')

    def test_fact_signature_names_must_match(self):
        _, _, _, fact = self.parameterized_fact()
        fact['argument_types']['extra'] = 'material_ref'
        self.assert_rejected('argument names and types differ')

    def test_unknown_provider_is_rejected(self):
        _, _, _, fact = self.parameterized_fact()
        fact['provider'] = 'guess_from_animation'
        self.assert_rejected('guess_from_animation')

    def test_unknown_condition_source_is_rejected(self):
        _, behavior = self.active()
        behavior['preconditions'][0]['left']['source'] = 'python_eval'
        self.assert_rejected('python_eval')

    def test_unknown_feature_is_rejected(self):
        _, behavior = self.active()
        behavior['requires_features'].append('unregistered_feature')
        self.assert_rejected('unknown feature')

    def test_duplicate_command_code_is_rejected(self):
        asset, behavior = self.active()
        other = copy.deepcopy(behavior)
        other['id'] += '_duplicate'
        asset['behaviors'].append(other)
        self.assert_rejected('duplicate command_code')

    def test_boolean_is_not_integer_command(self):
        _, behavior = self.active()
        behavior['command_bindings'][0]['value'] = {'source': 'literal', 'value': True}
        self.assert_rejected('positive literal integer')

    def test_unused_argument_is_rejected(self):
        _, behavior = self.active()
        behavior['arguments'].append({'id': 'forgotten_material', 'type': 'material_ref', 'unit': '1', 'description': 'mutation'})
        self.assert_rejected('unused by commands or fact bindings')

    def test_condition_only_argument_is_not_a_payload(self):
        _, behavior = self.active()
        behavior['arguments'].append({'id': 'forgotten_material', 'type': 'material_ref', 'unit': '1', 'description': 'mutation'})
        behavior['preconditions'].append({'id': 'check_only', 'left': {'source': 'argument', 'ref': 'forgotten_material'},
                                          'operator': 'eq', 'right': {'source': 'literal', 'value': 'M1'}})
        self.assert_rejected('unused by commands or fact bindings')

    def test_default_must_have_declared_type(self):
        asset, _ = self.active()
        asset['parameters'].append({'id': 'invalid_default', 'type': 'number', 'unit': 'm', 'description': 'mutation', 'default': True})
        self.assert_rejected('does not match number')

    def test_default_must_be_within_range(self):
        asset, _ = self.active()
        asset['parameters'].append({'id': 'invalid_default', 'type': 'number', 'unit': 'm', 'description': 'mutation',
                                    'minimum': 0, 'maximum': 1, 'default': 2})
        self.assert_rejected('outside its range')

    def test_no_false_implementation_claim(self):
        asset, _ = self.active()
        asset['implementation_status'] = 'implemented'
        self.assert_rejected('contract_only')

    def test_done_alone_is_not_business_completion(self):
        _, behavior = self.active()
        behavior['completion']['checks'] = [{'id': 'done_only', 'left': {'source': 'signal', 'ref': 'done'},
                                             'operator': 'eq', 'right': {'source': 'literal', 'value': True}}]
        self.assert_rejected('business evidence beyond protocol')

    def test_continuous_is_scope_not_one_shot(self):
        behavior = next(b for a in self.assets.values() for b in a['behaviors'] if b['kind'] == 'continuous')
        behavior['completion']['mode'] = 'evidence'
        self.assert_rejected('continuous behavior requires scope')

    def test_continuous_cannot_finish_from_done(self):
        behavior = next(b for a in self.assets.values() for b in a['behaviors'] if b['kind'] == 'continuous')
        behavior['completion']['checks'].append({'id': 'bad_done', 'left': {'source': 'signal', 'ref': 'done'},
                                                 'operator': 'eq', 'right': {'source': 'literal', 'value': True}})
        self.assert_rejected('continuous scope cannot finish')

    def test_duplicate_asset_id_is_rejected(self):
        self.catalog['assets'][-1] = copy.deepcopy(self.catalog['assets'][0])
        self.assert_rejected('duplicate ID')

    def test_unknown_asset_field_is_rejected(self):
        asset, _ = self.active()
        asset['execute_python'] = 'ignored payload'
        self.assert_rejected('Additional properties')

    def test_disabled_configurable_mode_has_no_inputs(self):
        asset = next(a for a in self.assets.values() if a.get('activation_rules'))
        asset['activation_rules'] = []
        self.assert_rejected('passive feature configuration retains input ports')

    def test_disabled_mode_removes_payload_inputs(self):
        asset = next(a for a in self.assets.values() if a.get('activation_rules'))
        asset['activation_rules'][0]['signals'] = []
        self.assert_rejected('passive feature configuration retains input ports')

    def test_configuration_constraint_unknown_parameter(self):
        asset, _ = self.active()
        asset.setdefault('configuration_constraints', []).append({'kind': 'parameter_le', 'left': 'unknown', 'right': 'missing'})
        self.assert_rejected('configuration constraint references unknown parameter')

    def test_configuration_default_respects_feature_requirement(self):
        asset = next(a for a in self.assets.values() if any(c['kind'] == 'at_least_one_feature' for c in a.get('configuration_constraints', [])))
        for feature in asset['features']:
            feature['default'] = False
        self.assert_rejected('default configuration violates at_least_one_feature')

    def test_configuration_default_respects_parameter_order(self):
        asset = next(a for a in self.assets.values() if any(c['kind'] == 'parameter_le' for c in a.get('configuration_constraints', [])))
        constraint = next(c for c in asset['configuration_constraints'] if c['kind'] == 'parameter_le')
        lhs = next(p for p in asset['parameters'] if p['id'] == constraint['left'])
        rhs = next(p for p in asset['parameters'] if p['id'] == constraint['right'])
        lhs['default'] = rhs['default'] + 1
        self.assert_rejected('default configuration violates parameter_le')

    def test_spatial_interface_feature_reference(self):
        asset, _ = self.active()
        asset['spatial_interfaces'][0]['requires_features'] = ['unknown_feature']
        self.assert_rejected('spatial interface references unknown feature')

    def test_unknown_protocol_runtime_context(self):
        protocol = next(p for p in self.protocols['protocols'] if p['id'] == 'request_v1')
        protocol['runtime_bindings'][0]['value']['ref'] = 'unknown_context'
        self.assert_rejected('declared context field')

    def test_protocol_error_code_has_integer_type(self):
        protocol = next(p for p in self.protocols['protocols'] if p['id'] == 'request_v1')
        next(p for p in protocol['signal_ports'] if p['id'] == 'error_code')['type'] = 'boolean'
        self.assert_rejected('error_code must have type integer')

    def test_protocol_context_defaults_are_checked(self):
        protocol = next(p for p in self.protocols['protocols'] if p['id'] == 'request_v1')
        next(p for p in protocol['runtime_control_context'] if p['id'] == 'controller_enable')['default'] = 1
        self.assert_rejected('does not match boolean')

    def test_catalog_path_cannot_leave_bundle(self):
        self.catalog['assets'][0]['path'] = '../secret.json'
        self.assert_rejected('asset path must be')


if __name__ == '__main__':
    unittest.main()
