"""Integrity checks for an admitted P4 package, separate from rule diagnostics."""
from collections import Counter
import json
import os
from pathlib import Path
import sys
import unittest

BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BASE))
from certification.io import read, sha

WORK = Path(os.environ.get('ACVERIFY_WORKSPACE', str(BASE)))
PACKAGE = Path(os.environ.get('ACVERIFY_P4_PACKAGE', str(WORK / 'datasets/ac-path-v1/oracle/whole-line-p4-v1')))


@unittest.skipUnless(PACKAGE.exists(), 'No admitted P4 package at configured path')
class PackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.queries = read(PACKAGE / 'query-registry.json')['queries']
        cls.rows = [json.loads(line) for line in (PACKAGE / 'answers.jsonl').read_text(encoding='utf8').splitlines()]
        cls.by_id = {r['query_id']: r for r in cls.rows}

    def test_complete_manifest_and_pinned_sources(self):
        manifest = read(PACKAGE / 'manifest.json')
        for name, expected in manifest['files'].items():
            path = (PACKAGE / name).resolve()
            self.assertTrue(path.is_relative_to(PACKAGE.resolve()))
            self.assertEqual(sha(path), expected, name)
        for name, expected in manifest['source_hashes'].items():
            self.assertEqual(sha(BASE / name), expected, name)

    def test_query_identity_and_original_labels_preserved(self):
        self.assertEqual(len(self.queries), len({q['query_id'] for q in self.queries}))
        self.assertEqual({q['query_id'] for q in self.queries}, set(self.by_id))
        oldroot = WORK / 'datasets/ac-path-v1/oracle/whole-line-p3-v1'
        oldqueries = read(oldroot / 'query-registry.json')['queries']
        now = {q['query_id']: q for q in self.queries}
        for query in oldqueries:
            self.assertEqual(query, now[query['query_id']])
        for line in (oldroot / 'answers.jsonl').read_text(encoding='utf8').splitlines():
            row = json.loads(line)
            if row['truth_status'] == 'CERTIFIED':
                self.assertEqual(row['verdict'], self.by_id[row['query_id']]['verdict'])
        self.assertTrue(all(r['sut_comparison_eligible'] is False for r in self.rows))

    def test_counts_view_and_open_obligations(self):
        summary = read(PACKAGE / 'summary.json')
        self.assertEqual(summary['counts'], dict(Counter(r['truth_status'] for r in self.rows)))
        view = read(PACKAGE / 'benchmark-view.json')
        self.assertTrue(view['scope_changed'])
        self.assertTrue(view['SUT_alignment_required'])
        self.assertEqual(view['counts'], dict(Counter(self.by_id[q]['truth_status'] for q in view['query_ids'])))
        for replacement in view['replacements']:
            old = self.by_id[replacement['original_query_id']]
            new = self.by_id[replacement['extended_query_id']]
            self.assertEqual(old['unresolved_reason'], 'NO_FULL_RESPONSE_WINDOW')
            self.assertEqual(old['query_set'], 'original')
            self.assertEqual(new['query_set'], 'extended_response')
            self.assertEqual(old['case_id'], new['case_id'])
            self.assertEqual(old['bound_ticks'], new['bound_ticks'])
        remaining = read(PACKAGE / 'remaining-obligations.json')
        self.assertEqual({r['query_id'] for r in remaining['queries']},
                         {r['query_id'] for r in self.rows if r['truth_status'] == 'UNRESOLVED'})
        self.assertEqual({r['query_id'] for r in remaining['nonvacuity_queries']},
                         {r['query_id'] for r in self.rows if r['truth_status'] == 'CERTIFIED' and r['vacuous'] is None})


if __name__ == '__main__':
    unittest.main()
