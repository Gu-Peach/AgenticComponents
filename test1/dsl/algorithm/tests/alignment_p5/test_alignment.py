import copy
from pathlib import Path
import os
import sys
import tempfile
import unittest

BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE))
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE','E:/project/AgenticComponents/test1/dsl/algorithm'))
from alignment_p5.models import pair,singleton,action_definitions,profile_definitions,node_shapes
from alignment_p5.projection import public_state,paired_trace,replay_pair,choose_step,differences
from alignment_p5.diagnostics import hold_trace,pending_stop_trace,component_probes
from alignment_p5.gate import admit,REQUIRED
from alignment_p5.io import verify_files,write,sha,read,digest,sources
from alignment_p5.scope import freeze_scope


class AlignmentTests(unittest.TestCase):
    def test_relative_workspace_has_the_same_source_freeze(self):
        expected=sources(WORK);previous=Path.cwd()
        try:
            os.chdir(WORK)
            self.assertEqual(sources(Path('.')),expected)
        finally:os.chdir(previous)

    def test_raw_inputs_bind_independently_to_same_initial_projection(self):
        sut,ref=pair(WORK,'S04-P01')
        for left,right in (action_definitions(sut,ref),profile_definitions(sut,ref),node_shapes(sut,ref)):
            self.assertEqual(left,right)
        self.assertEqual(public_state(sut.initial),public_state(ref.initial,True))

    def test_projection_preserves_physical_support_not_just_holder(self):
        sut,ref=pair(WORK,'S04-P01');s=copy.deepcopy(sut.initial)
        s['world']['materials']['M1']['support']='C1.entry'
        diff=differences(public_state(s),public_state(ref.initial,True))
        self.assertEqual(diff[0]['path'],'/materials/M1/support')

    def test_nominal_singleton_match_is_not_equivalence(self):
        sut,ref=singleton(WORK,'S04-P01',one_action=True)
        payload=paired_trace(sut,ref,50)
        self.assertEqual(payload['status'],'MATCHED_TERMINAL_PROJECTION')
        self.assertIn('not model equivalence',payload['scope'])
        replay_pair(sut,ref,payload)

    def test_hold_failure_before_acknowledgment_is_reachable_difference(self):
        p=hold_trace(WORK)
        self.assertEqual(p['status'],'DIFFERENT')
        self.assertEqual(p['trace']['first_difference_tick'],3)
        self.assertTrue(any(x['path']=='/materials/M1/held_by' for x in p['trace']['differences']))

    def test_pending_stop_must_not_close_root_early(self):
        p=pending_stop_trace(WORK)
        self.assertEqual(p['status'],'DIFFERENT')
        self.assertIn(dict(path='/outcome',sut='attention_required',reference='running'),p['trace']['differences'])

    def test_counterexample_replay_rejects_modified_state(self):
        sut,ref=singleton(WORK,'S04-P01',one_action=True,feedback=3,fault='hold_permission_loss')
        p=paired_trace(sut,ref,30,2,'hold_permission_loss')
        p['steps'][-1]['sut']['world']['materials']['M1']['held_by']='invented'
        with self.assertRaises(ValueError):replay_pair(sut,ref,p)

    def test_counterexample_replay_rejects_false_difference_and_model(self):
        sut,ref=singleton(WORK,'S04-P01',one_action=True)
        p=paired_trace(sut,ref,50);bad=copy.deepcopy(p);bad['status']='DIVERGED'
        with self.assertRaises(ValueError):replay_pair(sut,ref,bad)
        bad=copy.deepcopy(p);bad['sut_model_digest']='different'
        with self.assertRaises(ValueError):replay_pair(sut,ref,bad)

    def test_trace_clock_metadata_cannot_fabricate_a_different_deadline(self):
        sut,ref=singleton(WORK,'S04-P01',one_action=True)
        p=paired_trace(sut,ref,50);p['steps'][1]['tick']=50
        with self.assertRaises(ValueError):replay_pair(sut,ref,p)

    def test_nondeterministic_successor_is_not_arbitrarily_coupled(self):
        sut,ref=pair(WORK,'S01-P01')
        state=ref.initial
        found=False
        for _ in range(30):
            try:state,_=choose_step(ref,state)
            except ValueError:found=True;break
        self.assertTrue(found)

    def test_monitor_probes_are_not_claimed_corpus_counterexamples(self):
        probes={p['id']:p for p in component_probes(WORK)}
        self.assertEqual(len(probes),8)
        self.assertTrue(all(p['status']=='DIFFERENT' for p in probes.values()))
        for name in ('D03-external-conflict','D04-handoff-clause','D05-stop-evidence-clause','D06-isolation-preservation','D07-unknown-observation','D08-response-tail-filter'):
            self.assertIn('not_claimed_reachable',probes[name]['scope'])
        packets=probes['D02-fault-packet-domain']
        self.assertEqual([p['sample_tick'] for p in packets['sut']],[1])
        self.assertEqual([p['sample_tick'] for p in packets['reference']],[1,2,3])

    def test_scope_keeps_legacy_obligations_and_changed_query_ids(self):
        scope=freeze_scope(WORK/'datasets/ac-path-v1/oracle/whole-line-p4-v1')
        self.assertEqual(scope['query_count'],27495)
        self.assertEqual(scope['replaced_window_count'],1065)
        self.assertEqual(len(scope['original_window_obligations']),1065)
        self.assertEqual(len(scope['nonvacuity_obligations']),1485)
        changed=[q for q in scope['records'] if q['query_scope_changed']]
        self.assertTrue(all(q['query_id']!=q['original_query_id'] for q in changed))
        self.assertEqual(digest(scope['records']),scope['records_digest'])
        self.assertTrue(all('verdict' not in q for q in scope['records']))
        self.assertTrue(all('verdict' not in q for q in scope['nonvacuity_obligations']))

    def test_scope_rejects_silent_query_omission(self):
        original=WORK/'datasets/ac-path-v1/oracle/whole-line-p4-v1'
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for name in ('query-registry.json','benchmark-view.json','remaining-obligations.json','manifest.json'):
                write(root/name,read(original/name))
            view=read(root/'benchmark-view.json');view['query_ids'].pop()
            write(root/'benchmark-view.json',view)
            with self.assertRaises(ValueError):freeze_scope(root)

    def test_gate_fails_on_missing_pending_or_failed_checks(self):
        self.assertFalse(admit({})['eligible_for_accuracy'])
        checks={k:dict(status='PASS') for k in REQUIRED}
        for status in ('PENDING','FAIL'):
            checks['transition_relation']['status']=status
            self.assertFalse(admit(checks)['eligible_for_accuracy'])
        checks['transition_relation']['status']='PASS'
        self.assertTrue(admit(checks)['eligible_for_accuracy'])

    def test_manifest_integrity_and_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);write(root/'input.json',dict(value=1))
            files={'input.json':sha(root/'input.json')};verify_files(root,files)
            write(root/'input.json',dict(value=2))
            with self.assertRaises(ValueError):verify_files(root,files)
            inside=root/'inside';inside.mkdir()
            with self.assertRaises(ValueError):verify_files(inside,{'../input.json':sha(root/'input.json')})


if __name__=='__main__':unittest.main()
