import copy
import os
from pathlib import Path
import sys
import unittest
import importlib.util
import importlib
from unittest.mock import patch

BASE=Path(__file__).resolve().parents[1]
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE',str(BASE)))
sys.path[:0]=[str(BASE/'src'),str(WORK/'.deps')]
from acverify.state_store import clone_state
from acverify.core import canonical, VerificationError
from acverify.frontend import load_case, environment
from acverify.model import TransitionModel
from acverify.backends import explore, graph_bmc
from acverify.reduction import compact, clock_key
from acverify.diagnostics import trace,replay
from acverify.pipeline import verify


class SolverOptimizationTests(unittest.TestCase):
    def model(self,cid='S04-P01',fast=False,fault=False):
        d=load_case(WORK/'datasets/ac-path-v1/cases'/cid/'case.json',WORK)
        env=environment(d,'nominal');env.update(accept=[1,1],phase=[1,1],stop=[1,1],feedback=[0,0],events=[],faults=[],max_faults=0)
        if fault:
            load=next(n for n in d['ir']['nodes'] if n['node_id']=='load')
            d['ir'].update(entry='load',nodes=[load],conditions={})
            d['environment']['policies'][load['policy_ref']].update(gate_ticks=3,accept_ticks=3,execute_ticks=30,stop_ticks=3)
            env.update(max_faults=1,faults=['provider_restart','hold_permission_loss','duplicate_same_request','old_request_feedback'])
        return TransitionModel(d,env,fast_copy=fast)

    def test_copy_preserves_aliases_cycles_and_isolation(self):
        leaf={'value':[None,True,1,1.25,'x']};raw={'a':leaf,'b':leaf};raw['cycle']=raw
        result=clone_state(raw)
        self.assertIs(result['a'],result['b']);self.assertIs(result,result['cycle'])
        result['a']['value'].append(5);self.assertEqual(len(leaf['value']),5)

    def test_unsupported_value_types_delegate_to_deepcopy(self):
        source={'tuple':({'x':1},),'set':{1,2}}
        result=clone_state(source);self.assertEqual(result,copy.deepcopy(source))
        result['tuple'][0]['x']=3;self.assertEqual(source['tuple'][0]['x'],1)

    def test_full_graph_equivalence_and_replay(self):
        baseline=Path(os.environ.get('ACVERIFY_BASELINE',str(BASE/'baselines/solver-v3')))
        spec=importlib.util.spec_from_file_location('frozen_acverify',baseline/'src/acverify/__init__.py',
                    submodule_search_locations=[str(baseline/'src/acverify')])
        package=importlib.util.module_from_spec(spec);sys.modules['frozen_acverify']=package;spec.loader.exec_module(package)
        old_model=importlib.import_module('frozen_acverify.model').TransitionModel
        old_explore=importlib.import_module('frozen_acverify.backends').explore
        for cid,fault in [('S04-P01',False),('S04-P01-DV04',False),('S03-P02',False),('S04-P01',True)]:
            for mode in ('full','compact','clock'):
                with self.subTest(case=cid,fault=fault,mode=mode):
                    new=self.model(cid,fast=True,fault=fault);old=old_model(new.data,new.profile)
                    a=old_explore(old,bound=512,state_limit=20000,time_limit=15,mode=mode)
                    b=explore(new,bound=512,state_limit=20000,time_limit=15,mode=mode,optimized=True)
                    self.assertTrue(a['report']['finite_model_exhausted'],a['report'])
                    self.assertTrue(b['report']['finite_model_exhausted'],b['report'])
                    self.assertEqual(a['states'],b['states']);self.assertEqual(a['edges'],b['edges'])
                    self.assertEqual(a['report']['properties'],b['report']['properties'])
                    indexes=set(b['bad'].values())|set(b['terminals'].values())
                    if b['goal'] is not None:indexes.add(b['goal'])
                    for index in indexes:self.assertTrue(replay(old,trace(new,b,index))['valid'])

    def test_projection_does_not_mutate_parent(self):
        model=self.model();parent=clone_state(model.initial);before=canonical(parent)
        compact(parent,clone_state);clock_key(parent,clone_state,True)
        children=list(model.successors(parent));self.assertEqual(canonical(parent),before)
        if children:children[0][0]['world']['materials']['M1']['region']='changed'
        self.assertEqual(canonical(parent),before)

    def test_edge_free_storage_keeps_witness_and_refuses_graph_smt(self):
        model=self.model(fast=True);g=explore(model,bound=256,optimized=True,keep_edges=False,mode='clock')
        self.assertEqual(g['edges'],[]);self.assertGreater(g['report']['edges'],0)
        self.assertTrue(replay(model,trace(model,g,g['goal']))['valid'])
        with self.assertRaises(VerificationError):graph_bmc(g,'V10a')

    def test_target_query_does_not_stop_at_unrelated_violation(self):
        model=self.model('S04-P01-DV04',fast=True)
        g=explore(model,bound=256,search='witness',optimized=True,target_properties=['V10a'])
        self.assertIn('V09',g['bad']);self.assertFalse(g['report']['early_witness'])
        self.assertTrue(g['report']['finite_model_exhausted'])

    def test_no_safety_claim_from_early_witness(self):
        model=self.model(fast=True)
        g=explore(model,bound=256,search='witness',optimized=True,target_properties=['V10a'])
        self.assertTrue(g['report']['early_witness'])
        self.assertEqual(g['report']['properties']['V09']['verdict'],'UNKNOWN')

    def test_portfolio_shares_budget_and_replays_evidence(self):
        r,w,_=verify(WORK/'datasets/ac-path-v1/cases/S04-P01/case.json',WORK,
                      bound=3000,seconds=.5,reduction='auto',optimization='portfolio')
        self.assertEqual(len(r['search_phases']),2)
        self.assertEqual(r['search_budget_seconds'],.5)
        self.assertTrue(all(x['valid'] for x in r['replays'].values()))
        self.assertNotIn('PROVED_ON_FINITE_MODEL',[p['verdict'] for p in r['properties'].values()] if not r['finite_model_exhausted'] else [])


if __name__=='__main__':unittest.main()
