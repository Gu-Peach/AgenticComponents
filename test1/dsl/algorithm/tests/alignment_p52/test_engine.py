import ast
import copy
import os
from pathlib import Path
import sys
import unittest

BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE));sys.path.insert(0,str(BASE/'src'))
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE','E:/project/AgenticComponents/test1/dsl/algorithm'))
from alignment_p52.models import pair,fixture,setup
from alignment_p52.relation import canonical,walk
from alignment_p52.closed import compare
setup(WORK)
from acverify_v3 import monitor
from acverify_v3.model import TransitionModel
from acverify_v3.query import observed,validate
from acverify_v3.search import explore,replay,witness
from acverify_v3.expressions import world_expr
from reference.transition import ReferenceModel


def query(model,pid,k=128,window=None,extended=False):
    if window is None:window=model.data['queries'].get('response_window_ticks')
    return dict(query_id=pid+str(k)+str(extended),case_id=model.data['descriptor']['case_id'],profile=model.profile['id'],
        property_id=pid,applicability='APPLICABLE',bound_ticks=k,checked_until=k+window if pid=='V10b' and extended else k,
        covered_trigger_cutoff=k if extended else max(-1,k-window) if pid=='V10b' else None,
        response_window_ticks=window if pid=='V10b' else None,
        tail_policy=('cover_triggers_through_K_extend_checks' if extended else 'legacy_full_windows_only_report_uncovered') if pid=='V10b' else None)


class EngineTests(unittest.TestCase):
    def test_device_hold_before_acceptance_and_pending_stop(self):
        for config,last in ((dict(single=True,feedback=3,faults=['hold_permission_loss']),9),
                            (dict(single=True,faults=['hold_permission_loss'],stop=[5,5],stop_ticks=1),7)):
            sut,ref=fixture(WORK,**config);result=walk(sut,ref,128,2,'hold_permission_loss')
            self.assertEqual(result['status'],'MATCHED_TERMINAL',result.get('differences'))
            self.assertEqual(result['tick'],last)
            self.assertIsNone(result['trace'][2]['sut']['world']['materials']['M1']['held_by'])

    def test_every_queued_packet_is_in_the_fault_domain(self):
        sut,ref=fixture(WORK,single=True,feedback=3,faults=['duplicate_same_request'])
        states=walk(sut,ref,3)['trace'];s=copy.deepcopy(states[-1]['sut']);s['tick']+=1
        samples=[v['inbox'][-1]['sample_tick'] for v,events in sut.fault_variants(s,[]) if any(e['kind']=='fault' for e in events)]
        self.assertEqual(samples,[1,2,3])

    def test_external_replacement_checks_conflicting_resource(self):
        sut,_=fixture(WORK,single=True);s=copy.deepcopy(sut.initial)
        zone=sut.locations['S.work']['zone_ref'];alias='lease';sut.conflicts.add(frozenset((zone,alias)))
        sut.profile['events']=[dict(tick=1,kind='replace_carrier',carrier='S',materials=['M1'],destination='C1.entry',set_fact='done',new_epoch=1)]
        s['tick']=1;s['world']['grants'][alias]='other';s['world']['external']['done']=dict(value=False,valid=True)
        sut.apply_events(s,[])
        self.assertEqual(s['world']['materials']['M1']['region'],'S.work');self.assertFalse(s['applied_events'])

    def test_handoff_support_is_checked_even_when_holder_matches(self):
        sut,_=fixture(WORK,single=True);s=copy.deepcopy(sut.initial);s['world']['materials']['M1']['support']='C1.entry'
        monitor.state_checks(sut,s,[]);self.assertIn('V05',s['violations'])

    def test_stop_receipt_checks_identity_timestamp_and_actual_motion(self):
        req=dict(activation='feed@',request='feed@',device='C1',subject=None,epoch=0)
        write=dict(request='feed@',run=False,tick=5)
        packet={**req,'provider':'C1','value':True,'valid':True,'sample_tick':5}
        good=lambda p,drive='stopped':monitor.stop_exit_valid(req,write,p,0,drive,6,2)
        self.assertTrue(good(packet))
        for field,value in (('sample_tick',1),('request','old@'),('epoch',1),('valid',False),('value',False)):
            self.assertFalse(good({**packet,field:value}))
        self.assertFalse(good(packet,'moving'));self.assertIsNone(good(packet,None))

    def test_isolation_preserves_effects_and_grants(self):
        self.assertTrue(monitor.isolation_valid({'m':1},{'m':1},['zone'],{'zone':'r'},'r'))
        self.assertFalse(monitor.isolation_valid({'m':1},{'m':2},['zone'],{'zone':'r'},'r'))
        self.assertFalse(monitor.isolation_valid({'m':1},{'m':1},['zone'],{},'r'))
        self.assertIsNone(monitor.isolation_valid({}, {},[],{},'r',expired=None))

    def test_world_three_valued_logic(self):
        sut,_=fixture(WORK,single=True);s=copy.deepcopy(sut.initial);s['world']['devices']['R1']['drive']=None
        atom=dict(op='drive_stopped',device='R1')
        self.assertIsNone(world_expr(sut,s,atom));self.assertIsNone(world_expr(sut,s,dict(op='not',arg=atom)))
        self.assertTrue(world_expr(sut,s,dict(op='any',args=[atom,dict(op='drive_stopped',device='C1')])))

    def test_unknown_business_goal_is_not_a_false_success_counterexample(self):
        sut,_=fixture(WORK,single=True);s=copy.deepcopy(sut.initial)
        s['world']['external']['goal_flag']=dict(value=None,valid=True)
        sut.data['task']['goal']=dict(op='external',key='goal_flag')
        self.assertIsNone(monitor.root_goal_value(sut,s));self.assertFalse(monitor.root_goal(sut,s))
        monitor.record(s,'V09',monitor.root_goal_value(sut,s),[])
        self.assertIn('V09',s['uncovered']);self.assertNotIn('V09',s['violations'])

    def test_property_triggers_are_at_consumption_and_completion(self):
        sut,ref=fixture(WORK,single=True);p=walk(sut,ref,2);s=p['trace'][-1]['sut']
        self.assertNotIn('V02',s['trigger_ticks']);self.assertIn('V03',s['trigger_ticks'])
        p=walk(sut,ref,64);self.assertIn('V02',p['trace'][-1]['sut']['trigger_ticks'])

    def test_tail_only_trigger_is_not_a_query_counterexample(self):
        sut,_=fixture(WORK,single=True);sut.data['queries']['response_window_ticks']=1
        q=query(sut,'V10b',10,1,True);s=copy.deepcopy(sut.initial)
        s['acceptances']={'load@':11};s['response_violations']={'load@':dict(accepted_at=11,deadline=12,tick=12)}
        self.assertIsNone(observed(sut,s,q)['verdict']);self.assertFalse(observed(sut,s,q)['trigger'])
        s['acceptances']['load@']=10;s['response_violations']['load@'].update(accepted_at=10,deadline=11,tick=11)
        self.assertEqual(observed(sut,s,q)['verdict'],'VIOLATED')

    def test_response_at_deadline_wins_and_late_response_cannot_erase_violation(self):
        sut,_=fixture(WORK,single=True);sut.data['queries']['response_window_ticks']=2
        s=copy.deepcopy(sut.initial);t=s['tasks']['load@'];t.update(phase='succeeded',accepted_tick=3)
        s['tick']=5;monitor.response_tick(sut,s,[]);self.assertFalse(s['response_violations'])
        t['phase']='running';s['responses']={};monitor.response_tick(sut,s,[]);self.assertIn('load@',s['response_violations'])
        s['tick']=6;t['phase']='succeeded';monitor.response_tick(sut,s,[]);self.assertIn('load@',s['response_violations'])

    def test_query_validation_and_empty_legacy_window(self):
        sut,_=fixture(WORK,case='S01-P01',single=True);q=query(sut,'V10b',10,extended=True)
        validate(sut,[q]);bad={**q,'checked_until':10}
        with self.assertRaises(ValueError):validate(sut,[bad])
        old=query(sut,'V10b',10)
        g=explore(sut,[old],seconds=2)
        self.assertEqual(g['results'][0]['verdict'],'UNKNOWN')
        self.assertEqual(g['results'][0]['reason'],'NO_FULL_RESPONSE_WINDOW')

    def test_storage_and_baseline_have_identical_successor_sets(self):
        sut,ref=fixture(WORK,single=True,feedback=1)
        fast=TransitionModel(sut.data,sut.profile,fast_copy=True)
        self.assertEqual(canonical(sut.initial),canonical(fast.initial))
        a=sut.initial;b=fast.initial
        for _ in range(30):
            left=list(sut.successors(a));right=list(fast.successors(b));self.assertEqual(left,right)
            if not left:break
            a=left[0][0];b=right[0][0]

    def test_complete_nondeterministic_physical_and_message_graphs(self):
        for field in ('phase','feedback'):
            sut,ref=fixture(WORK,single=True)
            env=copy.deepcopy(sut.profile);d=copy.deepcopy(ref.d)
            env[field]=[1,2] if field=='phase' else [0,1];d.profile[field]=env[field]
            result=compare(TransitionModel(sut.data,env),ReferenceModel(d),seconds=10)
            self.assertEqual(result['status'],'CLOSED_MATCH',result)

    def test_complete_fault_graph_checks_both_directions(self):
        sut,ref=fixture(WORK,single=True,feedback=3,faults=['duplicate_same_request','old_request_feedback','provider_restart','hold_permission_loss'])
        result=compare(sut,ref,seconds=10);self.assertEqual(result['status'],'CLOSED_MATCH',result)

    def test_exhaustion_limit_never_becomes_equivalence(self):
        sut,ref=fixture(WORK,single=True);r=compare(sut,ref,max_pairs=1)
        self.assertEqual(r['status'],'LIMIT')

    def test_reintroduced_defects_are_detected(self):
        from alignment_p52.mutations import run
        results=run(WORK)
        self.assertTrue(all(r['detected'] for r in results),results)

    def test_node_bridge_checks_conditions_and_timeouts(self):
        from alignment_p52.input_bridge import compare_inputs
        sut,ref=pair(WORK,'S04-P01');self.assertTrue(all(compare_inputs(sut,ref).values()))
        n=next(n for n in sut.nodes.values() if n['kind']=='await');n['timeout']['value']=str(float(n['timeout']['value'])+1)
        self.assertFalse(compare_inputs(sut,ref)['nodes'])

    def test_finite_fixture_query_answers_match_reference_checker(self):
        from alignment_p52.fixtures import definitions,compare_queries
        for p,s,r in definitions(WORK):
            if p['id'] in ('transfer','lost_stop','exclusive_conflict','repeat_circulation'):
                q=compare_queries(s,r,seconds=10)
                self.assertEqual(q['status'],'MATCH',q)

    def test_three_search_strategies_share_query_semantics(self):
        from acverify_v3.pipeline import verify
        import json
        p=WORK/'artifacts/reference-p5/alignment-v2/evaluation-scope.json'
        rows=json.loads(p.read_text(encoding='utf8'))['records']
        selected=[q for q in rows if q['case_id']=='S10-P03-DV04' and q['profile']=='nominal']
        answers=[]
        for mode in ('none','storage','portfolio'):
            result,traces=verify(WORK/'datasets/ac-path-v1/cases/S10-P03-DV04/case.json',WORK,selected,seconds=2,optimization=mode)
            answers.append([(r['query_id'],r['verdict'],r['vacuous']) for r in result['results']])
            self.assertTrue(all(x['checked_steps']>0 for x in result['replays'].values()))
        self.assertEqual(answers[0],answers[1]);self.assertEqual(answers[1],answers[2])

    def test_all_ten_p51_probe_recipes_are_repaired(self):
        from alignment_p52.probes import run
        rows=run(WORK);self.assertEqual(len(rows),10)
        self.assertTrue(all(r['status']=='MATCH' for r in rows),[(r['id'],r['status']) for r in rows])

    def test_search_limits_keep_unknown_and_do_not_assert_absence(self):
        sut,_=fixture(WORK,single=True);q=query(sut,'V10a')
        for options in ({'seconds':0},{'state_limit':1},{'memory_mb':1}):
            result=explore(sut,[q],**options)
            self.assertEqual(result['results'][0]['verdict'],'UNKNOWN')
            self.assertFalse(result['statistics']['finite_model_closed'])

    def test_query_witness_replay_and_tamper(self):
        sut,_=fixture(WORK,single=True);q=query(sut,'V10a');g=explore(sut,[q],seconds=2)
        # The original two-robot goal need not be met by a single transfer.
        self.assertIn(g['results'][0]['verdict'],('UNREACHABLE','REACHABLE'))
        index=len(g['states'])-1;p=witness(sut,g,index);replay(sut,p)
        p['steps'][-1]['state']=copy.deepcopy(p['steps'][-1]['state']);p['steps'][-1]['state']['tick']+=1
        with self.assertRaises(ValueError):replay(sut,p)

    def test_no_oracle_or_reference_imports_in_solver(self):
        for p in (BASE/'src/acverify_v3').glob('*.py'):
            tree=ast.parse(p.read_text(encoding='utf8'))
            for node in ast.walk(tree):
                if isinstance(node,ast.Import):self.assertFalse(any(a.name.split('.')[0] in ('reference','certification','certification_p4','alignment_p5','alignment_p52') for a in node.names),str(p))
                if isinstance(node,ast.ImportFrom) and node.module and node.level==0:
                    self.assertNotIn(node.module.split('.')[0],('reference','certification','certification_p4','alignment_p5','alignment_p52'),str(p))


if __name__=='__main__':unittest.main()
