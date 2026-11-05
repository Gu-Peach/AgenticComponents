import ast,copy,sys,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from declarative_frontend import compile_source,DeclarationError
from check_declarative import check_all,check_scene,read

class DeclarativeTests(unittest.TestCase):
 def setUp(self):
  p=ROOT/'processes/S04';self.text=(p/'process.py').read_text(encoding='utf-8');self.batch=read(p/'batch.json');self.binding=read(p/'bindings.json');self.task=read(p/'task-spec.json');self.contracts={p.stem:read(p) for p in (ROOT/'asset_contracts/assets').glob('*.json')};self.interfaces=read(ROOT/'declarative_dsl/interfaces.json')
 def check(self):return check_scene(compile_source(self.text),self.batch,self.binding,self.task,self.contracts,self.interfaces)
 def reject(self,text=None,pattern=None):
  if text is not None:self.text=text
  with self.assertRaises(DeclarationError):self.check()
 def test_all_twelve(self):
  results=check_all(ROOT);self.assertEqual(12,len(results));self.assertTrue(all(r['declaration_valid'] and not r['executable'] for r in results))
 def test_no_execution(self):
  with patch('builtins.exec',side_effect=AssertionError('executed')):compile_source(self.text)
 def test_no_async_functions(self):
  for p in (ROOT/'processes').glob('S*/process.py'):self.assertFalse(any(isinstance(n,(ast.AsyncFunctionDef,ast.FunctionDef,ast.Await)) for n in ast.walk(ast.parse(p.read_text(encoding='utf-8')))))
 def test_s01_has_true_parallel_branches(self):
  r=check_all(ROOT)[0];self.assertEqual(2,r['parallel_nodes'][0]['branches']);self.assertIn('proposed_capability:conveyor.advance_pitch',r['blockers'])
 def test_s09_shared_robot_explicit(self):
  r=check_all(ROOT)[8];self.assertIn('R1',r['parallel_nodes'][0]['shared_devices'])
 def test_s12_five_branches(self):self.assertEqual(5,check_all(ROOT)[11]['parallel_nodes'][0]['branches'])
 def test_nine_syntax_nodes(self):
  ir=compile_source((ROOT/'declarative_dsl/examples/control_nodes.pydsl').read_text(encoding='utf-8'));kinds=set()
  def walk(x):
   if isinstance(x,dict):
    if 'id'in x and 'kind'in x:kinds.add(x['kind'])
    for v in x.values():walk(v)
   elif isinstance(x,list):
    for v in x:walk(v)
  walk(ir);self.assertEqual({'seq','par','branch','repeat','invoke','await','delay','with-control','fail'},kinds)
 def test_import_rejected(self):self.reject('import os\n'+self.text)
 def test_assignment_rejected(self):self.reject('x=1\n'+self.text)
 def test_async_rejected(self):self.reject('async def main():\n    pass\n')
 def test_arbitrary_method_rejected(self):self.reject(self.text.replace("invoke(","R1.execute(",1))
 def test_loop_unbounded_rejected(self):self.reject(self.text.replace('limit=batch.material_count','limit=10001',1))
 def test_loop_limit_too_small(self):self.reject(self.text.replace('limit=batch.material_count','limit=1',1))
 def test_loop_boolean_rejected(self):self.reject(self.text.replace('limit=batch.material_count','limit=True',1))
 def test_variable_unknown(self):self.reject(self.text.replace('job.material','other.material',1))
 def test_wrong_unit(self):self.reject(self.text.replace('"m/s"','"rad"',1))
 def test_unknown_behavior(self):self.reject(self.text.replace("'transfer_material'","'teleport'",1))
 def test_unknown_fact(self):self.reject(self.text.replace("'material_at'","'invented'",1))
 def test_fact_arguments(self):self.reject(self.text.replace('location=job.input','wrong=job.input',1))
 def test_negative_timeout(self):self.reject(self.text.replace('seconds(30)','seconds(-1)',1))
 def test_zero_timeout(self):self.reject(self.text.replace('seconds(30)','seconds(0)',1))
 def test_overspeed(self):self.reject(self.text.replace('quantity(0.2,','quantity(99,',1))
 def test_batch_count(self):self.batch['material_count']+=1;self.reject()
 def test_independent_goal_ids(self):self.task['expected']['material_ids'].pop();self.reject()
 def test_wrong_acceptance_spec(self):self.reject(self.text.replace('"task-spec.json"','"made_up_success.json"'))
 def test_missing_otherwise(self):
  text='with process("S04", version="ac-declarative/0.1"):\n    with branch("b", mode="exclusive", timeout=seconds(1)):\n        with case(True):\n            fail("f", "E")\n'
  with self.assertRaises(DeclarationError):compile_source(text)
 def test_branch_unknown_mode(self):
  text=(ROOT/'processes/S05/process.py').read_text(encoding='utf-8').replace('"exclusive"','"guess"')
  with self.assertRaises(DeclarationError):compile_source(text)
 def test_undeclared_with_control_rejected(self):
  self.text='with process("S04", version="ac-declarative/0.1"):\n    with seq("root"):\n        with with_control("drive", C1, control="forward", setpoints={"speed": quantity(0.2,"m/s")}):\n            delay("d", seconds(1))\n        wait_for("goal", fact("batch_goal_satisfied", specification="task-spec.json"), timeout=seconds(30))\n';self.reject()
 def test_with_control_exit_definition_checked(self):
  self.text='with process("S04", version="ac-declarative/0.1"):\n    with seq("root"):\n        with with_control("drive", C1, control="forward", setpoints={"speed": quantity(0.2,"m/s")}):\n            delay("d", seconds(1))\n        wait_for("goal", fact("batch_goal_satisfied", specification="task-spec.json"), timeout=seconds(30))\n'
  self.binding['controls']={'C1.forward':{'writer_ports':['speed_setpoint'],'setpoint_bindings':{'speed':'speed_setpoint'},'enter_confirm':'running','sustaining':'permit','exit_setpoints':{'speed':{'value':0,'unit':'m/s'}},'exit_confirm':'stopped','delegates':[]}}
  self.assertIn('with-control',self.check()['operators']);del self.binding['controls']['C1.forward']['exit_confirm'];self.reject()
 def test_source_locations(self):self.assertIn('source',compile_source(self.text)['body'])

if __name__=='__main__':unittest.main()
