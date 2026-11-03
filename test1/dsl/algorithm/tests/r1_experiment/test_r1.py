import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

BASE=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(BASE),str(BASE/'src'),str(BASE/'.deps')]
from r1_experiment.instrument import observe
from r1_experiment.runner import memory_info,source_pins
from alignment_p52.models import fixture
from acverify_v3.search import explore
from acverify_v3 import pipeline
from acverify_v3.core import canonical
from acverify_v3.query import validate


def query(model,pid='V10a',k=64):
    return dict(query_id=pid+str(k),property_id=pid,case_id=model.data['descriptor']['case_id'],
                profile=model.profile['id'],applicability='APPLICABLE',bound_ticks=k,checked_until=k)

class R1Tests(unittest.TestCase):
    def test_profile_preserves_closed_graph_and_verdicts(self):
        plain,_=fixture(BASE,single=True)
        qs=[query(plain),query(plain,'V09')]
        a=explore(plain,qs,seconds=20,state_limit=2000,keep_edges=True)
        with tempfile.TemporaryDirectory() as tmp:
            with observe(Path(tmp)/'test.prof') as telemetry:
                observed,_=fixture(BASE,single=True)
                b=pipeline.explore(observed,qs,seconds=20,state_limit=2000,keep_edges=True)
        self.assertTrue(a['statistics']['finite_model_closed'])
        self.assertTrue(b['statistics']['finite_model_closed'])
        self.assertEqual(a['results'],b['results'])
        self.assertEqual([canonical(s) for s in a['states']],[canonical(s) for s in b['states']])
        self.assertEqual(a['edges'],b['edges'])
        self.assertGreater(telemetry['branches']['successors_yields'],0)
        self.assertTrue(telemetry['functions'])
        self.assertGreater(telemetry['maxima']['frontier'],0)

    def test_profile_restores_hooks_after_exception(self):
        from acverify_v3.model import TransitionModel
        from acverify_v3 import search
        before=(TransitionModel.__init__,search.explore,pipeline.explore,search.observed,sys.gettrace())
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError,'probe'):
                with observe(Path(tmp)/'test.prof'):raise RuntimeError('probe')
        self.assertEqual(before,(TransitionModel.__init__,search.explore,pipeline.explore,search.observed,sys.gettrace()))

    def test_observation_cannot_change_original_digest(self):
        a,_=fixture(BASE,single=True)
        with tempfile.TemporaryDirectory() as tmp:
            with observe(Path(tmp)/'test.prof'):b,_=fixture(BASE,single=True)
        self.assertEqual(a.model_digest,b.model_digest)

    def test_state_limit_detail_and_witness_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            with observe(Path(tmp)/'test.prof') as telemetry:
                m,_=fixture(BASE,single=True)
                result=pipeline.explore(m,[query(m)],seconds=20,state_limit=2)
        self.assertEqual(result['statistics']['limit'],'STATE_OR_STORAGE_LIMIT')
        self.assertEqual(telemetry['search_limits'][0]['limit_detail'],'STATE_LIMIT')

    def test_group_queries_keep_existing_ids_and_validate(self):
        from final_p5.common import read
        data=read(BASE/'datasets/ac-path-v1/experiments/p5-final-v1/admission/queries.json')['records']
        from acverify_v3.pipeline import build
        m=build(BASE/'datasets/ac-path-v1/cases/S04-P01/case.json',BASE)
        qs=[q for q in data if q['case_id']=='S04-P01' and q['profile']=='nominal']
        for bound in sorted({q['bound_ticks'] for q in qs}):
            subset=[q for q in qs if q['bound_ticks']==bound]
            validate(m,subset)
            self.assertTrue(all(q['query_id'] in {r['query_id'] for r in qs} for q in subset))

    def test_worker_denies_gold_reads(self):
        import subprocess
        command=[sys.executable,'-B','-c',
                 "from final_p5.worker import deny_gold_reads; from pathlib import Path; deny_gold_reads('.'); Path('gold.jsonl').read_bytes()"]
        p=subprocess.run(command,cwd=BASE,capture_output=True)
        self.assertNotEqual(p.returncode,0)
        self.assertIn(b'cannot read reference labels',p.stderr)

if __name__=='__main__':unittest.main()
