import copy
from pathlib import Path
import sys
import unittest

BASE=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(BASE))
from reference.properties import evaluate, ResponseMonitor, InvalidFrame, owner_ref


def request():return {'activation':'a1','request':'r1','device':'R1','subject':'M1','epoch':0}
def expected():return {'provider':'R1','subject':'M1','epoch':0,'request_scoped':True,
                       'activation':'a1','request':'r1','value_type':'bool'}
def evidence(tick=1):return {**request(),'provider':'R1','valid':True,'sample_tick':tick,'value':True}
def grants():return [{'resource':'zone','owner':owner_ref(request())}]
def world():return {'materials':{'M1':{'region':'T','support':'T','holder':'C2','held_by':None}},
    'devices':{'R1':{'drive':'stopped','held_material':None}},'grants':[],'active_requests':[],'external':{}}
def task():return {'goal':{'op':'all','args':[{'op':'at','material':'M1','location':'T'},
    {'op':'holder','material':'M1','device':'C2'},{'op':'supported','material':'M1','location':'T'},
    {'op':'no_grants'},{'op':'no_active_requests'}]}}
def material():return {'id':'M1','phase':'released','source':'S','target':'T','actor':'R1','tool':'R1.tool',
    'physical':{'region':'T','support':'T','held_by':None},'ledger':{'holder':'R1','locations':['R1.tool']}}
def frame(pid):
    base={'tick':3}
    values={
      'V01':{'kind':'capture','request':request(),'source':{'drive':'stopped','material_ids':['M1']},'required_resources':['zone'],'grants':grants()},
      'V02':{'kind':'confirm_success','request':request(),'accepted':{**request(),'observed':True},'feedback':{**request(),'value':True}},
      'V03':{'kind':'consume_evidence','evidence':evidence(1),'expected':expected(),'max_age':2},
      'V04':{'kind':'state','grants':grants(),'conflicts':[['zone','writer']]},
      'V05':{'kind':'state','materials':[material()],'location_owners':{'S':'C1','T':'C2','R1.tool':'R1'}},
      'V06':{'kind':'state','capacity_domains':[{'id':'C2','capacity':2,'occupied':['M0'],'reserved':['r1']}],
             'effective_commits':[{'activation':'a1','request':'r1','subject':'M1','target':'T'}]},
      'V07':{'kind':'scope_success','request':request(),'stop_write':{'request':'r1','run':False,'tick':1},
             'stop_ack':evidence(2),'current_epoch':0,'actual_drive':'stopped','max_age':2},
      'V08':{'kind':'unknown_stop_handler','request':request(),'required_resources':['zone'],'grants':grants(),
             'terminal':'attention_required','deadline_expired':True,'before_affected_materials':[material()],
             'after_affected_materials':[material()]},
      'V09':{'kind':'root_success','world':world()},'V10a':{'kind':'root_success','world':world()}}
    return {**base,**values[pid]}


def acceptance():return {'kind':'accepted','request':request(),'evidence':evidence(1),'expected':expected(),'max_age':2}
def response(tick=3,terminal='confirmed_success'):
    return {'kind':'response','request':request(),'terminal':terminal,'evidence':evidence(tick),
            'expected':expected(),'max_age':2,'required_resources':['zone'],'grants':grants()}


class PropertyTests(unittest.TestCase):
    def test_positive_examples_for_each_local_property(self):
        for pid in ('V01','V02','V03','V04','V05','V06','V07','V08','V09','V10a'):
            with self.subTest(pid=pid):self.assertEqual(evaluate(pid,frame(pid),task(),bound=3)['status'],'SATISFIED')

    def test_negative_examples_for_each_local_property(self):
        cases={pid:frame(pid) for pid in ('V01','V02','V03','V04','V05','V06','V07','V08','V09')}
        cases['V01']['source']['drive']='moving'
        cases['V02']['feedback']['activation']='old'
        cases['V03']['evidence']['epoch']=1
        cases['V04']['grants'].append({'resource':'writer','owner':['other']})
        cases['V05']['materials'][0]['ledger']['holder']='C2'
        cases['V06']['capacity_domains'][0]['capacity']=1
        cases['V07']['actual_drive']='decelerating'
        cases['V08']['grants']=[]
        cases['V09']['world']['materials']['M1']['region']='S'
        for pid,f in cases.items():
            with self.subTest(pid=pid):self.assertEqual(evaluate(pid,f,task())['status'],'VIOLATED')
        f=frame('V10a');f['world']['materials']['M1']['region']='S'
        self.assertEqual(evaluate('V10a',f,task(),bound=3)['status'],'GOAL_NOT_MET_AT_THIS_EVENT')

    def test_reachability_respects_exact_query_boundary(self):
        f=frame('V10a')
        self.assertEqual(evaluate('V10a',f,task(),bound=3)['status'],'SATISFIED')
        self.assertEqual(evaluate('V10a',f,task(),bound=2)['status'],'OUTSIDE_QUERY_BOUND')
        self.assertEqual(evaluate('V10a',f,task())['status'],'INVALID_FRAME')

    def test_nonmatching_events_do_not_trigger(self):
        for pid in ('V01','V02','V03','V07','V08','V09','V10a'):
            self.assertEqual(evaluate(pid,{'kind':'packet_ignored','tick':3},task())['status'],'NOT_TRIGGERED')

    def test_missing_data_never_passes(self):
        for pid in ('V01','V02','V03','V04','V05','V06','V07','V08','V09','V10a'):
            f=frame(pid)
            for key in list(f):
                if key in ('kind','tick'):continue
                altered=copy.deepcopy(f);del altered[key]
                with self.subTest(pid=pid,field=key):self.assertNotEqual(evaluate(pid,altered,task())['status'],'SATISFIED')

    def test_unknown_stationarity_is_unknown(self):
        f=frame('V01');f['source']['drive']=None
        self.assertEqual(evaluate('V01',f)['status'],'UNKNOWN')

    def test_exact_age_boundary_and_future_timestamp(self):
        f=frame('V03');self.assertEqual(evaluate('V03',f)['status'],'SATISFIED')
        f['tick']=4;self.assertEqual(evaluate('V03',f)['status'],'VIOLATED')
        f['tick']=0;self.assertEqual(evaluate('V03',f)['status'],'VIOLATED')

    def test_value_type_and_subject_checked(self):
        f=frame('V03');f['evidence']['value']=1
        self.assertEqual(evaluate('V03',f)['status'],'VIOLATED')
        f=frame('V03');f['evidence']['subject']='M2'
        self.assertEqual(evaluate('V03',f)['status'],'VIOLATED')

    def test_old_activation_grant_is_not_current_ownership(self):
        f=frame('V01');f['grants'][0]['owner'][0]='old'
        self.assertEqual(evaluate('V01',f)['status'],'VIOLATED')

    def test_handoff_transient_states_are_not_premature_commit(self):
        f=frame('V05');self.assertEqual(evaluate('V05',f)['status'],'SATISFIED')
        f['materials'][0]['phase']='committed'
        self.assertEqual(evaluate('V05',f)['status'],'VIOLATED')
        f['materials'][0]['ledger']={'holder':'C2','locations':['T']}
        self.assertEqual(evaluate('V05',f)['status'],'SATISFIED')

    def test_all_declared_handoff_phase_boundaries(self):
        layouts={'reserved':('S','S',None,'C1','S'),'captured':('S','S','R1','C1','S'),
                 'cleared':('R1.tool','R1.tool','R1','R1','R1.tool'),
                 'placed':('T','T','R1','R1','R1.tool'),'released':('T','T',None,'R1','R1.tool'),
                 'committed':('T','T',None,'C2','T')}
        for phase,(region,support,held,holder,loc) in layouts.items():
            f=frame('V05');m=f['materials'][0];m.update(phase=phase,physical={'region':region,'support':support,'held_by':held},
                ledger={'holder':holder,'locations':[loc]})
            with self.subTest(phase=phase):self.assertEqual(evaluate('V05',f)['status'],'SATISFIED')

    def test_duplicate_commit_separate_from_capacity(self):
        f=frame('V06');f['effective_commits']*=2
        self.assertEqual(evaluate('V06',f)['status'],'VIOLATED')
        self.assertEqual(evaluate('V06',f,variant='pilot_legacy')['status'],'SATISFIED')

    def test_changed_payload_does_not_create_new_commit_identity(self):
        f=frame('V06');other=copy.deepcopy(f['effective_commits'][0]);other['target']='other'
        f['effective_commits'].append(other)
        self.assertEqual(evaluate('V06',f)['status'],'VIOLATED')

    def test_stop_write_and_ack_are_both_needed(self):
        f=frame('V07');f['stop_write']['run']=True
        self.assertEqual(evaluate('V07',f)['status'],'VIOLATED')
        f=frame('V07');f['stop_ack']['sample_tick']=0
        self.assertEqual(evaluate('V07',f)['status'],'VIOLATED')

    def test_failure_handler_cannot_restore_material(self):
        f=frame('V08');f['after_affected_materials'][0]['physical']['region']='S'
        self.assertEqual(evaluate('V08',f)['status'],'VIOLATED')

    def test_unknown_stop_before_and_at_timeout(self):
        f=frame('V08');f.update(terminal='stopping',deadline_expired=False)
        self.assertEqual(evaluate('V08',f)['status'],'SATISFIED')
        f['deadline_expired']=True;self.assertEqual(evaluate('V08',f)['status'],'VIOLATED')

    def test_independent_goal_and_cleanup(self):
        f=frame('V09');f['candidate_goal']=True;f['world']['grants']=grants()
        self.assertEqual(evaluate('V09',f,task())['status'],'VIOLATED')
        self.assertEqual(evaluate('V09',f)['status'],'INVALID_FRAME')

    def test_full_root_cleanup_not_removed_by_small_goal(self):
        f=frame('V09');f['world']['grants']=grants()
        t={'goal':{'op':'at','material':'M1','location':'T'}}
        self.assertEqual(evaluate('V09',f,t)['status'],'VIOLATED')

    def test_unknown_external_goal_is_not_false_or_true(self):
        f=frame('V09');f['world']['external']['ready']={'value':True,'valid':False}
        self.assertEqual(evaluate('V09',f,{'goal':{'op':'external','key':'ready'}})['status'],'UNKNOWN')

    def test_negative_capacity_is_invalid_input(self):
        f=frame('V06');f['capacity_domains'][0]['capacity']=-1
        self.assertEqual(evaluate('V06',f)['status'],'INVALID_FRAME')

    def test_empty_resource_domain_is_vacuous_not_inapplicable(self):
        f=frame('V04');f['grants']=[];r=evaluate('V04',f)
        self.assertEqual(r['status'],'SATISFIED');self.assertFalse(r['trigger_observed'])

    def test_response_at_inclusive_deadline(self):
        m=ResponseMonitor(2,3);m.step(1,[acceptance()]);r=m.step(3,[response()])
        self.assertEqual(r['status'],'TRACE_SATISFIED')

    def test_response_after_deadline_is_violation(self):
        m=ResponseMonitor(2,3);m.step(1,[acceptance()]);r=m.step(4,[response(4)])
        self.assertEqual(r['status'],'TRACE_VIOLATED')

    def test_duplicate_acceptance_does_not_restart_clock(self):
        m=ResponseMonitor(2,3);m.step(1,[acceptance()]);a=acceptance();a['evidence']['sample_tick']=2
        m.step(2,[a]);self.assertEqual(m.step(3,[])['status'],'TRACE_VIOLATED')

    def test_stopping_is_not_a_response(self):
        m=ResponseMonitor(2,3);m.step(1,[acceptance()])
        self.assertEqual(m.step(3,[response(3,'stopping')])['status'],'TRACE_VIOLATED')

    def test_attention_requires_complete_isolation(self):
        for keep,want in [(True,'TRACE_SATISFIED'),(False,'TRACE_VIOLATED')]:
            m=ResponseMonitor(2,3);m.step(1,[acceptance()]);e=response(3,'attention_required')
            if not keep:e['grants']=[]
            self.assertEqual(m.step(3,[e])['status'],want)

    def test_tail_is_not_silently_passed(self):
        m=ResponseMonitor(2,3);a=acceptance();a['evidence']['sample_tick']=3
        self.assertEqual(m.step(3,[a])['status'],'INCOMPLETE_WINDOW')
        self.assertEqual(m.step(5,[response(5)])['status'],'TRACE_SATISFIED')

    def test_no_trigger_until_horizon_then_trace_vacuity(self):
        m=ResponseMonitor(2,3);self.assertEqual(m.step(1,[])['status'],'INCOMPLETE_WINDOW')
        self.assertEqual(m.step(3,[])['status'],'TRACE_VACUOUS')

    def test_old_request_and_epoch_cannot_respond(self):
        for field in ('activation','request','subject','epoch'):
            m=ResponseMonitor(2,3);m.step(1,[acceptance()]);e=response(3)
            e['evidence'][field]=1 if field=='epoch' else 'other'
            self.assertEqual(m.step(3,[e])['status'],'TRACE_VIOLATED')

    def test_response_expected_record_cannot_rebind_request(self):
        m=ResponseMonitor(2,3);m.step(1,[acceptance()]);e=response(3)
        e['expected']['epoch']=1;e['evidence']['epoch']=1
        self.assertEqual(m.step(3,[e])['status'],'TRACE_VIOLATED')

    def test_events_after_trigger_horizon_do_not_create_new_obligation(self):
        m=ResponseMonitor(2,1);a=acceptance();a['evidence']['sample_tick']=2
        self.assertEqual(m.step(2,[a])['status'],'TRACE_VACUOUS')

    def test_monotonic_tick_and_invalid_budget(self):
        with self.assertRaises(InvalidFrame):ResponseMonitor(0,3)
        m=ResponseMonitor(2,3);m.step(1,[])
        with self.assertRaises(InvalidFrame):m.step(1,[])


if __name__=='__main__':unittest.main()
