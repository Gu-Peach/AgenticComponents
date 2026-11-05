"""Regression checks for resource scopes and future runtime claims."""
import sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import check_batches as c
class FlowResourceTests(unittest.TestCase):
 def test_unknown_resource_rejected(self):
  p=ROOT/'processes/S04';text=(ROOT/'legacy/ac-flow-0.2/S04/process.acp').read_text(encoding='utf-8').replace('(R1 S C1)','(unknown_resource S C1)',1)
  with self.assertRaisesRegex(ValueError,'资源引用'):
   c.check_scene(text,c.read(p/'batch.json'),c.read(p/'bindings.json'),c.read(p/'task-spec.json'),{p.stem:c.read(p) for p in (ROOT/'asset_contracts/assets').glob('*.json')})
 def test_no_runtime_success_claim(self):
  self.assertTrue(all(not r['runtime_ready'] for r in c.check_all(ROOT)))
if __name__=='__main__':unittest.main()
