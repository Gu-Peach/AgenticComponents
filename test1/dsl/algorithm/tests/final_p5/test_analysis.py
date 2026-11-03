import copy
from pathlib import Path
import sys
import unittest
BASE=Path(__file__).resolve().parents[2];sys.path.insert(0,str(BASE))
from final_p5.common import setup,read
from final_p5.efficiency import paired_ratio,median
from final_p5.witness_audit import map_to_reference
WORK=setup('E:/project/AgenticComponents/test1/dsl/algorithm')


class AnalysisTests(unittest.TestCase):
    def functional_witness(self):
        from alignment_p52.models import pair
        from acverify_v3.search import explore,witness
        sut,ref=pair(WORK,'S10-P03-DV04','nominal')
        records=read(WORK/'artifacts/reference-p5/alignment-v2/evaluation-scope.json')['records']
        q=next(q for q in records if q['case_id']=='S10-P03-DV04' and q['profile']=='nominal' and q['property_id']=='V09')
        graph=explore(sut,[q],seconds=2)
        return sut,ref,witness(sut,graph,graph['witnesses'][q['query_id']])

    def test_paired_ratio_uses_scene_clusters_and_preserves_direction(self):
        pairs=[]
        for scene in ('S01','S02','S03'):
            for rep in range(3):
                a=dict(scene=scene,parent=scene+'-P01',search_seconds=2)
                b=dict(scene=scene,parent=scene+'-P01',search_seconds=1)
                pairs.append((a,b))
        result=paired_ratio(pairs,'search_seconds')
        self.assertAlmostEqual(result['ratio'],.5);self.assertEqual(result['scene_clusters'],3)
        self.assertEqual(result['paired_jobs'],9);self.assertEqual(result['ci95'],[.5,.5])

    def test_no_pairs_or_insufficient_clusters_do_not_fabricate_intervals(self):
        self.assertIsNone(paired_ratio([],'search_seconds')['ratio'])
        a=dict(scene='S01',parent='P',search_seconds=1)
        result=paired_ratio([(a,a)],'search_seconds')
        self.assertEqual(result['ratio'],1);self.assertIsNone(result['ci95'])
        self.assertIsNone(median([None]))

    def test_native_positive_witness_maps_to_reference_history(self):
        # Functional query only; no formal predictions or reference labels read.
        sut,ref,payload=self.functional_witness()
        mapped,receipt=map_to_reference(sut,ref,payload)
        self.assertEqual(len(mapped['steps']),len(payload['steps']))
        self.assertEqual(receipt['native']['checked_steps'],len(payload['steps']))

    def test_history_corruption_fails_native_or_reference_replay(self):
        sut,ref,payload=self.functional_witness()
        payload=copy.deepcopy(payload);payload['steps'][-1]['state']['trigger_ticks']['V09']=-1
        with self.assertRaises(ValueError):map_to_reference(sut,ref,payload)


if __name__=='__main__':unittest.main()
