import copy
import json
import os
from pathlib import Path
import sys
import unittest

BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE))
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE',str(BASE)))
from reference.frontend import load
from reference.fixtures import small,set_program
from reference.transition import ReferenceModel
from reference.enumerate import enumerate_model,trace
from reference.common import digest
from certification.binding import make_query,resolve,identity
from certification import logic,success_effects
from certification.policy import check_kernel
from unittest.mock import patch


def query(m,pid='V09',bound=128):
    source={'query_id':'diagnostic-only','case_id':m.d.case_id,'profile':m.d.profile['name'],
            'property_id':pid,'bound_ticks':bound,'applicability':'APPLICABLE','profile_scope':'diagnostic','property_version':'P1'}
    if pid=='V10b':source.update(response_window_ticks=m.d.profile['response_window'],
             tail_policy='legacy_full_windows_only_report_uncovered',covered_trigger_cutoff=max(-1,bound-m.d.profile['response_window']),checked_until=bound)
    spec=json.loads((BASE/'reference/specs/property-spec.json').read_text(encoding='utf8'))
    return make_query(source,m,digest(spec))


class EvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m=ReferenceModel(small(WORK));g=enumerate_model(cls.m,bound=128,seconds=10,retain_edges=True)
        cls.t={'kind':'trace_certificate/0.1',**trace(cls.m,g,g['goals'][0])}
        cls.g={'kind':'graph_certificate/0.1','model_digest':cls.m.model_digest,'coverage_bound':128,'states':g['states'],'edges':g['edges']}

    def test_goal_trace_proves_existence_only(self):
        self.assertEqual(resolve(self.m,query(self.m,'V10a'),self.t)[0]['verdict'],'REACHABLE')
        self.assertIsNone(resolve(self.m,query(self.m,'V09'),self.t)[0]['verdict'])

    def test_goal_after_K_is_not_reachable_within_K(self):
        end=self.t['steps'][-1]['state']['tick']
        self.assertEqual(resolve(self.m,query(self.m,'V10a',end),self.t)[0]['verdict'],'REACHABLE')
        self.assertIsNone(resolve(self.m,query(self.m,'V10a',end-1),self.t)[0]['verdict'])
        self.assertEqual(resolve(self.m,query(self.m,'V10a',end-1),self.g)[0]['verdict'],'UNREACHABLE')

    def test_complete_graph_rederives_safety(self):
        r,_=resolve(self.m,query(self.m,'V09'),self.g)
        self.assertEqual(r['verdict'],'HOLDS');self.assertFalse(r['vacuous'])

    def test_false_success_trace_is_counterexample(self):
        d=load(WORK,'S04-P01-DV04');d.profile.update(accept=[1,1],phase=[1,1],stop=[1,1],feedback=[0,0])
        m=ReferenceModel(d);g=enumerate_model(m,bound=256,seconds=10)
        p={'kind':'trace_certificate/0.1',**trace(m,g,g['bad']['V09'])}
        self.assertEqual(resolve(m,query(m,'V09',256),p)[0]['verdict'],'VIOLATED')

    def test_trace_state_tamper_rejected(self):
        p=copy.deepcopy(self.t);p['steps'][2]['state']['plant']['materials']['M1']['holder']='wrong'
        with self.assertRaises(ValueError):resolve(self.m,query(self.m,'V10a'),p)

    def test_event_tamper_rejected(self):
        p=copy.deepcopy(self.t);p['steps'][0]['events'].append({'kind':'invented'})
        with self.assertRaises(ValueError):resolve(self.m,query(self.m),p)

    def test_missing_graph_edge_rejected(self):
        p=copy.deepcopy(self.g);p['edges'].pop()
        with self.assertRaises(ValueError):resolve(self.m,query(self.m),p)

    def test_claimed_closed_flag_cannot_hide_missing_state(self):
        p=copy.deepcopy(self.g);p['closed']=True;p['states'].pop()
        with self.assertRaises(ValueError):resolve(self.m,query(self.m),p)

    def test_altered_query_bound_without_new_identity_rejected(self):
        q=query(self.m);q['bound_ticks']=1
        with self.assertRaises(ValueError):resolve(self.m,q,self.g)

    def test_wrong_model_or_task_rejected(self):
        d=small(WORK);d.task={'goal':{'op':'at','material':'M1','location':'S.work'}};other=ReferenceModel(d)
        with self.assertRaises(ValueError):resolve(other,query(self.m),self.g)

    def test_horizon_graph_is_not_global_proof(self):
        g=enumerate_model(self.m,bound=2,seconds=5,retain_edges=True)
        p={'kind':'graph_certificate/0.1','model_digest':self.m.model_digest,'coverage_bound':2,'states':g['states'],'edges':g['edges']}
        self.assertEqual(resolve(self.m,query(self.m,'V09',2),p)[0]['verdict'],'HOLDS')
        self.assertIsNone(resolve(self.m,query(self.m,'V09',20),p)[0]['verdict'])

    def test_empty_response_window_is_not_passed(self):
        self.assertEqual(resolve(self.m,query(self.m,'V10b',10),self.g)[0]['reason'],'NO_FULL_RESPONSE_WINDOW')

    def test_response_window_mismatch_rejected(self):
        q=query(self.m,'V10b');q['response_window_ticks']=1;q['covered_trigger_cutoff']=127;q['query_id']=identity(q)
        with self.assertRaises(ValueError):resolve(self.m,q,self.g)

    def test_response_cutoff_and_extended_window_are_distinct_queries(self):
        d=small(WORK);d.profile['response_window']=2;m=ReferenceModel(d)
        g=enumerate_model(m,bound=128,seconds=10,retain_edges=True)
        p={'kind':'graph_certificate/0.1','model_digest':m.model_digest,'coverage_bound':128,'states':g['states'],'edges':g['edges']}
        narrow=query(m,'V10b',3);r,_=resolve(m,narrow,p)
        self.assertEqual(r['verdict'],'HOLDS');self.assertTrue(r['vacuous']);self.assertTrue(r['tail_trigger_reachable'])
        wider=copy.deepcopy(narrow);wider.update(tail_policy='cover_triggers_through_K_extend_checks',covered_trigger_cutoff=3,checked_until=5)
        wider['query_id']=identity(wider)
        self.assertNotEqual(narrow['query_id'],wider['query_id'])
        self.assertEqual(resolve(m,wider,p)[0]['verdict'],'VIOLATED')

    def test_logic_tampering_is_not_trusted(self):
        m=ReferenceModel(load(WORK,'S01-P01-DV01'))
        p=next(p for p in logic.candidates(m) if p['derivation']['rule']=='immutable_initial_gate')
        self.assertEqual(resolve(m,query(m,'V10a'),p)[0]['verdict'],'UNREACHABLE')
        self.assertTrue(resolve(m,query(m,'V09'),p)[0]['vacuous'])
        p=copy.deepcopy(p);p['derivation']['conclusions']['V10a']='REACHABLE'
        with self.assertRaises(ValueError):resolve(m,query(m,'V10a'),p)

    def test_external_event_disables_immutable_guard_proof(self):
        d=load(WORK,'S01-P01-DV01');d.profile['events']=[{'kind':'set_external','tick':1,'fact':'flag','value':True,'valid':True,'provider_epoch':0}]
        d.initial['external']={'flag':{'value':False,'valid':True}}
        m=ReferenceModel(d)
        with self.assertRaises(ValueError):logic.derive(m,'immutable_initial_gate')

    def test_success_effect_proof_not_a_witness(self):
        m=ReferenceModel(load(WORK,'S04-P01'));p=success_effects.generate(m)
        self.assertEqual(resolve(m,query(m,'V09'),p)[0]['verdict'],'HOLDS')
        self.assertIsNone(resolve(m,query(m,'V10a'),p)[0]['verdict'])

    def test_success_effect_missing_derivation_rejected(self):
        p=success_effects.generate(self.m);p['records'].pop(next(iter(p['records'])))
        with self.assertRaises(ValueError):resolve(self.m,query(self.m),p)

    def test_success_effect_altered_poststate_rejected(self):
        p=success_effects.generate(self.m);p['states'][p['final'][0]]['materials']['M1']['region']='changed'
        with self.assertRaises(ValueError):resolve(self.m,query(self.m),p)

    def test_parallel_projection_refused(self):
        with self.assertRaises(ValueError):success_effects.generate(ReferenceModel(small(WORK,'disjoint')))

    def test_all_branch_arms_required(self):
        d=small(WORK);d.initial['external']={'flag':{'value':True,'valid':True}}
        d.env['observation_definitions']={'flag':{'op':'external','key':'flag'}}
        set_program(d,['branch','b','ordered',['timeout','1','s'],
            ['case',['is',['observation','world',('string','flag')],'true'],['delay','left','0','s']],
            ['else',['delay','right','0','s']]])
        m=ReferenceModel(d);p=success_effects.generate(m)
        missing=next(k for k,v in p['records'].items() if v['node']=='right');del p['records'][missing]
        with self.assertRaises(ValueError):resolve(m,query(m),p)

    def test_no_verified_flag_bypass(self):
        with self.assertRaises(ValueError):resolve(self.m,query(self.m),{'kind':'checked_graph','model_digest':self.m.model_digest,'verified':True})

    def test_unreviewed_kernel_is_rejected(self):
        policy=json.loads((BASE/'certification/trusted-kernel.json').read_text(encoding='utf8'))
        first=next(iter(policy['reference_files']));policy['reference_files'][first]='0'*64
        with patch('certification.policy.Path.read_text',return_value=json.dumps(policy)):
            with self.assertRaises(ValueError):check_kernel(self.m)

    def test_success_projection_ignores_only_goal_invisible_fault_fields(self):
        d=small(WORK,faults=['hold_permission_loss']);alias=next(k for k,v in d.env['controls'].items() if d.controls[v]['owner']=='C1')
        policy=next(iter(d.env['policies']))
        set_program(d,['with-control','drive',alias,['policy',policy],['delay','pause','0','s']])
        m=ReferenceModel(d);g=enumerate_model(m,bound=128,seconds=10)
        self.assertTrue(g['summary']['finite_model_closed'])
        self.assertTrue(any(s['outcome']=='succeeded' and s['plant']['devices']['C1']['permit'] is False for s in g['states']))
        p=success_effects.generate(m)
        self.assertEqual(resolve(m,query(m),p)[0]['verdict'],'HOLDS')
        self.assertNotIn('V09',g['bad'])

    def test_projection_never_guesses_which_branch_executes(self):
        d=small(WORK);d.initial['external']={'flag':{'value':True,'valid':True}}
        d.env['observation_definitions']={'flag':{'op':'external','key':'flag'}}
        invocation=copy.deepcopy(d.body)
        set_program(d,['branch','b','ordered',['timeout','1','s'],
             ['case',['is',['observation','world',('string','flag')],'true'],invocation],
             ['else',['delay','other','0','s']]])
        d.task={'goal':{'op':'at','material':'M1','location':'C1.entry'}}
        m=ReferenceModel(d);p=success_effects.generate(m);c=success_effects.check(m,p)
        self.assertEqual(c['poststates'],2)
        self.assertIsNone(resolve(m,query(m),p)[0]['verdict'])


if __name__=='__main__':unittest.main()
