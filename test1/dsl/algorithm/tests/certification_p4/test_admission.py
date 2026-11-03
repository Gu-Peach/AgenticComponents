import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BASE))
spec = importlib.util.spec_from_file_location('p4_admission', BASE / 'tools/audit_reference_truth_p4.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
from certification.io import write, sha


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.query = dict(applicability='APPLICABLE', property_id='V03')
        self.proof = dict(verdict='HOLDS', vacuous=None, trigger_reachability='UNKNOWN',
                          evidence='proof', evidence_kind='p4_invariant/0.1')

    def test_trigger_witness_resolves_nonvacuity_without_proving_property(self):
        witness = dict(verdict=None, trigger_reachability='REACHABLE', evidence='trace')
        self.assertEqual(audit.decide(self.query, [witness])['truth_status'], 'UNRESOLVED')
        answer = audit.decide(self.query, [self.proof, witness])
        self.assertEqual(answer['truth_status'], 'CERTIFIED')
        self.assertIs(answer['vacuous'], False)
        self.assertEqual(answer['trigger_evidence_refs'], ['trace'])

    def test_no_trigger_evidence_is_not_false_vacuity(self):
        answer = audit.decide(self.query, [self.proof])
        self.assertIsNone(answer['vacuous'])
        self.assertEqual(answer['trigger_reachability'], 'UNKNOWN')

    def test_opposite_answers_and_false_unreachability_are_rejected(self):
        with self.assertRaises(ValueError):
            audit.decide(self.query, [self.proof, {**self.proof, 'verdict': 'VIOLATED'}])
        with self.assertRaises(ValueError):
            audit.decide(self.query, [{**self.proof, 'vacuous': True},
                         dict(verdict=None, trigger_reachability='REACHABLE', evidence='trace')])

    def test_short_response_window_remains_explicit(self):
        query = dict(applicability='APPLICABLE', property_id='V10b', covered_trigger_cutoff=-1)
        answer = audit.decide(query, [])
        self.assertEqual(answer['unresolved_reason'], 'NO_FULL_RESPONSE_WINDOW')
        self.assertIsNone(answer['verdict'])

    def test_package_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write(root / 'data.json', {'x': 1})
            write(root / 'manifest.json', {'files': {'data.json': sha(root / 'data.json')}})
            audit.verify_package(root)
            write(root / 'data.json', {'x': 2})
            with self.assertRaises(ValueError):
                audit.verify_package(root)

    def test_manifest_cannot_escape_package(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'package'
            root.mkdir()
            outside = Path(folder) / 'outside.json'
            write(outside, {'x': 1})
            write(root / 'manifest.json', {'files': {'../outside.json': sha(outside)}})
            with self.assertRaises(ValueError):
                audit.verify_package(root)


if __name__ == '__main__':
    unittest.main()
