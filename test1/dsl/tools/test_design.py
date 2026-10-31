"""Negative fixtures check that design acceptance does not become permissive."""
import copy
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import check_design as d

EXAMPLE = d.ROOT / 'examples' / 'pick-place'
PROJECT = Path(os.environ.get('DSL_PROJECT_ROOT', str(d.ROOT.parent))).resolve()

def program(body, conditions=''):
    return f'(process "0.1" demo (environment "cell.design.json") (profile fixed_60hz) (conditions {conditions}) (body {body}))'

class DesignTests(unittest.TestCase):
    def test_complete_example_and_golden(self):
        ir, mapping = d.lower(d.read_source(EXAMPLE / 'process.acp'), 'examples/pick-place/process.acp')
        self.assertEqual(ir, d.read_json(EXAMPLE / 'process.ir.json'))
        self.assertEqual(mapping, d.read_json(EXAMPLE / 'process.map.json'))
        self.assertEqual(d.check_environment(ir, EXAMPLE, PROJECT)['mode'], 'design_only')

    def test_combinations(self):
        body = '''(seq main
          (par parallel (delay left 0 s) (repeat repetitions 0 (delay right 1 ms)))
          (branch choose exclusive (timeout 1 s)
            (case (all (condition ok) (not (is (parameter conveyor "allow_reverse") true)))
              (await wait_for (any (condition ok) (condition ok)) (timeout 1 s)))
            (else (fail rejected "NOT_READY"))))'''
        ir, _ = d.lower(program(body, '(condition ok (is (observation conveyor "surface_stopped") true))'))
        self.assertEqual({n['kind'] for n in ir['nodes']}, {'seq', 'par', 'delay', 'repeat', 'branch', 'await', 'fail'})

    def test_source_span_unicode(self):
        text = '; 中文\n' + program('(fail end_node "有;分号")')
        _, mapping = d.lower(text)
        span = mapping['end_node']
        self.assertEqual(text.encode()[span['start_byte']:span['end_byte']].decode(), '(fail end_node "有;分号")')

    def test_source_span_bom_crlf(self):
        text = '\ufeff; 中文\r\n' + program('(delay n 0 s)')
        _, mapping = d.lower(text)
        span = mapping['n']
        self.assertEqual(span['line'], 2)
        self.assertEqual(text.encode()[span['start_byte']:span['end_byte']].decode(), '(delay n 0 s)')

    def test_ir_nonfinite(self):
        ir, _ = d.lower(program('(await n (is (parameter conveyor "speed") 1.0) (timeout 1 s))'))
        ir['nodes'][0]['condition']['equals']['value'] = float('inf')
        with self.assertRaises(d.DesignError): d.validate_ir(ir)

    def test_lexical_rejections(self):
        bad = ['(delay n NaN s)', '(delay n 01 s)', '(delay n +1 s)', '(delay n 1e999 s)',
               '(delay n 1e-999 s)', '(repeat n 1.0 (delay child 0 s))', '(fail n "\\uD800")',
               '(fail n "a\nb")', '(delay seq 1 s)']
        for body in bad:
            with self.subTest(body=body), self.assertRaises(d.DesignError): d.lower(program(body))

    def test_structure_rejections(self):
        bad = ['(par n (delay a 1 s))', '(seq n)', '(repeat n -1 (delay a 0 s))',
               '(repeat n 10001 (delay a 0 s))', '(delay n -1 s)', '(delay n 86401 s)',
               '(await n (all) (timeout 1 s))', '(await n (not (condition c)) (timeout 0 s))',
               '(seq n (delay a 0 s) (delay a 0 s))', '(spawn-loop n 0)',
               '(invoke n robot pick_and_place (args (subject_id 1) (subject_id 2)) (policy normal))',
               '(branch n ordered (timeout 1 s) (case (condition c) (delay a 1 s)))']
        for body in bad:
            with self.subTest(body=body), self.assertRaises(d.DesignError): d.lower(program(body))

    def test_trailing_and_version(self):
        text = program('(delay n 0 s)')
        for bad in [text + ' garbage', text[:-1], text.replace('"0.1"', '"9.0"')]:
            with self.subTest(source=bad), self.assertRaises(d.DesignError): d.lower(bad)

    def test_conditions_missing_cyclic_and_request(self):
        for text in [program('(await n (condition absent) (timeout 1 s))'),
                     program('(delay n 0 s)', '(condition a (condition b)) (condition b (condition a))'),
                     program('(await n (is (observation conveyor "subject_at_exit" (request missing)) true) (timeout 1 s))')]:
            with self.subTest(source=text), self.assertRaises(d.DesignError): d.lower(text)

    def test_ir_unknown_fields_and_tree(self):
        ir, _ = d.lower(program('(seq main (delay a 0 s) (delay b 0 s))'))
        mutations = []
        extra = copy.deepcopy(ir); extra['nodes'][0]['chidlren'] = []; mutations.append(extra)
        shared = copy.deepcopy(ir); shared['nodes'][0]['children'] = ['a', 'a']; mutations.append(shared)
        missing = copy.deepcopy(ir); missing['nodes'][0]['children'] = ['absent']; mutations.append(missing)
        cycle = copy.deepcopy(ir); cycle['nodes'][0]['children'] = ['main']; mutations.append(cycle)
        orphan = copy.deepcopy(ir); orphan['nodes'][0]['children'] = ['a']; mutations.append(orphan)
        for value in mutations:
            with self.subTest(ir=value), self.assertRaises(d.DesignError): d.validate_ir(value)

    def test_contract_binding_rejections(self):
        ir = d.read_json(EXAMPLE / 'process.ir.json')
        mutations = []
        for action in ['wrong_type', 'wrong_argument', 'missing_argument', 'unknown_behavior', 'wrong_identity', 'unknown_fact']:
            changed = copy.deepcopy(ir)
            invoke = next(n for n in changed['nodes'] if n['node_id'] == 'transport')
            if action == 'wrong_type': invoke['arguments']['subject_id'] = {'kind': 'string', 'value': 'workpiece_1'}
            if action == 'wrong_argument': invoke['arguments']['material_id'] = invoke['arguments'].pop('subject_id')
            if action == 'missing_argument': invoke['arguments'] = {}
            if action == 'unknown_behavior': invoke['behavior_id'] = 'teleport'
            if action == 'wrong_identity': invoke['arguments']['subject_id']['binding_ref'] = 'target'
            if action == 'unknown_fact': changed['conditions']['at_exit']['read']['key'] = 'invented'
            mutations.append((action, changed))
        for name, value in mutations:
            with self.subTest(case=name), self.assertRaises(d.DesignError): d.check_environment(value, EXAMPLE, PROJECT)

    def test_registry_duplicate_index(self):
        env = d.read_json(EXAMPLE / 'cell.design.json')
        env['registries']['subjects']['entries']['second'] = 1
        original = d.read_json
        def read(path):
            return env if Path(path).name == 'cell.design.json' else original(path)
        with patch.object(d, 'read_json', side_effect=read), self.assertRaises(d.DesignError):
            d.check_environment(original(EXAMPLE / 'process.ir.json'), EXAMPLE, PROJECT)

if __name__ == '__main__':
    unittest.main()
