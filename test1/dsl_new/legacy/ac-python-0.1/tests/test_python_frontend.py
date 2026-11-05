import ast,copy,sys,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from python_frontend import compile_source,CompileError
from control_ir import from_tree,to_tree,semantic_form
from flow_syntax import parse
import check_batches

class PythonFrontendTests(unittest.TestCase):
    def setUp(self):self.text=(ROOT/'processes/S04/process.py').read_text(encoding='utf-8')
    def reject(self,text):
        with self.assertRaises(CompileError):compile_source(text,'test_process.py')
    def test_eleven_unchanged_semantic_migrations(self):
        for i in range(2,13):
            sid=f'S{i:02}';text=(ROOT/f'processes/{sid}/process.py').read_text(encoding='utf-8')
            ast.parse(text)
            compiled=compile_source(text)
            old=from_tree(parse((ROOT/f'legacy/ac-flow-0.2/{sid}/process.acp').read_text(encoding='utf-8')))
            self.assertEqual(semantic_form(old),semantic_form(compiled['ir']),sid)
            self.assertEqual(compiled['ir'],from_tree(to_tree(compiled['ir'])))
    def test_python_is_not_executed(self):
        with patch('builtins.exec',side_effect=AssertionError('User code executed')):
            self.assertTrue(compile_source(self.text)['source_map'])
    def test_source_map(self):
        d=compile_source(self.text,'S04/process.py');self.assertEqual(6,len(d['source_map']))
        for span in d['source_map'].values():
            self.assertEqual('S04/process.py',span['file']);self.assertIn('await ',self.text.splitlines()[span['line']-1]);self.assertEqual(['main','handle_job_1'],span['call_stack'])
    def test_reject_import(self):self.reject('import os\n'+self.text)
    def test_reject_assignment(self):self.reject(self.text.replace('    await parallel_for','    x = 1\n    await parallel_for'))
    def test_reject_missing_await(self):self.reject(self.text.replace('await R1.transfer_material','R1.transfer_material',1))
    def test_reject_while(self):self.reject(self.text.replace('    await parallel_for','    while True:\n        pass\n    await parallel_for'))
    def test_reject_arbitrary_expression(self):self.reject(self.text.replace('quantity(0.2,','quantity(1 + 2,',1))
    def test_reject_exec(self):self.reject(self.text.replace("await verify('batch_goal')","await exec('print(123)')"))
    def test_reject_private_attribute(self):self.reject(self.text.replace('job.material','job.__class__',1))
    def test_reject_star_args(self):self.reject(self.text.replace('resources(C2)','resources(*batch.jobs)',1))
    def test_reject_kw_unpack(self):self.reject(self.text.replace('material=job.material','**job',1))
    def test_reject_boolean_concurrency(self):self.reject(self.text.replace('max_active=2','max_active=True'))
    def test_reject_unbounded_parallel(self):self.reject(self.text.replace('max_active=2','max_active=0'))
    def test_reject_timeout_without_unit(self):self.reject(self.text.replace('timeout=ticks(1800)','timeout=1800',1))
    def test_reject_default_worker_argument(self):self.reject(self.text.replace('handle_job_1(job):','handle_job_1(job=None):'))
    def test_reject_unknown_decorator(self):self.reject(self.text.replace('@process(', '@anything('))
    def test_reject_unused_function(self):self.reject(self.text+'\nasync def unused():\n    await verify("batch_goal")\n')
    def test_reject_recursive_worker(self):
        self.reject('async def worker(job):\n    await worker(job)\n\n@process(version="ac-python/0.1", scene="S01")\nasync def main():\n    await parallel_for(batch.jobs, worker, max_active=2)\n    await verify("batch_goal")\n')
    def test_reject_comprehension(self):self.reject(self.text.replace('parallel_for(batch.jobs,','parallel_for([j for j in batch.jobs],'))
    def test_line_diagnostic(self):
        with self.assertRaisesRegex(CompileError,r'bad.py:1:1:'):
            compile_source('import os','bad.py')
    def test_invalid_python(self):self.reject('async def main(:')
    def test_python_edits_reach_semantic_checker(self):
        text=self.text.replace('quantity(0.2,','quantity(99,',1);compiled=compile_source(text);p=ROOT/'processes/S04'
        contracts={f.stem:check_batches.read(f) for f in (ROOT/'asset_contracts/assets').glob('*.json')}
        with self.assertRaisesRegex(ValueError,'前置条件'):
            check_batches.check_tree(to_tree(compiled['ir']),check_batches.read(p/'batch.json'),check_batches.read(p/'bindings.json'),check_batches.read(p/'task-spec.json'),contracts)
    def test_primary_catalog_sources(self):
        for e in check_batches.read(ROOT/'process-catalog.json')['scenes']:
            self.assertEqual('process.py',e['source']);self.assertFalse((ROOT/e['path']/'process.acp').exists())
    def test_s02_is_dynamic_cell_worker(self):
        result=compile_source((ROOT/'processes/S02/process.py').read_text(encoding='utf-8'))['ir']
        dispatch=result['body']['children'][0]
        self.assertEqual('dispatch-waves',dispatch['kind']);self.assertEqual('fifo-first-reachable-idle',dispatch['policy'])

if __name__=='__main__':unittest.main()
