import ast
import copy
from pathlib import Path
import unittest
from build_standard_answers import Case,RefError,parse,logical_proofs
from sequential_reference import SequentialReference,profile_for,certify

DATA=Path(r'E:\project\AgenticComponents\test1\dsl\algorithm\datasets\ac-path-v1')

class ReferenceTests(unittest.TestCase):
    def test_separate_parser(self):
        self.assertEqual(parse('; note\n(a "b;c" (d))'),['a',('string','b;c'),['d']])
        with self.assertRaises(RefError):parse('(a (b)')
    def test_static_error_categories(self):
        for suffix,code in [('DS01','INVALID_SYNTAX'),('DS02','INVALID_TYPE'),('DS03','UNKNOWN_CAPABILITY')]:
            with self.assertRaises(RefError) as e:Case(DATA,'S07-P01-'+suffix)
            self.assertEqual(e.exception.code,code)
    def test_guard_entailment(self):
        c=Case(DATA,'S01-P01');self.assertEqual(logical_proofs(c)['V09']['verdict'],'HOLDS')
    def test_immutable_initial_gate(self):
        c=Case(DATA,'S01-P01-DV01');p=logical_proofs(c)
        self.assertEqual(p['V10a']['verdict'],'UNREACHABLE');self.assertTrue(p['V10b']['vacuous'])
    def test_impossible_final_evidence(self):
        c=Case(DATA,'S01-P01-DV02');self.assertEqual(logical_proofs(c)['V10a']['rule'],'mandatory_final_guard_is_contradictory')
    def test_success_prefix_wrong_source(self):
        c=Case(DATA,'S04-P01-DV01');self.assertEqual(logical_proofs(c)['V10a']['rule'],'successful_prefix_contradicts_next_source')
    def test_goal_is_independent(self):
        c=Case(DATA,'S01-P01');c.task=copy.deepcopy(c.task)
        c.task['goal']['args'][0]['location']='P1.slot4'
        self.assertNotIn('V09',logical_proofs(c))
    def test_no_suffix_based_proof(self):
        c=Case(DATA,'S01-P01-DV01');p=logical_proofs(c);c.id='completely_unrelated_name'
        self.assertEqual(p,logical_proofs(c))
    def test_healthy_reference(self):
        c=Case(DATA,'S04-P01');w=SequentialReference(c,profile_for(c,'nominal')).run()
        self.assertTrue(w['independent_goal']);self.assertTrue(certify(c,w)['verified']);self.assertLess(w['completion_tick'],256)
    def test_false_success_reference(self):
        c=Case(DATA,'S04-P01-DV04');w=SequentialReference(c,profile_for(c,'nominal')).run()
        self.assertFalse(w['independent_goal']);self.assertTrue(certify(c,w)['verified'])
    def test_timing_tamper_rejected(self):
        c=Case(DATA,'S04-P01');w=SequentialReference(c,profile_for(c,'nominal')).run()
        phase=next(e for e in w['events'] if e['kind']=='phase');phase['tick']=-1
        with self.assertRaises(RefError):certify(c,w)
    def test_parallel_not_silently_serialized(self):
        c=Case(DATA,'S12-P03')
        with self.assertRaises(RefError):SequentialReference(c,profile_for(c,'nominal@0.1')).run()
    def test_no_tested_engine_imports(self):
        for name in ['build_standard_answers.py','sequential_reference.py']:
            tree=ast.parse((Path(__file__).parent/name).read_text(encoding='utf-8'))
            for node in ast.walk(tree):
                if isinstance(node,ast.Import):modules=[n.name for n in node.names]
                elif isinstance(node,ast.ImportFrom):modules=[node.module or '']
                else:continue
                self.assertFalse(any('acverify' in m or 'pilot_model' in m or 'validate_corpus' in m for m in modules))

if __name__=='__main__':unittest.main()
