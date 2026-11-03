import os
from pathlib import Path
import sys
import unittest

BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE))
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE','E:/project/AgenticComponents/test1/dsl/algorithm'))
AUDIT=Path(os.environ.get('ACVERIFY_P5_AUDIT',str(WORK/'artifacts/reference-p5/alignment-v2')))
from alignment_p5.io import read,verify_files,sources,digest
from alignment_p5.gate import assert_comparable


@unittest.skipUnless((AUDIT/'manifest.json').exists(),'No frozen P5.1 audit at configured path')
class AuditPackageTests(unittest.TestCase):
    def test_package_and_auditor_source_freeze(self):
        manifest=read(AUDIT/'manifest.json');verify_files(AUDIT,manifest['files'])
        plan=read(AUDIT/'plan.json');verify_files(BASE,plan['audit_sources'])
        self.assertEqual(plan['source_hashes'],sources(WORK))

    def test_full_scope_and_no_accuracy_claim(self):
        summary=read(AUDIT/'summary.json');scope=read(AUDIT/'evaluation-scope.json')
        self.assertEqual(summary['model_groups'],1080)
        self.assertEqual(summary['binding_statuses'],{'INPUT_PROJECTION_MATCH':1080})
        self.assertEqual(summary['trace_statuses'],{'MATCHED_TERMINAL_PROJECTION':24})
        self.assertEqual(summary['diagnostic_statuses'],{'DIFFERENT':10})
        self.assertEqual(len(scope['records']),27495)
        self.assertEqual(digest(scope['records']),scope['records_digest'])
        self.assertFalse(summary['eligible_for_accuracy']);self.assertFalse(summary['p5_complete'])
        self.assertFalse(read(AUDIT/'manifest.json')['accuracy_run_performed'])

    def test_matching_normal_traces_cannot_open_semantic_gate(self):
        gate=read(AUDIT/'gate.json')
        self.assertEqual(gate['status'],'NOT_COMPARABLE')
        self.assertEqual(len(gate['unresolved_issues']),10)
        with self.assertRaisesRegex(ValueError,'semantic admission incomplete'):
            assert_comparable(WORK,AUDIT)


if __name__=='__main__':unittest.main()
