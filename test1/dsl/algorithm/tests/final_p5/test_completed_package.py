import os
from pathlib import Path
import sys
import unittest
BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE))
from final_p5.common import read,read_rows,verify_files,sha
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE','E:/project/AgenticComponents/test1/dsl/algorithm'))
DATA=WORK/'datasets/ac-path-v1/experiments/p5-final-v1'
RUN=Path(os.environ.get('ACVERIFY_P54_RUN',str(DATA/'run')))
SCORES=Path(os.environ.get('ACVERIFY_P55_SCORES',str(DATA/'scores')))
AUDIT=Path(os.environ.get('ACVERIFY_P55_COMPLETION',str(DATA/'completion-audit')))


@unittest.skipUnless((AUDIT/'manifest.json').exists(),'Final P5 package not yet audited')
class CompletedPackageTests(unittest.TestCase):
    def test_complete_run_and_score_denominators(self):
        verify_files(RUN,read(RUN/'manifest.json')['files']);verify_files(SCORES,read(SCORES/'manifest.json')['files'])
        completed=read(RUN/'completion.json');summary=read(SCORES/'summary.json')
        self.assertTrue(completed['predictions_sealed']);self.assertEqual(completed['recorded'],4536)
        self.assertEqual(summary['primary_query_rows'],27495*3)
        for m,r in summary['full_by_method'].items():
            self.assertEqual(r['applicable'],26970);self.assertEqual(r['total'],27495)
            self.assertEqual(r['determinate'],r['counts'].get('correct',0)+r['counts'].get('incorrect',0))

    def test_completion_distinguishes_run_completion_from_deciding_every_query(self):
        verify_files(AUDIT,read(AUDIT/'manifest.json')['files']);state=read(AUDIT/'completion.json')
        self.assertTrue(state['all_required_checks_passed'])
        self.assertTrue(state['p53_complete'] and state['p54_complete'] and state['p55_complete'])
        self.assertTrue(state['all_jobs_finished']);self.assertTrue(state['admitted_evidence_valid'])
        self.assertTrue(state['selected_view_truth_complete']);self.assertEqual(state['original_window_obligations_retained'],1065)
        self.assertIn('all_algorithm_queries_decided',state)
        self.assertEqual(state['plc_comparison'],'NOT_CONFIGURED_CONDITIONAL_FUTURE_WORK')


if __name__=='__main__':unittest.main()
