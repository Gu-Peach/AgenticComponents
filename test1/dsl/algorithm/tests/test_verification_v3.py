import copy
import json
import os
from pathlib import Path
import sys
import unittest

BASE = Path(__file__).resolve().parents[1]
WORK = Path(os.environ.get('ACVERIFY_WORKSPACE', str(BASE)))
sys.path[:0] = [str(BASE/'src'), str(BASE/'tools'), str(WORK/'.deps')]
from build_standard_answers import Case, RefError, read
from success_projection_v3 import SuccessProjection, check_certificate
from reference_handoff_v3 import suite
from acverify.frontend import load_case, environment
from acverify.model import TransitionModel
from acverify.backends import explore


class VerificationV3Tests(unittest.TestCase):
    def case(self, cid='S04-P01'):
        return Case(WORK/'datasets/ac-path-v1', cid)

    def test_all_old_universal_witness_claims_have_structural_proofs(self):
        old = read(WORK/'experiments/method1-v2/core.json'); count = 0
        for row in old['cases']:
            for q in row['properties']:
                if q['basis'] != 'unique_successful_sequential_goal_projection': continue
                p = SuccessProjection(self.case(row['case_id'])).run()
                self.assertEqual(p['conclusions'][q['property']], q['expected']); count += 1
        self.assertEqual(count, 47)

    def test_certificate_tamper_rejected(self):
        case = self.case(); p = SuccessProjection(case).run()
        p['poststates'][0]['m|M1|region'] = 'C1.entry'
        with self.assertRaises(RefError): check_certificate(case, p)

    def test_changed_inputs_rejected(self):
        case = self.case(); p = SuccessProjection(case).run()
        case.hashes['task'] = 'tampered'
        with self.assertRaises(RefError): check_certificate(case, p)

    def test_unknown_effect_rejected(self):
        case = self.case(); case.actions['load']['model']['phases'][0]['effects'][0]['effect'] = 'teleport_unknown'
        with self.assertRaises(RefError): SuccessProjection(case).run()

    def test_projection_never_asserts_positive_reachability(self):
        p = SuccessProjection(self.case()).run()
        self.assertEqual(p['conclusions'], {'V09': 'HOLDS'})

    def test_erasing_false_gate_does_not_prove_a_witness(self):
        case = self.case(); case.body = ['seq', 'main', ['await', 'impossible', ['condition', 'c1_pick_ready'], ['timeout','1','s']], case.body]
        p = SuccessProjection(case).run()
        self.assertNotIn('REACHABLE', p['conclusions'].values())

    def test_shared_parallel_effects_rejected(self):
        case = self.case(); a = case.nodes['load']
        case.body = ['par', 'parallel', a, a]
        with self.assertRaises(RefError): SuccessProjection(case).run()

    def test_external_events_require_separate_proof(self):
        case = self.case(); case.env['events'] = [{'tick': 1, 'kind': 'set_external'}]
        with self.assertRaises(RefError): SuccessProjection(case).run()

    def test_footprint_union_survives_identical_poststates(self):
        p = SuccessProjection(self.case())
        values = p.unique([({'x': 1}, {'a'}), ({'x': 1}, {'b'})])
        self.assertEqual(values[0][1], {'a', 'b'})

    def test_finite_handoff_and_fault_mutations(self):
        result = suite()
        self.assertTrue(result['complete'])
        self.assertTrue(result['invariants_hold'])
        self.assertTrue(result['all_mutations_detected'])
        self.assertFalse(result['whole_line_truth_complete'])

    def test_parallel_competition_and_faults_close_on_small_model(self):
        d = load_case(WORK/'datasets/ac-path-v1/cases/S04-P01/case.json', WORK)
        load = copy.deepcopy(next(n for n in d['ir']['nodes'] if n['node_id'] == 'load'))
        peer = {**load, 'node_id': 'peer'}
        d['resolved']['peer'] = copy.deepcopy(d['resolved']['load'])
        d['ir'].update(entry='root', conditions={}, nodes=[{'node_id':'root', 'kind':'par', 'children':['load','peer']}, load, peer])
        d['environment']['policies'][load['policy_ref']].update(gate_ticks=3, accept_ticks=3, execute_ticks=30, stop_ticks=3)
        env = environment(d, 'nominal')
        env.update(accept=[1,1], phase=[1,1], stop=[1,1], feedback=[0,0], events=[],
                   max_faults=1, faults=['provider_restart','hold_permission_loss','old_request_feedback',
                                        'duplicate_same_request','missing_stop_confirmation'])
        model = TransitionModel(d, env)
        graph = explore(model, bound=30, state_limit=20000, time_limit=15, mode='full')
        self.assertTrue(graph['report']['finite_model_exhausted'], graph['report'])
        self.assertFalse(graph['bad'])
        self.assertIn('attention_required', graph['terminals'])
        # Check raw states without using the production invariant monitor.
        for state in graph['states']:
            grants = state['world']['grants']
            self.assertLessEqual(len(set(grants.values())), 1)
            for t in state['tasks'].values():
                if t['phase'] == 'attention':
                    self.assertTrue(all(grants.get(r) == t['key'] for r in t['claims']))
            locs = [loc for loc, items in state['world']['occupancy'].items() if 'M1' in items]
            self.assertEqual(len(locs), 1)


if __name__ == '__main__': unittest.main()
