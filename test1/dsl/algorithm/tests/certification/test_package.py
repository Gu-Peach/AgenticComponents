import json
import os
from pathlib import Path
import sys
import unittest
from collections import Counter

BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE))
ROOT=Path(os.environ.get('AC_P3_TRUTH',str(BASE/'datasets/ac-path-v1/oracle/whole-line-p3-v1')))
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE',str(BASE)))
from certification.io import read,sha


class PackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows=[json.loads(line) for line in (ROOT/'answers.jsonl').read_text(encoding='utf8').splitlines()]
        cls.queries=read(ROOT/'query-registry.json')['queries'];cls.summary=read(ROOT/'summary.json')
        cls.registry={q['query_id']:q for q in cls.queries};cls.checks=read(ROOT/'evidence-checks.json')

    def test_query_identity_and_source_coverage(self):
        old=read(WORK/'datasets/ac-path-v1/oracle/whole-line-v1/query-inventory.json')['queries']
        self.assertEqual(len(self.registry),len(old))
        self.assertEqual({q['source_query_id'] for q in self.queries},{q['query_id'] for q in old})
        self.assertFalse(set(self.registry)&{q['query_id'] for q in old})
        self.assertEqual({r['query_id'] for r in self.rows},set(self.registry))

    def test_all_claims_have_checked_model_bound_evidence(self):
        for r in self.rows:
            if r['truth_status']=='CERTIFIED':
                self.assertTrue(r['evidence_refs'])
                for path in r['evidence_refs']:
                    self.assertEqual(self.checks[path]['model_digest'],r['model_digest'])
                    self.assertIn(r['query_id'],{q['query_id'] for q in self.checks[path]['query_results']})
            else:self.assertIsNone(r['verdict'])

    def test_scope_is_not_implicitly_approved_for_SUT(self):
        if not self.summary['sut_alignment_complete']:
            self.assertTrue(all(r['sut_comparison_eligible'] is False for r in self.rows))
        for r in self.rows:
            q=self.registry[r['query_id']]
            self.assertEqual(r['bound_ticks'],q['bound_ticks'])
            self.assertEqual(r['model_digest'],q['model_digest'])

    def test_no_full_response_windows_remain_unresolved(self):
        for r in self.rows:
            if r['property_id']=='V10b' and r['covered_trigger_cutoff']<1:
                self.assertEqual(r['truth_status'],'UNRESOLVED')
                self.assertEqual(r['unresolved_reason'],'NO_FULL_RESPONSE_WINDOW')

    def test_summary_and_vacuity_denominators(self):
        self.assertEqual(dict(Counter(r['truth_status'] for r in self.rows)),self.summary['counts'])
        certified=[r for r in self.rows if r['truth_status']=='CERTIFIED']
        self.assertEqual(dict(Counter(str(r['vacuous']) for r in certified)),self.summary['vacuity'])
        self.assertEqual(sum(r['nonvacuous_reference_answer'] for r in self.rows),self.summary['nonvacuous_certified'])
        self.assertEqual(self.summary['whole_line_truth_complete'],all(r['truth_status'] in ('CERTIFIED','NOT_APPLICABLE') for r in self.rows))

    def test_manifest_file_integrity(self):
        m=read(ROOT/'manifest.json')
        for name,h in m['files'].items():self.assertEqual(sha(ROOT/name),h,name)
        for name,h in m['source_hashes'].items():self.assertEqual(sha(BASE/name),h,name)


if __name__=='__main__':unittest.main()
