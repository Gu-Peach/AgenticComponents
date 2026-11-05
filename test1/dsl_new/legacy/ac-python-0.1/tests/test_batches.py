import copy,importlib.util,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
import check_batches as c
class BatchTests(unittest.TestCase):
 def load(self,sid='S04'):
  p=ROOT/'processes'/sid;self.text=(ROOT/'legacy/ac-flow-0.2'/sid/'process.acp').read_text(encoding='utf-8');self.batch=c.read(p/'batch.json');self.bind=c.read(p/'bindings.json');self.task=c.read(p/'task-spec.json');self.contracts={p.stem:c.read(p) for p in (ROOT/'asset_contracts/assets').glob('*.json')}
 def setUp(self):self.load()
 def check(self):return c.check_scene(self.text,self.batch,self.bind,self.task,self.contracts)
 def reject(self,fragment=None):
  if fragment:
   with self.assertRaisesRegex(ValueError,fragment):self.check()
  else:
   with self.assertRaises(ValueError):self.check()
 def test_all_scenes(self):self.assertEqual(12,len(c.check_all(ROOT)))
 def test_s02_batch(self):
  self.load('S02');r=self.check();self.assertEqual((6,24),(r['pallets'],r['materials']));self.assertIn('dispatch-waves',r['controls']);self.assertEqual(216,r['binding_checks'])
 def test_duplicate_material(self):self.batch['jobs'][1]['material']=self.batch['jobs'][0]['material'];self.reject('身份重复')
 def test_missing_job(self):self.batch['jobs'].pop();self.reject('独立物料')
 def test_bad_variable(self):self.text=self.text.replace('$job.material','$missing.material',1);self.reject('作用域')
 def test_bad_field(self):self.text=self.text.replace('$job.material','$job.absent',1);self.reject('字段不存在')
 def test_unbounded_parallel(self):self.text=self.text.replace('(parallel-for jobs job 2','(parallel-for jobs job 0',1);self.reject('并发上界')
 def test_units(self):self.text=self.text.replace('0.2 m/s','0.2 rad',1);self.reject('单位')
 def test_overspeed(self):self.text=self.text.replace('0.2 m/s','99 m/s',1);self.reject('前置条件')
 def test_disabled_gripper(self):self.bind['instances']['R1']['features']['gripper']=False;self.reject('能力未启用')
 def test_wrong_source(self):self.text=self.text.replace('(arg source $job.input)','(arg source C1.exit)',1);self.reject('源位置')
 def test_empty_inventory(self):self.batch['jobs']=[];self.reject()
 def test_missing_infeed(self):self.bind['environment_events']=[];self.reject('来料')
 def test_unknown_action(self):self.text=self.text.replace('transfer_material','teleport',1);self.reject('未知行为')
 def test_unclamp(self):self.load('S08');self.text=self.text.replace('unclamp','clamp',1);self.reject()
 def test_goal_destination(self):self.task['all'][0]['items'][0]['target']='impossible';self.reject('目标位置')
 def test_unknown_node(self):self.text=self.text.replace('(sequence','(forever',1);self.reject()
 def test_no_carrier_capability(self):self.load('S02');self.bind['instances']['C1']['features']['carrier_indexing']=False;self.reject('托盘输送能力')
 def test_duplicate_robot(self):self.load('S02');self.batch['cells'][1]['robot']='R1';self.reject('工位重复')
 def test_bad_alternative_cell(self):self.load('S02');self.batch['cells'][2]['output_entry']='not_here';self.reject('名义引用')
 def test_overfull_pallet(self):self.load('S02');self.bind['instances']['P01']['parameters']['slot_count']=1;self.reject('容量')
 def test_duplicate_slot(self):self.load('S02');self.batch['pallets'][0]['items'][1]['source']=self.batch['pallets'][0]['items'][0]['source'];self.reject('槽位')
 def test_source_nominal_type(self):self.text=self.text.replace('(arg source $job.input)','(arg source $job.material)',1);self.reject('名义引用')
 def test_retreat(self):self.load('S06');self.text=self.text.replace('(arg target R1.home)','(arg target T1.slot1)',1);self.reject('未退位')
 def test_protocol_only_completion_not_claimed(self):self.assertFalse(self.check()['runtime_ready'])
if __name__=='__main__':unittest.main()
