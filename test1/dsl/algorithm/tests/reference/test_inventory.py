import ast
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest

BASE=Path(__file__).resolve().parents[2]
ROOT=Path(os.environ.get('AC_REFERENCE_INVENTORY',str(BASE/'datasets/ac-path-v1/oracle/whole-line-v1')))
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE',str(BASE)))
sys.path.insert(0,str(BASE))


def read(p):return json.loads(Path(p).read_text(encoding='utf8'))
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class InventoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inventory=read(ROOT/'query-inventory.json');cls.rows=cls.inventory['queries']
        cls.ext=read(ROOT/'proposed-query-extensions.json')['queries']

    def test_all_legacy_query_keys_preserved(self):
        old=read(WORK/'experiments/method1-v3/coverage.json')['records']
        expected={(r['case_id'],r['profile'],r['bound'],r['property']) for r in old}
        current={(r['case_id'],r['profile'],r['bound_ticks'],r['property_id']) for r in self.rows}
        self.assertEqual(current,expected);self.assertEqual(len(self.rows),27495)

    def test_no_duplicates_no_answers(self):
        self.assertEqual(len({r['query_id'] for r in self.rows}),len(self.rows))
        self.assertTrue(all(r['verdict'] is None and r['truth_status']=='NOT_CONSTRUCTED' for r in self.rows))
        self.assertTrue(all(r['trigger_reachability']=='UNKNOWN_NOT_SEARCHED' and r['vacuous'] is None for r in self.rows))

    def test_extensions_have_new_scope_and_identity(self):
        self.assertEqual(len(self.ext),2485)
        self.assertFalse({r['query_id'] for r in self.ext}&{r['query_id'] for r in self.rows})
        for row in self.ext:
            self.assertEqual(row['checked_until'],row['bound_ticks']+row['response_window_ticks'])
            self.assertEqual(row['trigger_horizon'],row['bound_ticks'])
            self.assertEqual(row['readiness'],'PROPOSED_REQUIRES_P2_ENVIRONMENT_EXTENSION')

    def test_removed_calls_preserve_applicability(self):
        risks=[r for r in self.rows if r['vacuity_risk']]
        self.assertEqual(len(risks),217)
        self.assertTrue(all(r['applicability']=='APPLICABLE' for r in risks))
        self.assertEqual(sum(r['applicability']=='NOT_APPLICABLE' for r in self.rows),525)

    def test_pilot_mapping_not_implicitly_admitted(self):
        blocked=[r for r in self.rows if r['readiness']=='BLOCKED_MAPPING']
        self.assertEqual(len(blocked),160)
        self.assertTrue(all('P1-PILOT-TIMING-BRIDGE' in r['blocking_issues'] for r in blocked))
        self.assertTrue(all(r['property_id'] not in ('V02','V03','V10b') for r in blocked))

    def test_short_response_window_is_explicit(self):
        short=[r for r in self.rows if r.get('full_response_window_possible') is False]
        self.assertEqual(len(short),1065)
        self.assertTrue(all(r['bound_ticks']<r['response_window_ticks'] for r in short))

    def test_manifest_hashes_and_no_input_drift(self):
        m=read(ROOT/'manifest.json')
        for name,h in m['files'].items():self.assertEqual(sha(ROOT/name),h,name)
        for name,h in m['source_hashes'].items():self.assertEqual(sha(BASE/name),h,name)
        self.assertEqual(sha(WORK/'tools/build_standard_answers.py'),m['reference_parser_sha256'])
        self.assertFalse(self.inventory['metadata']['dependency_drifts'])

    def test_no_tested_verifier_import(self):
        for p in [BASE/'reference/properties.py',BASE/'tools/build_reference_inventory.py']:
            tree=ast.parse(p.read_text(encoding='utf8'))
            for node in ast.walk(tree):
                modules=[x.name for x in node.names] if isinstance(node,ast.Import) else [node.module or ''] if isinstance(node,ast.ImportFrom) else []
                self.assertFalse(any(m=='acverify' or m.startswith('acverify.') for m in modules),p)

    def test_property_catalog_complete_and_scope_explicit(self):
        spec=read(BASE/'reference/specs/property-spec.json')
        self.assertEqual({p['id'] for p in spec['properties']},{'V01','V02','V03','V04','V05','V06','V07','V08','V09','V10a','V10b'})
        for p in spec['properties']:
            self.assertTrue(p['formula']);self.assertTrue(p['executable']);self.assertTrue(p['observation_phase'])
        self.assertEqual(spec['pilot_legacy']['not_added'],['V02','V03','V10b'])


if __name__=='__main__':unittest.main()
