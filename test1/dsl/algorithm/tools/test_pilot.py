"""Pilot regression, negative inputs and trace checks; no native runtime claims."""
import copy
from dataclasses import replace
import os
from pathlib import Path
import unittest
from pilot_frontend import load_case, InputError, read
from pilot_model import Model
from pilot_verify import explore, replay, run_case, verify_lock

HERE=Path(__file__).resolve().parents[1]
DATA=HERE/'datasets/ac-path-v1'
DSL=Path(os.environ.get('AC_PILOT_DSL_ROOT',str(HERE.parent)))


class PilotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results={}; cls.traces={}
        for cid in read(DATA/'manifest.json')['cases']:
            if read(DATA/'cases'/cid/'case.json').get('profile_scope')!='s04-pilot-timed-microsteps/0.1': continue
            result,traces=run_case(DATA,cid,DSL)
            cls.results[cid]=result; cls.traces[cid]=traces

    def profile(self,cid='S04-P01',name='nominal'):
        return next(p for p in self.results[cid]['profiles'] if p['profile']==name)

    def test_three_static_defects(self):
        for suffix,expected in [('DS01','INVALID_SYNTAX'),('DS02','INVALID_TYPE'),('DS03','UNKNOWN_CAPABILITY')]:
            self.assertEqual(self.results['S04-P01-'+suffix]['frontend'],expected)

    def test_parent_completes_without_violation(self):
        for name in ('nominal','delayed'):
            r=self.profile(name=name)
            self.assertTrue(r['closed_pilot_exhausted'])
            self.assertEqual(r['properties']['V10a']['verdict'],'GOAL_REACHABLE_IN_PILOT')
            self.assertFalse(any(p['verdict']=='VIOLATED_IN_PILOT' for p in r['properties'].values()))

    def test_order_defect_stalls_before_exit(self):
        r=self.profile('S04-P01-DV01')
        self.assertFalse(r['physical_goal_seen'])
        end=self.traces['S04-P01-DV01']['nominal']['terminal_failed']['steps'][-1]['state']
        self.assertEqual((end['region'],end['reason']),('C1.entry','gate_timeout:bridge'))

    def test_wrong_request_does_not_reuse_old_arrival(self):
        r=self.profile('S04-P01-DV02')
        self.assertTrue(r['physical_goal_seen'])
        self.assertEqual(r['properties']['V10a']['verdict'],'GOAL_UNREACHABLE_ON_CLOSED_PILOT')
        end=self.traces['S04-P01-DV02']['nominal']['terminal_failed']['steps'][-1]['state']
        self.assertEqual(end['reason'],'await_timeout:verify')

    def test_removed_redundant_check_is_protected(self):
        r=self.profile('S04-P01-DV03')
        self.assertEqual(r['properties']['V10a']['verdict'],'GOAL_REACHABLE_IN_PILOT')
        self.assertEqual(r['properties']['V09']['verdict'],'PROVED_ON_CLOSED_PILOT')

    def test_independent_goal_detects_false_success(self):
        r=self.profile('S04-P01-DV04')
        self.assertEqual(r['properties']['V09']['verdict'],'VIOLATED_IN_PILOT')
        end=self.traces['S04-P01-DV04']['nominal']['V09']['steps'][-1]['state']
        self.assertEqual((end['terminal'],end['region']),('succeeded','C2.entry'))

    def test_physical_stop_without_evidence_keeps_writer(self):
        r=self.profile(name='stop_unknown_c1')
        self.assertEqual(r['properties']['V08']['verdict'],'PROVED_ON_CLOSED_PILOT')
        end=self.traces['S04-P01']['stop_unknown_c1']['terminal_attention_required']['steps'][-1]['state']
        self.assertEqual(end['drives'][0],'stopped')
        self.assertTrue(end['attention'])
        self.assertIn(('C1.writer','C1.drive'),[tuple(x) for x in end['grants']])

    def test_tampered_trace_rejected(self):
        inputs=load_case(DATA,'S04-P01',DSL); model=Model(inputs,inputs['queries']['profiles'][0])
        trace=copy.deepcopy(self.traces['S04-P01']['nominal']['goal'])
        trace['steps'][0]['state']['region']='C2.exit'
        with self.assertRaisesRegex(InputError,'illegal transition'): replay(model,trace)

    def test_small_bound_not_global_proof(self):
        inputs=load_case(DATA,'S04-P01',DSL); inputs['queries']['bound_ticks']=3
        result,_=explore(inputs,inputs['queries']['profiles'][0])
        self.assertFalse(result['closed_pilot_exhausted'])
        self.assertEqual(result['properties']['V10a']['verdict'],'UNKNOWN')
        self.assertEqual(result['properties']['V09']['verdict'],'NO_VIOLATION_WITHIN_BOUND')

    def test_resource_limit_not_proof(self):
        inputs=load_case(DATA,'S04-P01',DSL); inputs['queries']['state_budget']=5
        result,_=explore(inputs,inputs['queries']['profiles'][0])
        self.assertTrue(result['resource_limit'])
        self.assertEqual(result['properties']['V09']['verdict'],'UNKNOWN')

    def test_resource_invariant_checks_distinct_owners(self):
        inputs=load_case(DATA,'S04-P01',DSL); model=Model(inputs,inputs['queries']['profiles'][0])
        bad=replace(model.initial,grants=(('C1.writer','feed'),('C1.zone','bridge')))
        self.assertIn('V04',model.violations(bad))

    def test_unsupported_timeout_range_rejected(self):
        inputs=load_case(DATA,'S04-P01',DSL); inputs['environment']['policies']['pilot']['execute_ticks']=1
        with self.assertRaisesRegex(InputError,'execution timeout'): Model(inputs,inputs['queries']['profiles'][0])

    def test_independent_task_identical_for_all_cases(self):
        roots=[]
        for cid in self.results:
            desc=read(DATA/'cases'/cid/'case.json')
            roots.append((DATA/'cases'/cid/desc['inputs']['task']).resolve())
            verify_lock(DATA,cid,DSL)
        self.assertEqual(len(set(roots)),1)


if __name__=='__main__': unittest.main()
