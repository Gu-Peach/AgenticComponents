"""Contract gates remain mandatory when the process has no explicit waits."""
import copy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from audit_device_bindings import audit_scene, read, walk
from declarative_frontend import compile_source, DeclarationError


class ContractLifecycle(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / 'processes/S01/process.py').read_text(encoding='utf-8')
        self.ir = compile_source(self.text)
        self.binding = read(ROOT / 'processes/S01/bindings.json')
        self.batch = read(ROOT / 'processes/S01/batch.json')
        self.interfaces = read(ROOT / 'declarative_dsl/interfaces.json')
        self.specs = {p.stem: read(p) for p in (ROOT / 'asset_contracts/assets').glob('*.json')}

    def audit(self):
        return audit_scene(self.ir, self.binding, self.specs, self.interfaces, self.batch)

    def node(self, id):
        return next(n for n in walk(self.ir) if n.get('id') == id)

    def invalid(self):
        self.assertFalse(self.audit()['declaration_references_valid'])

    def test_no_waits_and_no_fabricated_execution(self):
        self.assertNotIn('wait_for', self.text)
        self.assertNotIn('await', {n.get('kind') for n in walk(self.ir)})
        result = self.audit()
        self.assertTrue(result['declaration_references_valid'], result['errors'])
        self.assertFalse(result['contract_binding_valid'])
        self.assertFalse(result['executable'])
        self.assertEqual({'ACTION_PAYLOAD_ADAPTER_REQUIRED'}, {e['code'] for e in result['errors']})

    def test_new_language_rejects_wait_but_keeps_legacy_parser(self):
        source = 'with process("S01", version="ac-declarative/0.3"):\n    wait_for("wait", fact("ready"), timeout=seconds(30))\n'
        with self.assertRaises(DeclarationError):
            compile_source(source)
        self.assertEqual('await', compile_source(source.replace('/0.3','/0.2'))['body']['kind'])

    def test_seq_and_parallel_have_contract_completion_barriers(self):
        cycle = self.node('line_cycle_003')['children']
        self.assertEqual(['invoke', 'par'], [n['kind'] for n in cycle])
        self.assertEqual('move_by_distance', cycle[0]['behavior'])
        self.assertEqual(2, len(cycle[1]['children']))
        self.assertEqual('all', cycle[1]['join'])
        branches = cycle[1]['children']
        for branch in branches:
            self.assertEqual(['pick_and_place','move_to_pose','transport_to_exit','release_material','stop_conveying'],
                             [n['behavior'] for n in branch['body']['children']])

    def test_automatic_gates_are_imported_from_contract(self):
        result = self.audit()
        gates = result['automatic_obligations']['behaviors']
        self.assertEqual(11, len(gates))
        self.assertEqual(['C1/move_by_distance.completion'], gates[0]['completion'])
        self.assertIn('C1/move_by_distance.motion_authorized', gates[0]['preconditions'])
        self.assertEqual('task-spec.json', result['automatic_obligations']['process']['task_specification'])

    def test_missing_precondition_binding_is_rejected(self):
        del self.binding['condition_bindings']['C1/move_by_distance.motion_authorized']
        self.invalid()

    def test_missing_completion_binding_is_rejected(self):
        del self.binding['condition_bindings']['R1/pick_and_place.completion']
        self.invalid()

    def test_signal_substitution_is_rejected(self):
        self.binding['condition_bindings']['C1/move_by_distance.completion']['signals'] = ['C1/runTag']
        self.invalid()

    def test_missing_physical_signal_binding_is_rejected(self):
        del self.binding['instances']['C1']['signal_bindings']['actual_speed']
        self.invalid()

    def test_finalization_cannot_be_omitted(self):
        del self.binding['process_contract']
        self.invalid()

    def test_deadlines_must_be_positive(self):
        self.binding['process_contract']['execution_timeout_s'] = 0
        self.invalid()

    def test_pending_distance_is_a_blocker_not_a_default(self):
        self.assertIn('CALIBRATION_REQUIRED', {b['code'] for b in self.audit()['blockers']})
        self.binding['calibrations']['C1.pitch_m']['value'] = 1.0
        self.invalid()

    def test_wrong_calibration_unit_is_rejected(self):
        self.binding['calibrations']['C1.pitch_m']['unit'] = 's'
        self.invalid()

    def test_negative_distance_is_rejected(self):
        self.node('line_advance_005')['arguments']['distance_m'] = {'kind':'quantity','args':[{'kind':'literal','value':-1},{'kind':'literal','value':'m'}],'kwargs':{}}
        self.invalid()

    def test_duplicate_identity_is_rejected(self):
        self.binding['identity_registry']['entries']['M01_2'] = self.binding['identity_registry']['entries']['M01_1']
        self.invalid()

    def test_collection_unknown_cannot_be_skipped(self):
        self.binding['collection_bindings']['items_at']['unknown_policy'] = 'empty'
        self.invalid()

    def test_collection_requires_automatic_admission(self):
        del self.binding['collection_bindings']['items_at']['admission']
        self.invalid()

    def test_old_behavior_alias_still_rejected(self):
        self.node('pick_place_A_013')['behavior'] = 'transfer_material'
        self.invalid()

    def test_payload_cannot_redirect_device(self):
        self.binding['command_payloads']['R1.pick_and_place']['instance'] = 'R2'
        self.invalid()

    def test_sibling_variable_is_not_in_scope(self):
        self.node('pick_place_A_013')['payload']['kwargs']['material']['base']['name'] = 'b'
        self.invalid()

    def test_empty_loop_still_validates_its_body(self):
        self.node('line_cycles_002')['count'] = {'kind':'literal','value':0}
        self.node('pick_place_A_013')['payload']['kwargs']['target'] = {'kind':'literal','value':42}
        self.invalid()

    def test_payload_is_not_a_scalar_behavior_argument(self):
        self.assertEqual({}, self.node('pick_place_A_013')['arguments'])
        with self.assertRaises(DeclarationError):
            compile_source(self.text.replace('/0.3','/0.1'))


if __name__ == '__main__':
    unittest.main()
