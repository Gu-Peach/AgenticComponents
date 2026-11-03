"""Negative checks for malformed symbolic inputs, not path-verification tests."""
import copy
import unittest
from pathlib import Path
from validate_foundation import load, validate, ValidationError


class FoundationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.documents=load(Path(__file__).resolve().parents[1]/'datasets/ac-path-v1')

    def changed(self):
        return copy.deepcopy(self.documents)

    def test_valid_foundation(self):
        report=validate(self.documents)
        self.assertEqual(report['scenes'],12)
        self.assertFalse(report['path_verification_performed'])

    def test_missing_contract(self):
        data=self.changed()
        data['scenes/S04/instances.json']['devices'][0]['contract_ref']='missing@1'
        with self.assertRaisesRegex(ValidationError,'missing contract'): validate(data)

    def test_unknown_transfer_endpoint(self):
        data=self.changed()
        data['scenes/S04/relations.json']['transfer_edges'][0]['target']='C9.entry'
        with self.assertRaisesRegex(ValidationError,'transfer endpoints'): validate(data)

    def test_parameter_nominal_type(self):
        data=self.changed()
        data['shared/verification-contracts/transfer.json']['parameters']['material']='location'
        with self.assertRaisesRegex(ValidationError,'typed argument'): validate(data)

    def test_unknown_effect(self):
        data=self.changed()
        data['shared/verification-contracts/transfer.json']['phases'][0]['effects'][0]['effect']='magic_success'
        with self.assertRaisesRegex(ValidationError,'unknown effect'): validate(data)

    def test_conflict_endpoint(self):
        data=self.changed()
        data['scenes/S04/relations.json']['resource_conflicts'].append(['C1.writer','missing.zone'])
        with self.assertRaisesRegex(ValidationError,'conflict reference'): validate(data)

    def test_wrong_drive_owner(self):
        data=self.changed()
        data['scenes/S04/relations.json']['transport_edges'][0]['requires_control']='C2.drive'
        with self.assertRaisesRegex(ValidationError,'wrong drive owner'): validate(data)

    def test_unknown_stop_keeps_isolation(self):
        data=self.changed()
        data['shared/verification-contracts/transfer.json']['failure_outcomes'][1]['retain_isolation']=False
        with self.assertRaisesRegex(ValidationError,'missing unknown isolation'): validate(data)


if __name__=='__main__': unittest.main()
