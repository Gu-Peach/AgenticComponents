"""T0 design and negative bindings; no physics success assertions."""
import copy
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import check_design as d
from binding_report import build_report

EXAMPLE = d.ROOT / 'examples/t0-two-robot'
REPOSITORY = Path(os.environ.get('DSL_REPOSITORY_ROOT', str(d.ROOT.parents[1]))).resolve()

class T0Tests(unittest.TestCase):
    def setUp(self):
        self.ir = d.read_json(EXAMPLE / 'process.ir.json')
        self.env = d.read_json(EXAMPLE / 'cell.design.json')

    def check(self, env=None, ir=None):
        original = d.read_json
        with patch.object(d, 'read_json', side_effect=lambda path: env if env is not None and Path(path).name == 'cell.design.json' else original(path)):
            return d.check_environment(ir or self.ir, EXAMPLE, REPOSITORY)

    def test_t0_source_ir_map_and_design(self):
        ir, mapping = d.lower(d.read_source(EXAMPLE / 'process.acp'), 'examples/t0-two-robot/process.acp')
        self.assertEqual(ir, self.ir)
        self.assertEqual(mapping, d.read_json(EXAMPLE / 'process.map.json'))
        self.assertEqual(len(ir['nodes']), 9)
        self.assertEqual(self.check()['mode'], 'design_only')

    def test_report_is_current_and_not_executable(self):
        self.check()
        report = build_report(self.ir, self.env, EXAMPLE / 'process.acp', EXAMPLE, REPOSITORY)
        self.assertEqual(report, d.read_json(EXAMPLE / 'process.binding.json'))
        self.assertFalse(report['executable'])
        self.assertFalse(report['is_bound_process'])
        self.assertEqual(len(report['invocations']), 4)

    def test_material_is_not_a_location(self):
        ir = copy.deepcopy(self.ir)
        next(n for n in ir['nodes'] if n['node_id'] == 'load')['arguments']['source'] = {'kind': 'binding', 'binding_ref': 'material'}
        with self.assertRaises(d.DesignError): self.check(ir=ir)

    def test_no_fake_slot_or_self_transfer(self):
        env = copy.deepcopy(self.env)
        env['bindings']['source_station']['id'] = env['bindings']['c1_entry']['id']
        with self.assertRaises(d.DesignError): self.check(env=env)

    def test_control_output_unit_range_and_stop_rejected(self):
        variants = []
        env = copy.deepcopy(self.env); env['controls']['c1_drive']['enter']['actual_speed'] = {'kind': 'quantity', 'value': 0.2, 'unit': 'm/s'}; variants.append(env)
        env = copy.deepcopy(self.env); env['controls']['c1_drive']['enter']['speedTag']['unit'] = 'mm/s'; variants.append(env)
        env = copy.deepcopy(self.env); env['controls']['c1_drive']['enter']['speedTag']['value'] = 3; variants.append(env)
        env = copy.deepcopy(self.env); env['controls']['c1_drive']['exit']['runTag']['value'] = True; variants.append(env)
        for env in variants:
            with self.subTest(control=env['controls']['c1_drive']), self.assertRaises(d.DesignError): self.check(env=env)

    def test_wrong_drive_scope_rejected(self):
        ir = copy.deepcopy(self.ir)
        next(n for n in ir['nodes'] if n['node_id'] == 'feed_1')['control_ref'] = 'c2_drive'
        with self.assertRaises(d.DesignError): self.check(ir=ir)

    def test_unknown_region_and_resource_rejected(self):
        env = copy.deepcopy(self.env); env['bindings']['c1_entry']['geometry_ref'] = 'not_a_region'
        with self.assertRaises(d.DesignError): self.check(env=env)
        env = copy.deepcopy(self.env); env['invocation_adapters']['load']['claims'].append('missing_resource')
        with self.assertRaises(d.DesignError): self.check(env=env)

    def test_native_contract_mismatch_and_bad_recipe(self):
        original = d.read_json
        for change in ('version', 'recipe'):
            adapter = original(EXAMPLE / 'transfer.adapter.json')
            if change == 'version': adapter['native']['definition_version'] = 'stale'
            else: adapter['payload_recipe']['steps'] = list(reversed(adapter['payload_recipe']['steps']))
            with patch.object(d, 'read_json', side_effect=lambda path: adapter if Path(path).name == 'transfer.adapter.json' else original(path)):
                with self.subTest(change=change), self.assertRaises(d.DesignError): self.check()

    def test_future_request_and_parallel_sibling_rejected(self):
        def program(body):
            return f'(process "0.1" p (environment "cell.design.json") (profile fixed_60hz) (conditions) (body {body}))'
        call = '(invoke later c1 transport_to_exit (args (subject_id 1)) (policy normal))'
        wait = '(await first (is (observation c1 "subject_at_exit" (request later)) true) (timeout 1 s))'
        for body in [f'(seq root {wait} {call})', f'(par root {call} {wait})']:
            with self.subTest(body=body), self.assertRaises(d.DesignError): d.lower(program(body))

    def test_nominal_reference_cannot_be_replaced_by_string(self):
        ir = copy.deepcopy(self.ir)
        next(n for n in ir['nodes'] if n['node_id'] == 'bridge')['arguments']['material'] = {'kind': 'string', 'value': 'M'}
        with self.assertRaises(d.DesignError): self.check(ir=ir)

if __name__ == '__main__': unittest.main()
