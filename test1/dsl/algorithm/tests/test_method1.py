"""Hand-specified semantic boundaries and differential checks, not oracle fitting."""
import copy
import os
from pathlib import Path
import sys
import unittest

HERE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(HERE/'src'))
WORKSPACE=Path(os.environ.get('ACVERIFY_WORKSPACE',str(HERE)))
sys.path.insert(0,str(WORKSPACE/'.deps'))
from acverify.core import VerificationError, ticks, activation, all3, any3
from acverify.frontend import load_case, environment
from acverify.model import TransitionModel
from acverify.backends import explore, graph_bmc
from acverify.diagnostics import trace, replay
from acverify.properties import invariant_violations
from acverify.pipeline import check

DATA=WORKSPACE/'datasets/ac-path-v1'


def data(cid='S04-P01'):
    return load_case(DATA/'cases'/cid/'case.json',WORKSPACE)


def timing(d,phase=(1,1)):
    env=environment(d,'nominal');env.update(accept=[1,1],phase=list(phase),stop=[1,1],feedback=[0,0],events=[],faults=[],max_faults=0)
    return env


def fixture(nodes,entry='root',conditions=None,observations=None,external=None):
    d=data();d['ir']={**d['ir'],'entry':entry,'nodes':nodes,'conditions':conditions or {}}
    d['environment']['observation_definitions']=observations or {}
    d['initial']['external']=external or {}
    d['task']['goal']={'op':'all','args':[{'op':'no_grants'},{'op':'no_active_requests'}]}
    d['source_map']={n['node_id']:{'file':'handwritten-fixture.acp','line':i+1} for i,n in enumerate(nodes)}
    return d


class MethodOneTests(unittest.TestCase):
    def test_static_errors_do_not_enter_solver(self):
        for suffix in ('DS01','DS02','DS03'):
            result=check(DATA/'cases'/('S04-P01-'+suffix)/'case.json',WORKSPACE)
            self.assertEqual(result['status'],'INVALID_INPUT')

    def test_three_valued_conditions(self):
        self.assertIsNone(all3([True,None]));self.assertFalse(all3([False,None]))
        self.assertTrue(any3([True,None]));self.assertIsNone(any3([False,None]))
        self.assertIsNone(all3(['false']));self.assertIsNone(any3([1]))

    def test_duration_exact_ceiling(self):
        self.assertEqual(ticks({'value':'1','unit':'ms'}),1)
        self.assertEqual(ticks({'value':'0.05','unit':'s'}),3)

    def test_delay_zero_still_uses_a_tick(self):
        d=fixture([{'node_id':'root','kind':'delay','duration':{'value':'0','unit':'s'}}])
        g=explore(TransitionModel(d,timing(d)),bound=10)
        self.assertEqual(g['states'][g['goal']]['tick'],1)

    def test_repeat_has_distinct_activation_ids(self):
        d=fixture([{'node_id':'root','kind':'repeat','count':2,'child':'wait'},
                   {'node_id':'wait','kind':'delay','duration':{'value':'0','unit':'s'}}])
        g=explore(TransitionModel(d,timing(d)),bound=20)
        terminal=g['states'][g['goal']]
        self.assertIn('wait@0',terminal['tasks']);self.assertIn('wait@1',terminal['tasks'])

    def test_parallel_failure_cancels_sibling(self):
        d=fixture([{'node_id':'root','kind':'par','children':['wait','bad']},
          {'node_id':'wait','kind':'delay','duration':{'value':'10','unit':'s'}},
          {'node_id':'bad','kind':'fail','code':'TEST_FAILURE'}])
        g=explore(TransitionModel(d,timing(d)),bound=20)
        terminal=g['states'][g['terminals']['failed']]
        self.assertEqual(terminal['tasks']['wait@']['phase'],'cancelled')

    def branch_data(self,mode,unknown=False):
        cond=lambda name:{'kind':'is','read':{'source':'observation','owner_ref':'world','key':name},'equals':{'kind':'boolean','value':True}}
        return fixture([{'node_id':'root','kind':'branch','mode':mode,'timeout':{'value':'50','unit':'ms'},
                         'cases':[{'condition':cond('a'),'child':'a'},{'condition':cond('b'),'child':'b'}],'otherwise':'other'},
                        *[{'node_id':n,'kind':'delay','duration':{'value':'0','unit':'s'}} for n in ('a','b','other')]],
                       observations={n:{'op':'external','key':n} for n in ('a','b')},
                       external={'a':{'value':True,'valid':not unknown},'b':{'value':True,'valid':True}})

    def test_exclusive_conflict(self):
        d=self.branch_data('exclusive');g=explore(TransitionModel(d,timing(d)),bound=20)
        end=g['states'][g['terminals']['failed']]
        self.assertIn('branch_conflict',end['reason']);self.assertNotIn('a@',end['tasks'])

    def test_ordered_unknown_blocks_later_true_branch(self):
        d=self.branch_data('ordered',True);g=explore(TransitionModel(d,timing(d)),bound=20)
        end=g['states'][g['terminals']['failed']]
        self.assertIn('branch_timeout',end['reason']);self.assertNotIn('b@',end['tasks'])

    def test_full_compact_clock_agree(self):
        d=data();load=next(n for n in d['ir']['nodes'] if n['node_id']=='load')
        d['ir']['nodes']=[{'node_id':'main','kind':'seq','children':['load']},load]
        d['ir']['conditions']={};d['task']['goal'].update(region='C1.entry',support='C1.entry',holder='C1')
        model=TransitionModel(d,timing(d,(1,2)))
        graphs=[explore(model,bound=64,state_limit=20000,time_limit=20,mode=m) for m in ('full','compact','clock')]
        self.assertTrue(all(g['report']['finite_model_exhausted'] for g in graphs))
        self.assertEqual([{p:r['verdict'] for p,r in g['report']['properties'].items()} for g in graphs][0],
                         {p:r['verdict'] for p,r in graphs[-1]['report']['properties'].items()})
        self.assertLess(graphs[-1]['report']['states'],graphs[0]['report']['states'])
        for g in graphs:self.assertTrue(replay(model,trace(model,g,g['goal']))['valid'])

    def test_clock_rejects_absolute_external_event(self):
        d=data('S04-P04');m=TransitionModel(d,environment(d,'nominal'))
        with self.assertRaises(VerificationError):explore(m,mode='clock')

    def test_independent_goal_catches_false_success(self):
        d=data('S04-P01-DV04');m=TransitionModel(d,timing(d));g=explore(m,bound=256,mode='clock')
        self.assertIn('V09',g['bad']);self.assertIsNone(g['goal'])
        self.assertEqual(g['states'][g['bad']['V09']]['world']['materials']['M1']['region'],'C2.entry')
        self.assertTrue(replay(m,trace(m,g,g['bad']['V09']))['valid'])

    def test_wrong_request_blocks_completion(self):
        d=data('S04-P01-DV02');m=TransitionModel(d,timing(d));g=explore(m,bound=256,mode='clock')
        self.assertIsNone(g['goal']);self.assertIn('failed',g['terminals'])
        self.assertEqual(g['states'][g['terminals']['failed']]['world']['materials']['M1']['region'],'C2.exit')

    def test_stop_evidence_loss_preserves_writer(self):
        d=data();env=timing(d);env['forced_stop_loss']='C1';m=TransitionModel(d,env);g=explore(m,bound=128,mode='clock')
        s=g['states'][g['terminals']['attention_required']]
        self.assertEqual(s['world']['devices']['C1']['drive'],'stopped')
        self.assertIn('C1.writer',s['world']['grants']);self.assertNotIn('V08',g['bad'])

    def test_requesting_can_have_physical_effects(self):
        d=data();env=timing(d);env['feedback']=[4,4];m=TransitionModel(d,env)
        state=m.initial;found=False
        for _ in range(14):
            options=list(m.successors(state))
            if not options:break
            state=options[-1][0]
            if state['world']['devices']['R1']['held_material']=='M1' and state['tasks']['load@']['phase']=='requesting':found=True;break
        self.assertTrue(found)

    def test_cancel_after_grip_does_not_restore_material(self):
        d=data();load=next(n for n in d['ir']['nodes'] if n['node_id']=='load')
        nodes=[{'node_id':'root','kind':'par','children':['load','fail_later']},load,
               {'node_id':'fail_later','kind':'seq','children':['brief','bad']},
               {'node_id':'brief','kind':'delay','duration':{'value':'1','unit':'ms'}},
               {'node_id':'bad','kind':'fail','code':'INTERRUPT'}]
        d['ir'].update(entry='root',nodes=nodes,conditions={})
        d['source_map'].update({n['node_id']:{'file':'fixture','line':1} for n in nodes})
        m=TransitionModel(d,timing(d));g=explore(m,bound=64,mode='clock')
        s=g['states'][g['terminals']['attention_required']]
        self.assertEqual(s['world']['materials']['M1']['held_by'],'R1')
        self.assertTrue(s['world']['grants'])

    def test_expired_and_wrong_epoch_feedback_are_ignored(self):
        d=data();m=TransitionModel(d,timing(d));state=copy.deepcopy(m.initial)
        key=m.activate(state,'load',[],None,None);t=state['tasks'][key];t['phase']='requesting';state['tick']=10
        e={'request':key,'kind':'accepted','device':'R1','subject':'M1','epoch':0,'sample_tick':0}
        m.consume(state,e,[]);self.assertFalse(t['accepted'])
        e.update(epoch=9,sample_tick=10);m.consume(state,e,[]);self.assertFalse(t['accepted'])
        e.update(epoch=0,device='C2');m.consume(state,e,[]);self.assertFalse(t['accepted'])

    def test_provider_restart_invalidates_previous_stop_ack(self):
        d=data();env=timing(d);env.update(faults=['provider_restart'],max_faults=1)
        m=TransitionModel(d,env);s=copy.deepcopy(m.initial)
        key=m.activate(s,'feed_1',[],None,None);s['tasks'][key].update(phase='exit_wait',stop_ack=True,claims=['C1.writer'])
        s['world']['grants']['C1.writer']=key
        changed=next(state for state,_ in m.fault_variants(s,[]) if state['fault_count'])
        self.assertFalse(changed['tasks'][key]['stop_ack']);self.assertEqual(changed['world']['devices']['C1']['epoch'],1)

    def test_step_budget_stops_new_work(self):
        d=fixture([{'node_id':'root','kind':'par','children':['a','b']},
                   *[{'node_id':x,'kind':'delay','duration':{'value':'0','unit':'s'}} for x in ('a','b')]])
        d['execution_profile']['max_transitions_per_tick']=1
        m=TransitionModel(d,timing(d));g=explore(m,bound=10)
        self.assertEqual(g['states'][g['terminals']['failed']]['reason'],'E_STEP_BUDGET')

    def test_small_bound_not_full_proof(self):
        d=data();g=explore(TransitionModel(d,timing(d)),bound=2,mode='clock')
        self.assertFalse(g['report']['finite_model_exhausted'])
        self.assertEqual(g['report']['properties']['V09']['verdict'],'NO_VIOLATION_WITHIN_BOUND')

    def test_state_budget_is_unknown(self):
        d=data();g=explore(TransitionModel(d,timing(d)),bound=256,state_limit=2)
        self.assertEqual(g['report']['limit'],'RESOURCE_LIMIT')
        self.assertEqual(g['report']['properties']['V09']['verdict'],'UNKNOWN')

    def test_inconsistent_initial_holder_rejected(self):
        d=data();d['initial']['holder']='R2'
        with self.assertRaises(VerificationError) as error:TransitionModel(d,timing(d))
        self.assertEqual(error.exception.code,'INCONSISTENT_ASSUMPTIONS')

    def test_missing_initial_permission_not_default_true(self):
        d=data('S12-P03');del d['initial']['device_states']['PS1']['permit']
        with self.assertRaises(VerificationError) as error:TransitionModel(d,timing(d))
        self.assertEqual(error.exception.code,'INVALID_INPUT')

    def test_unregistered_resource_rejected(self):
        d=data();d['relations']['resources']=[r for r in d['relations']['resources'] if r['id']!='R1.motion']
        with self.assertRaises(VerificationError) as error:TransitionModel(d,timing(d))
        self.assertEqual(error.exception.code,'INVALID_INPUT')

    def test_delegation_requires_provider_authorization(self):
        d=data('S03-P02');d['models']['drive@0.1']['delegation']['allowed_behaviors']=['transport_to_exit']
        with self.assertRaises(VerificationError) as error:TransitionModel(d,timing(d))
        self.assertEqual(error.exception.code,'UNSUPPORTED_MODEL')

    def test_invalid_speed_rejected(self):
        d=data();d['relations']['control_scopes'][0]['speed_m_s']=-0.2
        with self.assertRaises(VerificationError) as error:TransitionModel(d,timing(d))
        self.assertEqual(error.exception.code,'INVALID_INPUT')

    def test_ownership_and_resource_invariants_detect_bad_state(self):
        d=data();m=TransitionModel(d,timing(d));s=copy.deepcopy(m.initial)
        s['world']['grants']={'C1.writer':'scopeA','C1.zone':'requestB'}
        s['world']['occupancy']['C1.entry'].append('M1')
        self.assertIn('V04',invariant_violations(m,s));self.assertIn('V05',invariant_violations(m,s))

    def test_replay_rejects_tampered_witness(self):
        d=data();m=TransitionModel(d,timing(d));g=explore(m,bound=128,mode='clock')
        witness=trace(m,g,g['goal']);witness['steps'][0]['state']=copy.deepcopy(witness['steps'][0]['state'])
        witness['steps'][0]['state']['world']['materials']['M1']['region']='C2.exit'
        with self.assertRaises(VerificationError):replay(m,witness)

    def test_smt_graph_queries_agree(self):
        for cid,want in [('S04-P01','UNSAT_ON_COMPLETE_GRAPH'),('S04-P01-DV04','SAT')]:
            d=data(cid);g=explore(TransitionModel(d,timing(d)),bound=128,mode='clock')
            self.assertEqual(graph_bmc(g,'V09')['result'],want)


if __name__=='__main__':unittest.main()
