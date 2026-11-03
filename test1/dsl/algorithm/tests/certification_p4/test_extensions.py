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
from reference.enumerate import enumerate_model
from reference.common import digest,canonical
from certification.binding import make_query
from certification.io import read
from certification_p4 import invariants,event_rules,goal_projection,response_bound,quiet_wait,witnesses
from certification.construct import graph
from certification_p4.binding import resolve_many


def query(m,pid,bound=3000,extended=False):
    source={'query_id':'diagnostic','case_id':m.d.case_id,'profile':m.d.profile['name'],'property_id':pid,
       'bound_ticks':bound,'profile_scope':'diagnostic','property_version':'P1','applicability':'APPLICABLE'}
    if pid=='V10b':
        d=m.d.profile['response_window'];source.update(response_window_ticks=d,
           tail_policy='cover_triggers_through_K_extend_checks' if extended else 'legacy_full_windows_only_report_uncovered',
           covered_trigger_cutoff=bound if extended else max(-1,bound-d),checked_until=bound+d if extended else bound)
    spec=json.loads((BASE/'reference/specs/property-spec.json').read_text(encoding='utf8'))
    return make_query(source,m,digest(spec))


class ExtensionTests(unittest.TestCase):
    def model(self,cid='S01-P01',profile='nominal'):return ReferenceModel(load(WORK,cid,profile))

    def test_invariants_recheck_premises_and_source_sites(self):
        m=self.model()
        for pid in invariants.SITES:
            p=invariants.generate(m,pid);r,_=resolve_many(m,[query(m,pid)],p)
            self.assertEqual(r[0]['verdict'],'HOLDS')
            p=copy.deepcopy(p);p['derivation']['premises']['initial_state_checked']=False
            with self.assertRaises(ValueError):invariants.check(m,p)

    def test_changed_contract_is_not_automatically_trusted(self):
        d=small(WORK);d.actions['load']['model']['resource_claims'].remove('source.zone')
        m=ReferenceModel(d)
        with self.assertRaises(ValueError):invariants.generate(m,'V01')

    def test_missing_source_fence_is_real_interlock_counterexample(self):
        d=small(WORK);a=d.actions['load'];a['args']['source']='C1.exit';a['args']['target']='C2.entry'
        d.relations['transfer_edges'].append({'device':'R1','source':'C1.exit','target':'C2.entry'})
        m=d.initial['materials'][0];m.update(region='C1.exit',support='C1.exit',holder='C1')
        d.initial['occupancy']['S.work']=[];d.initial['occupancy']['C1.exit']=['M1']
        alias=next(k for k,v in d.env['controls'].items() if d.controls[v]['owner']=='C1')
        writer=d.controls[d.env['controls'][alias]]['writer'];zone=d.locations['C1.exit']['zone_ref']
        d.relations['resource_conflicts']=[p for p in d.relations['resource_conflicts'] if set(p)!={writer,zone}]
        invoke=d.body;name=invoke[5][1]
        set_program(d,['par','both',invoke,['with-control','zz_drive',alias,['policy',name],['delay','hold','0.2','s']]])
        model=ReferenceModel(d)
        with self.assertRaises(ValueError):invariants.generate(model,'V01')
        g=enumerate_model(model,bound=128,seconds=10)
        self.assertTrue(g['summary']['finite_model_closed']);self.assertIn('V01',g['bad'])

    def test_occupied_tool_is_real_capacity_counterexample(self):
        d=small(WORK);d.initial['materials'].append({'id':'M2','type':'workpiece','region':'R1.tool','support':'R1.tool','holder':'R1','held_by':None})
        d.initial['occupancy']['R1.tool']=['M2'];m=ReferenceModel(d)
        with self.assertRaises(ValueError):invariants.generate(m,'V06')
        g=enumerate_model(m,bound=128,seconds=10)
        self.assertTrue(g['summary']['finite_model_closed']);self.assertIn('V06',g['bad'])

    def test_complete_small_graphs_agree_with_inductive_claims(self):
        for case in ('single','disjoint','shared_material','parallel_failure'):
            d=small(WORK,case);m=ReferenceModel(d);g=enumerate_model(m,bound=128,seconds=10)
            self.assertTrue(g['summary']['finite_model_closed'])
            for pid in invariants.SITES:
                invariants.check(m,invariants.generate(m,pid))
                self.assertNotIn(pid,g['bad'],(case,pid))

    def test_fault_rules_exercise_injection_and_preserve_invariants(self):
        for fault in ('provider_restart','hold_permission_loss','duplicate_same_request','old_request_feedback','missing_stop_confirmation'):
            case='parallel_failure' if fault=='missing_stop_confirmation' else 'single'
            m=ReferenceModel(small(WORK,case,faults=[fault]));g=enumerate_model(m,bound=128,seconds=10)
            self.assertTrue(g['summary']['finite_model_closed'])
            self.assertTrue(g['summary']['monitor_coverage_complete'])
            self.assertTrue(any(s['faults_used'] for s in g['states']),fault)
            for pid in invariants.SITES:
                invariants.check(m,invariants.generate(m,pid));self.assertNotIn(pid,g['bad'],(fault,pid))

    def test_response_bound_covers_nondeterministic_small_execution(self):
        m=ReferenceModel(small(WORK,nondeterministic=True))
        proof=response_bound.check(m,response_bound.generate(m))
        g=enumerate_model(m,bound=128,seconds=15)
        self.assertTrue(g['summary']['finite_model_closed'])
        self.assertNotIn('V10b',g['bad'])
        upper=proof['bounds']['load']['total_bound']
        accepted=[s for s in g['states'] if s['tokens']['load@'].get('accepted_at') is not None]
        self.assertTrue(accepted)
        self.assertTrue(all(s['tick']-s['tokens']['load@']['accepted_at']<=upper for s in accepted))

    def test_external_event_frame_proof_cannot_ignore_goal_write(self):
        m=self.model('S04-P04');p=event_rules.generate(m,'external_final_guard')
        self.assertEqual(event_rules.check(m,p)['conclusions']['V09'],'HOLDS')
        d=copy.deepcopy(m.d);d.task['goal']={'op':'all','args':[{'op':'external','key':'c2_accepting'},{'op':'no_grants'},{'op':'no_active_requests'}]}
        d.env['observation_definitions']['task_goal']=d.task['goal']
        d.profile['events'][0]['value']=False
        with self.assertRaises(ValueError):event_rules.generate(ReferenceModel(d),'external_final_guard')

    def test_external_initial_blocker_retains_false_atom(self):
        m=self.model('S04-P04-DV01');p=event_rules.generate(m,'external_initial_blocker')
        self.assertEqual(event_rules.check(m,p)['conclusions']['V10a'],'UNREACHABLE')

    def test_no_request_vacuity_is_independent_of_feedback_freshness(self):
        m=self.model('S10-P01-DV04','fault');p=event_rules.generate(m,'no_request_program')
        r,_=resolve_many(m,[query(m,'V10b',1000,extended=True)],p)
        self.assertEqual(r[0]['verdict'],'HOLDS');self.assertIs(r[0]['vacuous'],True)
        with self.assertRaises(ValueError):event_rules.generate(self.model(),'no_request_program')

    def test_closed_branch_graph_proves_absence_but_changed_condition_does_not(self):
        for profile in ('delayed','fault'):
            m=self.model('S10-P03-DV04',profile);p,stats=graph(m,bound=2800,seconds=5)
            self.assertTrue(stats['finite_model_closed'])
            r,_=resolve_many(m,[query(m,'V10b',1000,extended=True)],p)
            self.assertEqual(r[0]['verdict'],'HOLDS');self.assertIs(r[0]['vacuous'],True)
        changed=copy.deepcopy(m.d);changed.initial['external']['class_A']['value']=True
        other=ReferenceModel(changed)
        with self.assertRaises(ValueError):resolve_many(other,[query(other,'V10b',1000,extended=True)],p)
        trace=witnesses.minimum_prefix(other,{'V10b'},100)
        result,_=resolve_many(other,[query(other,'V10b',1000,extended=True)],trace)
        self.assertEqual(result[0]['trigger_reachability'],'REACHABLE')

    def test_material_branch_pruning_checks_prior_and_loop_writes(self):
        m=self.model('S02-P07-DV04');p=goal_projection.generate(m)
        self.assertEqual(goal_projection.check(m,p)['conclusions']['V09'],'HOLDS')
        notes=p['projection_proof']['transformations']
        self.assertTrue(any(n.get('branch')=='branch_15' and n['rule']=='constant_branch' for n in notes))
        changed=copy.deepcopy(m.d);changed.actions['transfer_material_1']['args']['material']='M2'
        _,proof=goal_projection.transform(ReferenceModel(changed))
        self.assertFalse(any(n.get('branch')=='branch_15' and n['rule']=='constant_branch' for n in proof['transformations']))
        repeated=copy.deepcopy(m.d);set_program(repeated,['repeat','again','2',repeated.body])
        _,proof=goal_projection.transform(ReferenceModel(repeated))
        self.assertFalse(any(n.get('branch')=='branch_15' and n['rule']=='constant_branch' for n in proof['transformations']))

    def test_parallel_projection_checks_shared_material(self):
        m=ReferenceModel(small(WORK,'shared_material'))
        with self.assertRaises(ValueError):goal_projection.generate(m)

    def test_parallel_projection_allows_disjoint_and_constant_final_fields(self):
        for cid in ('S01-P05-DV04','S07-P05-DV04','S12-P04-DV04'):
            m=self.model(cid);p=goal_projection.generate(m);r=goal_projection.check(m,p)
            self.assertEqual(r['conclusions'].get('V10a'),'UNREACHABLE')
            p=copy.deepcopy(p);p['projection_proof']['transformations']=[]
            with self.assertRaises(ValueError):goal_projection.check(m,p)

    def test_unlike_shared_axis_targets_rejected(self):
        d=load(WORK,'S12-P04-DV04')
        index_actions=[a for a in d.actions.values() if a['model']['id']=='index@0.1']
        self.assertGreaterEqual(len(index_actions),2)
        index_actions[-1]['args']['target_index']=(index_actions[0]['args']['target_index']+1)%d.devices[index_actions[0]['device']]['parameters']['index_count']
        with self.assertRaises(ValueError):goal_projection.generate(ReferenceModel(d))

    def test_constant_branch_and_external_projection(self):
        for cid in ('S01-P03-DV04','S10-P04-DV04','S04-P04-DV04'):
            m=self.model(cid);p=goal_projection.generate(m)
            self.assertEqual(goal_projection.check(m,p)['conclusions'].get('V10a'),'UNREACHABLE')

    def test_response_bound_requires_fresh_feedback(self):
        m=self.model();p=response_bound.generate(m);d=response_bound.check(m,p)
        self.assertLess(max(x['total_bound'] for x in d['bounds'].values()),1800)
        with self.assertRaises(ValueError):response_bound.generate(self.model(profile='delayed'))
        with self.assertRaises(ValueError):response_bound.generate(self.model(profile='fault'))
        d=small(WORK);d.profile['response_window']=2
        with self.assertRaises(ValueError):response_bound.generate(ReferenceModel(d))

    def test_response_bound_disallows_initial_nonce_collision(self):
        d=load(WORK,'S12-P03');actor=next(a['device'] for a in d.actions.values() if a['model']['id']=='process@0.1')
        d.initial['device_states'][actor]['operation_history']=[{'request':'old','material':d.initial['materials'][0]['id']}]
        with self.assertRaises(ValueError):response_bound.generate(ReferenceModel(d))

    def wait_prefix(self):
        d=small(WORK);d.profile.update(feedback=[0,3],max_age=2,response_window=32)
        m=ReferenceModel(d);s=m.initial
        for _ in range(20):
            jump=quiet_wait.make_jump(m,s,128)
            if jump:return m,s,jump
            s,_=quiet_wait.chosen_next(m,s)
        self.fail('No quiescent segment')

    def test_quiet_wait_matches_every_expanded_tick(self):
        m,s,jump=self.wait_prefix();expanded=copy.deepcopy(s)
        for delta in range(1,jump['delta']+1):
            expanded,_=quiet_wait.chosen_next(m,expanded);predicted,_=quiet_wait.forecast(m,s,delta)
            self.assertEqual(expanded,predicted,delta)

    def test_jump_boundary_or_timestamp_tamper_rejected(self):
        m,s,jump=self.wait_prefix();bad=copy.deepcopy(jump);bad['delta']+=1
        with self.assertRaises(ValueError):quiet_wait.check_jump(m,s,bad)
        bad=copy.deepcopy(jump);bad['after']['mail'][-1]['sample_tick']-=1
        with self.assertRaises(ValueError):quiet_wait.check_jump(m,s,bad)

    def test_jump_cannot_cross_external_event(self):
        m,s,_=self.wait_prefix();d=copy.deepcopy(m.d);d.initial['external']={'flag':{'value':False,'valid':True,'provider_epoch':0,'sample_tick':0}}
        d.profile['events']=[{'tick':s['tick']+3,'kind':'set_external','fact':'flag','value':True,'valid':True,'provider_epoch':0}]
        other=ReferenceModel(d);state=other.initial
        while state['tick']<s['tick']:state,_=quiet_wait.chosen_next(other,state)
        _,boundary,_=quiet_wait.hypotheses(other,state)
        self.assertEqual(boundary,s['tick']+3)
        with self.assertRaises(ValueError):quiet_wait.forecast(other,state,3)

    def test_compressed_counterexample_has_same_deadline(self):
        for profile in ('delayed','fault'):
            m=self.model(profile=profile);p=quiet_wait.generate_trace(m,3000);checked=quiet_wait.check_trace(m,p)
            self.assertLess(len(p['segments']),40);self.assertEqual(checked['last_tick'],1807)
            r,_=resolve_many(m,[query(m,'V10b',1000,extended=True)],p)
            self.assertEqual(r[0]['verdict'],'VIOLATED')

    def test_macro_endpoints_match_checked_P3_full_traces(self):
        for profile in ('delayed','fault'):
            original=read(WORK/'datasets/ac-path-v1/oracle/whole-line-p3-v1/evidence/S01-P01'/(profile+'-trace-stale-result.json.gz'))
            m=self.model(profile=profile);p=quiet_wait.generate_trace(m,3000)
            self.assertEqual(p['model_digest'],original['model_digest'])
            by_tick={step['state']['tick']:step['state'] for step in original['steps']}
            for segment in p['segments']:self.assertEqual(segment['after'],by_tick[segment['after']['tick']])

    def test_macro_continues_to_qualified_isolation_after_violation(self):
        d=small(WORK);d.profile.update(feedback=[0,3],max_age=2,response_window=32)
        m=ReferenceModel(d);p=quiet_wait.generate_trace(m,128,stop_on_violation=False)
        state=m.initial;expanded={0:state}
        while state['outcome']=='running':
            state,_=quiet_wait.chosen_next(m,state);expanded[state['tick']]=state
        for segment in p['segments']:self.assertEqual(segment['after'],expanded[segment['after']['tick']])
        self.assertEqual(p['segments'][-1]['after']['outcome'],'attention_required')
        self.assertIn('V08',p['segments'][-1]['after']['triggered'])
        quiet_wait.check_trace(m,p)


if __name__=='__main__':unittest.main()
