import ast
import copy
import os
from pathlib import Path
import sys
import unittest

BASE=Path(__file__).resolve().parents[2]
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE',str(BASE)))
sys.path[:0]=[str(BASE),str(WORK/'tools')]
from reference.frontend import load
from reference.transition import ReferenceModel
from reference.enumerate import enumerate_model,trace,replay
from reference.fixtures import small,set_program
from reference.common import canonical,Unsupported
from reference.state import activate
from reference import channel
from reference.environment import external,faults
from reference_channel_v2 import fixtures as channel_fixtures,enumerate_channel


class TransitionTests(unittest.TestCase):
    def graph(self,d,bound=128):
        model=ReferenceModel(d);g=enumerate_model(model,bound=bound,max_states=40000,seconds=20)
        self.assertTrue(g['summary']['finite_model_closed'],g['summary'])
        self.assertFalse(g['summary']['uncovered_obligations'])
        return model,g

    def test_s04_fixed_intervals_goal_and_false_success(self):
        for cid,success,wrong in [('S04-P01',True,False),('S04-P01-DV01',False,False),
                                  ('S04-P01-DV02',False,False),('S04-P01-DV03',True,False),('S04-P01-DV04',False,True)]:
            d=load(WORK,cid);d.profile.update(accept=[1,1],phase=[1,1],stop=[1,1],feedback=[0,0])
            m,g=self.graph(d,256)
            self.assertEqual(bool(g['goals']),success);self.assertEqual('V09' in g['bad'],wrong)
            self.assertTrue(replay(m,trace(m,g,len(g['states'])-1))['valid'])

    def test_nondeterministic_sequential_graph_closes(self):
        m,g=self.graph(small(WORK,nondeterministic=True))
        self.assertGreater(g['summary']['states'],30);self.assertTrue(g['goals']);self.assertFalse(g['bad'])
        again=enumerate_model(m,bound=128,seconds=20)
        self.assertEqual(g['summary']['edge_digest'],again['summary']['edge_digest'])

    def test_corpus_capability_families_and_external_replacement(self):
        for cid in ('S03-P02','S07-P01','S12-P03','S02-P05','S10-P04'):
            d=load(WORK,cid);d.profile.update(accept=[1,1],phase=[1,1],stop=[1,1],feedback=[0,0],faults=[],max_faults=0)
            m,g=self.graph(d,3000)
            self.assertTrue(g['goals'],cid);self.assertFalse(g['bad'],cid)

    def test_emit_declared_material_preserves_identity(self):
        d=small(WORK);d.devices['E']={'id':'E','device_type':'source','parameters':{'capacity':1}}
        d.initial['device_states']['E']=copy.deepcopy(d.initial['device_states']['S'])
        d.relations['resources'].append({'id':'E.operation'});d.env['bindings']['emitter']={'type':'device','id':'E'}
        mid=d.initial['materials'][0];mid.update(region='unspawned',support=None,holder=None,held_by=None)
        for items in d.initial['occupancy'].values():items.clear()
        d.actions={'spawn':{'device':'E','behavior':'emit_material','scope':None,'args':{'material':'M1','target':'C1.entry'},'model':copy.deepcopy(d.models['emit@0.1'])}}
        policy_name=next(iter(d.env['policies']))
        set_program(d,['invoke','spawn','emitter','emit_material',['args'],['policy',policy_name]])
        m,g=self.graph(d);self.assertTrue(g['goals']);self.assertFalse(g['bad'])
        self.assertEqual(g['states'][-1]['plant']['materials']['M1']['region'],'C1.entry')

    def test_transition_budget_aborts_before_new_physical_effects(self):
        d=small(WORK,'disjoint');d.execution['max_transitions_per_tick']=1
        m,g=self.graph(d);self.assertEqual(g['states'][-1]['abort'],'E_STEP_BUDGET')
        self.assertEqual(g['states'][-1]['plant']['materials']['M1']['region'],'S.work')

    def test_carrier_replacement_waits_for_active_request_even_without_zone_grant(self):
        d=load(WORK,'S10-P04');m=ReferenceModel(d);s=copy.deepcopy(m.initial);event=d.profile['events'][0]
        for mid in event['materials']:
            self.assertEqual(s['plant']['materials'][mid]['holder'],'P1')
        node=next(k for k,a in d.actions.items() if a['args'].get('target','').startswith('P1.'))
        k=activate(d,s,node,[],None,None);s['tokens'][k]['status']='waiting_accept';s['tick']=event['tick']
        external(d,s,[]);self.assertFalse(s['events_done'])
        s['tokens'][k]['status']='cancelled';external(d,s,[]);self.assertEqual(s['events_done'],[0])

    def test_disjoint_branches_progress_concurrently(self):
        m,g=self.graph(small(WORK,'disjoint'))
        self.assertTrue(g['goals']);self.assertFalse(g['bad'])
        self.assertTrue(any(s['plant']['devices']['R1']['held_material'] and s['plant']['devices']['R2']['held_material'] for s in g['states']))

    def test_shared_material_is_not_double_granted(self):
        m,g=self.graph(small(WORK,'shared_material'))
        self.assertFalse(g['bad']);self.assertFalse(g['goals'])
        self.assertTrue(all(sum(t.get('actor') in ('R1','R2') and t.get('status')=='executing' for t in s['tokens'].values())<=1 for s in g['states']))

    def test_capacity_arbitration_is_atomic_without_target_zone_mutex(self):
        m,g=self.graph(small(WORK,'capacity'))
        self.assertFalse(g['bad'])
        for s in g['states']:
            self.assertLessEqual(len(s['plant']['ledger']['C2.entry'])+sum(v['target']=='C2.entry' for v in s['plant']['reservations'].values()),1)

    def test_parallel_failure_preserves_effects_and_stops_siblings(self):
        m,g=self.graph(small(WORK,'parallel_failure'))
        self.assertFalse(g['goals']);self.assertFalse(g['bad'])
        terminal=[s for s in g['states'] if s['outcome']!='running']
        self.assertTrue(terminal)
        self.assertTrue(all(all(t['status'] in ('failed','cancelled','isolated','ok') for t in s['tokens'].values()) for s in terminal))

    def test_all_declared_faults_on_small_request(self):
        for fault in ('provider_restart','hold_permission_loss','duplicate_same_request','old_request_feedback'):
            with self.subTest(fault=fault):
                m,g=self.graph(small(WORK,faults=[fault]))
                self.assertFalse(g['bad']);self.assertTrue(any(s['faults_used']==1 for s in g['states']))
                if fault in ('provider_restart','hold_permission_loss'):
                    self.assertIn('attention_required',g['summary']['terminal_counts'])

    def test_packet_fault_choice_covers_every_queued_packet(self):
        d=small(WORK,faults=['duplicate_same_request']);m=ReferenceModel(d);s=copy.deepcopy(m.initial)
        s['tokens']['load@']['status']='waiting_accept'
        packet={'request':'load@','activation':'load@','kind':'accepted','stream':'load@|accepted','sample_tick':0,'due':2}
        s['mail']=[packet,{**packet,'kind':'result','stream':'load@|result','sample_tick':1,'due':3}]
        choices=[log[-1]['packet_index'] for nxt,log in faults(d,s,[]) if nxt['faults_used']==1]
        self.assertEqual(choices,[0,1])

    def test_device_hold_before_acceptance_observation(self):
        d=small(WORK,faults=['hold_permission_loss']);d.profile.update(feedback=[3,3],max_age=4)
        m=ReferenceModel(d);s1=next(m.successors(m.initial))[0]
        s2,events=next((s,events) for s,events in m.successors(s1) if s['faults_used']==1)
        self.assertTrue(any(e['kind']=='device_hold_failed' for e in events))
        self.assertEqual(s2['plant']['materials']['M1']['region'],'S.work')
        self.assertIsNone(s2['plant']['materials']['M1']['held_by'])

    def test_successors_do_not_mutate_parent_or_other_branches(self):
        m=ReferenceModel(small(WORK,nondeterministic=True));before=canonical(m.initial)
        nexts=list(m.successors(m.initial));self.assertEqual(canonical(m.initial),before)
        if len(nexts)>1:
            other=canonical(nexts[1][0]);nexts[0][0]['plant']['materials']['M1']['holder']='changed'
            self.assertEqual(canonical(nexts[1][0]),other)

    def test_stop_ack_loss_requires_isolation(self):
        d=small(WORK,faults=['missing_stop_confirmation']);d.profile['accept']=[2,2]
        for p in d.env['policies'].values():p['accept_ticks']=1
        m,g=self.graph(d)
        self.assertFalse(g['bad']);self.assertIn('attention_required',g['summary']['terminal_counts'])

    def test_actual_stop_after_attention_is_not_dropped(self):
        d=small(WORK,faults=['provider_restart']);d.profile['stop']=[4,4]
        for p in d.env['policies'].values():p['stop_ticks']=1
        m,g=self.graph(d)
        pending=[s for s in g['states'] if any(t['status']=='isolated' and t.get('hardware')=='stop' for t in s['tokens'].values())]
        self.assertTrue(pending);self.assertTrue(all(s['outcome']=='running' for s in pending))
        self.assertTrue(all(not any(t.get('hardware') for t in s['tokens'].values()) for s in g['states'] if s['outcome']!='running'))

    def test_response_deadline_not_satisfied_by_stopping(self):
        d=small(WORK);d.profile['response_window']=2
        m,g=self.graph(d);self.assertIn('V10b',g['bad'])

    def test_repeat_uses_distinct_activations(self):
        d=small(WORK);set_program(d,['repeat','loop','2',['delay','pause','0','s']])
        m,g=self.graph(d);last=g['states'][-1]
        self.assertIn('pause@0',last['tokens']);self.assertIn('pause@1',last['tokens'])

    def test_ordered_unknown_does_not_select_later_true(self):
        d=small(WORK);d.initial['external']={'x':{'value':True,'valid':False},'y':{'value':True,'valid':True}}
        d.env['observation_definitions']={'x':{'op':'external','key':'x'},'y':{'op':'external','key':'y'}}
        c=lambda name:['is',['observation','world',('string',name)],'true']
        set_program(d,['branch','choose','ordered',['timeout','0.05','s'],
             ['case',c('x'),['delay','first','0','s']],['case',c('y'),['delay','second','0','s']],['else',['delay','other','0','s']]])
        m,g=self.graph(d);self.assertFalse(g['goals']);self.assertTrue(all('second@' not in s['tokens'] for s in g['states']))

    def test_exclusive_conflict_fails(self):
        d=small(WORK);d.initial['external']={'yes':{'value':True,'valid':True}}
        d.env['observation_definitions']={'yes':{'op':'external','key':'yes'}}
        c=['is',['observation','world',('string','yes')],'true']
        set_program(d,['branch','choose','exclusive',['timeout','0.05','s'],
             ['case',c,['delay','first','0','s']],['case',c,['delay','second','0','s']],['else',['delay','other','0','s']]])
        m,g=self.graph(d);self.assertFalse(g['goals']);self.assertIn('exclusive_conflict',g['states'][-1]['abort'])

    def test_declared_event_changes_unknown_guard(self):
        d=small(WORK);d.initial['external']={'ready':{'value':False,'valid':True,'provider_epoch':0,'sample_tick':0}}
        d.env['observation_definitions']={'ready':{'op':'external','key':'ready'}}
        d.profile['events']=[{'tick':3,'kind':'set_external','fact':'ready','value':True,'valid':True,'provider_epoch':0}]
        set_program(d,['await','wait',['is',['observation','world',('string','ready')],'true'],['timeout','1','s']])
        m,g=self.graph(d);self.assertTrue(g['goals']);self.assertEqual(g['states'][-1]['tick'],3)

    def test_short_bound_and_state_limit_do_not_claim_closure(self):
        m=ReferenceModel(small(WORK));a=enumerate_model(m,bound=2,seconds=5);b=enumerate_model(m,bound=128,max_states=2,seconds=5)
        self.assertFalse(a['summary']['finite_model_closed']);self.assertTrue(a['summary']['horizon_reached'])
        self.assertFalse(b['summary']['finite_model_closed']);self.assertEqual(b['summary']['limit'],'STATE_LIMIT')

    def test_replay_rejects_modified_packet_or_state(self):
        m,g=self.graph(small(WORK));w=trace(m,g,g['goals'][0]);w=copy.deepcopy(w)
        w['steps'][2]['state']['plant']['materials']['M1']['holder']='R2'
        with self.assertRaises(ValueError):replay(m,w)

    def test_unknown_constructs_faults_and_missing_initial_state_rejected(self):
        d=small(WORK);d.profile['faults']=['undeclared_magic']
        with self.assertRaises(Unsupported):ReferenceModel(d)
        d=small(WORK);del d.initial['device_states']['R1']['permit']
        with self.assertRaises(Unsupported):ReferenceModel(d)
        d=small(WORK);d.env['observation_definitions']={'bad':{'op':'invented_success'}}
        with self.assertRaises(Unsupported):ReferenceModel(d)
        d=small(WORK);d.execution['step_seconds']['denominator']=100
        with self.assertRaises(Unsupported):ReferenceModel(d)

    def test_reference_package_has_no_tested_imports(self):
        for path in (BASE/'reference').glob('*.py'):
            for node in ast.walk(ast.parse(path.read_text(encoding='utf8'))):
                modules=[a.name for a in node.names] if isinstance(node,ast.Import) else [node.module or ''] if isinstance(node,ast.ImportFrom) else []
                self.assertFalse(any(m=='acverify' or m.startswith('acverify.') for m in modules),path)

    def test_channel_matches_independent_scalar_oracle(self):
        for cfg in channel_fixtures():
            d=small(WORK);d.profile.update(feedback=cfg['delay'],max_age=cfg['max_age'])
            m=ReferenceModel(d);start=copy.deepcopy(m.initial);t=start['tokens']['load@']
            kind=cfg['kind'];t['status']={'accepted':'waiting_accept','result':'executing','stop':'stopping'}[kind]
            if kind=='result':t['receipts']['accepted']={'packet':{},'observed':0};t['accepted_at']=0
            if cfg['suppress']:start['lost_stop'].append('load@')
            states={canonical(start):(start,0)}
            for tick in range(1,cfg['horizon']+1):
                following={}
                for state,observed in states.values():
                    if observed:following['observed'+str(observed)]=(state,observed);continue
                    s=copy.deepcopy(state);s['tick']=tick;channel.deliver(d,s,[])
                    got=s['tokens']['load@']['receipts']
                    received=('accepted' in got) if kind=='accepted' else s['tokens']['load@'].get('result_confirmed',False) if kind=='result' else 'stop' in got
                    if received:following['observed'+str(tick)]=(s,tick);continue
                    if tick==cfg['ready_tick']:channel.emit(d,s,'load@',kind)
                    before=len(s['mail'])
                    for nxt,_ in channel.sample(d,s,[]):
                        if not cfg['identity_valid']:
                            for p in nxt['mail'][before:]:p['activation']='old:'+p['activation']
                        following[canonical(nxt)]=(nxt,0)
                states=following
            self.assertEqual(sorted({v for _,v in states.values()}),enumerate_channel(cfg)['observed_ticks'],cfg['id'])


if __name__=='__main__':unittest.main()
