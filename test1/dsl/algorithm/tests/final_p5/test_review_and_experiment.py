import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE))
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE','E:/project/AgenticComponents/test1/dsl/algorithm'))
REVIEW=Path(os.environ.get('ACVERIFY_P53_REVIEW',str(WORK/'datasets/ac-path-v1/experiments/p5-final-v1/admission')))
from final_p5.common import setup,read,write,sha,verify_files,seal,digest
setup(WORK)
from final_p5.review import domain,monitor_boundaries
from final_p5.trigger_review import trace
from final_p5.scoring import classify,metric


class ReviewTests(unittest.TestCase):
    def test_boundary_frame_products_match(self):
        result=monitor_boundaries(WORK)
        self.assertEqual(sum(result['counts'].values()),3144);self.assertFalse(result['mismatches'])

    def test_domain_rejects_unknown_command_not_a_corpus_case(self):
        from reference.frontend import load
        from reference.transition import ReferenceModel
        m=ReferenceModel(load(WORK,'S01-P01'));domain(m)
        m.initial['plant']['devices']['R1']['run_command']=None
        with self.assertRaises(ValueError):domain(m)

    def test_early_isolation_traces_are_legal_and_within_old_bound(self):
        from reference.frontend import load
        from reference.transition import ReferenceModel
        from certification_p4.quiet_wait import check_trace
        for profile,mode in [('fault','restart'),('delayed','all_max')]:
            m=ReferenceModel(load(WORK,'S01-P01',profile));payload,stats=trace(m,mode)
            checked=check_trace(m,payload)
            self.assertLess(checked['last_tick'],1000)
            self.assertIn('V08',payload['segments'][-1]['after']['triggered'])

    def test_seal_includes_nested_manifests_and_detects_tampering(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);write(root/'child/data.json',{'x':1});seal(root/'child');seal(root)
            manifest=read(root/'manifest.json');self.assertIn('child/manifest.json',manifest['files'])
            write(root/'child/manifest.json',{'files':{}})
            with self.assertRaises(ValueError):verify_files(root,manifest['files'])

    def test_gold_read_guard_is_installed_in_child_process(self):
        code="from final_p5.worker import deny_gold_reads; from pathlib import Path; deny_gold_reads(Path(%r)); Path(%r).read_bytes()" % (str(WORK),str(WORK/'datasets/ac-path-v1/oracle/whole-line-p4-v1/answers.jsonl'))
        p=subprocess.run([sys.executable,'-B','-X','utf8','-c',code],cwd=BASE,capture_output=True,text=True)
        self.assertNotEqual(p.returncode,0);self.assertIn('cannot read reference labels',p.stderr)

    def test_unknown_and_errors_do_not_count_as_correct_answers(self):
        gold=dict(truth_status='CERTIFIED',verdict='HOLDS')
        self.assertEqual(classify(gold,{'verdict':'UNKNOWN'},'COMPLETED'),'unknown')
        self.assertEqual(classify(gold,{'verdict':'VIOLATED'},'COMPLETED'),'incorrect')
        self.assertEqual(classify(gold,{'verdict':'HOLDS'},'WORKER_TIMEOUT'),'worker_timeout')
        self.assertEqual(classify(gold,{'verdict':'HOLDS'},'WORKER_ERROR'),'worker_error')
        self.assertEqual(classify({'truth_status':'NOT_APPLICABLE'},None,'WORKER_ERROR'),'not_applicable')

    def test_metric_denominators_and_empty_answer_set(self):
        outcomes=['correct','correct','incorrect','unknown','unknown','unknown','worker_timeout','not_applicable']
        rows=[dict(outcome=x,trigger_conflict=False,gold_vacuous=False) for x in outcomes]
        m=metric(rows);self.assertEqual(m['applicable'],7);self.assertAlmostEqual(m['solved_coverage'],3/7)
        self.assertAlmostEqual(m['answered_accuracy'],2/3);self.assertAlmostEqual(m['correct_fraction_of_all'],2/7)
        self.assertIsNone(metric([dict(outcome='unknown',trigger_conflict=False,gold_vacuous=None)])['answered_accuracy'])


@unittest.skipUnless((REVIEW/'manifest.json').exists(),'P5.3 admission not yet sealed')
class AdmissionTests(unittest.TestCase):
    def test_review_gate_and_gold_lineage(self):
        from final_p5.experiment import assert_admitted
        gate=assert_admitted(WORK,REVIEW);self.assertEqual(gate['status'],'ADMITTED_CONDITIONAL_REVIEW')
        result=read(REVIEW/'summary.json');self.assertEqual(result['queries'],27495)
        self.assertEqual(result['source_verdicts_changed'],0);self.assertEqual(result['reviewed_clauses'],12)
        self.assertEqual(result['truth_statuses'],{'CERTIFIED':26970,'NOT_APPLICABLE':525})
        self.assertGreater(result['trigger_unknown'],0)

    def test_plan_covers_all_groups_and_keeps_repeats_separate(self):
        from final_p5.experiment import make_plan
        from collections import Counter,defaultdict
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder)/'plan';plan=make_plan(WORK,REVIEW,out,BASE)
            self.assertEqual(Counter(j['role'] for j in plan['jobs']),{'full':3240,'repeated':1296})
            self.assertEqual(len(plan['selected_repeated_cases']),24)
            self.assertEqual(len({s['parent'] for s in plan['selected_repeated_cases']}),24)
            self.assertEqual(Counter(s['scene'] for s in plan['selected_repeated_cases']),{f'S{i:02}':2 for i in range(1,13)})
            for i in range(0,len(plan['jobs']),3):
                block=plan['jobs'][i:i+3]
                self.assertEqual({j['method'] for j in block},{'none','storage','portfolio'})
                self.assertEqual(len({(j['case_id'],j['profile'],j['seconds'],j['repeat'],j['role']) for j in block}),1)
            self.assertEqual(make_plan(WORK,REVIEW,out,BASE),plan)


if __name__=='__main__':unittest.main()
