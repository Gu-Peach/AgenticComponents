import os
from pathlib import Path
import sys
import unittest
BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE))
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE','E:/project/AgenticComponents/test1/dsl/algorithm'))
AUDIT=Path(os.environ.get('ACVERIFY_P52_AUDIT',str(WORK/'artifacts/reference-p52/validation-v1')))
from alignment_p52.models import setup
setup(WORK)
from alignment_p5.io import read,verify_files,sources,sha


@unittest.skipUnless((AUDIT/'manifest.json').is_file(),'No frozen P5.2 audit at configured path')
class PackageTests(unittest.TestCase):
    def test_frozen_sources_and_evidence(self):
        m=read(AUDIT/'manifest.json');verify_files(AUDIT,m['files']);verify_files(BASE,m['source_hashes'])
        self.assertEqual(sources(WORK),m['legacy_source_hashes'])
        self.assertEqual(sha(WORK/'datasets/ac-path-v1/oracle/whole-line-p4-v1/manifest.json'),m['p4_manifest_sha256'])

    def test_validation_scope_and_remaining_review_are_explicit(self):
        s=read(AUDIT/'summary.json');g=read(AUDIT/'gate.json')
        self.assertEqual(s['models'],1080);self.assertEqual(s['query_bindings'],27495)
        self.assertEqual(s['input_statuses'],{'MATCH':1080});self.assertEqual(s['parent_cases'],72)
        self.assertEqual(sum(s['trace_statuses'].values()),144);self.assertNotIn('DIVERGED',s['trace_statuses'])
        self.assertEqual(s['probe_statuses'],{'MATCH':10});self.assertEqual(s['finite_statuses'],{'CLOSED_MATCH':20})
        self.assertEqual(s['diagnostic_queries'],660);self.assertEqual(s['finite_query_statuses'],{'MATCH':20})
        self.assertEqual(s['mutations_detected'],3);self.assertTrue(g['implementation_validated'])
        self.assertFalse(g['eligible_for_full_corpus_accuracy']);self.assertTrue(g['remaining'])

    def test_scope_was_not_reduced_or_scored_as_plc(self):
        p=read(AUDIT/'plan.json')
        old=read(WORK/'artifacts/reference-p5/alignment-v2/evaluation-scope.json')
        self.assertEqual(p['query_records_digest'],old['records_digest'])
        self.assertTrue(p['tests_do_not_score_original_queries'])
        self.assertEqual(read(AUDIT/'dependency-boundary.json')['status'],'PASS')


if __name__=='__main__':unittest.main()
