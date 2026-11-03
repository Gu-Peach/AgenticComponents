import copy
import os
from pathlib import Path
import sys
import unittest

BASE=Path(__file__).resolve().parents[2];sys.path[:0]=[str(BASE),str(BASE/'tools')]
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE',str(BASE)))
from reference.fixtures import small
from reference.transition import ReferenceModel
from reference.enumerate import enumerate_model
from check_reference_graphs import check_graph


class GraphEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        m=ReferenceModel(small(WORK));g=enumerate_model(m,bound=128,seconds=10,retain_edges=True)
        cls.payload={'definition':m.d.__dict__,'model_digest':m.model_digest,'states':g['states'],'edges':g['edges']}

    def test_complete_graph_checks(self):self.assertTrue(check_graph(self.payload)['checked'])

    def test_deleted_edge_is_not_a_closed_graph(self):
        p=copy.deepcopy(self.payload);p['edges'].pop()
        with self.assertRaises(ValueError):check_graph(p)

    def test_wrong_destination_is_rejected(self):
        p=copy.deepcopy(self.payload);p['edges'][0]['to']=0
        with self.assertRaises(ValueError):check_graph(p)

    def test_changed_definition_invalidates_model_identity(self):
        p=copy.deepcopy(self.payload);p['definition']['profile']['max_age']+=1
        with self.assertRaises(ValueError):check_graph(p)


if __name__=='__main__':unittest.main()
