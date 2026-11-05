"""The production manifest supplies inventory, while DSL composes operations."""
import json,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from python_frontend import compile_source,CompileError
from control_ir import to_tree,from_tree,semantic_form
from flow_syntax import parse
import check_batches as c

class S01SortingTests(unittest.TestCase):
    def setUp(self):
        p=ROOT/'processes/S01';self.text=(p/'process.py').read_text(encoding='utf-8');self.batch=c.read(p/'batch.json');self.binding=c.read(p/'bindings.json');self.task=c.read(p/'task-spec.json');self.contracts={p.stem:c.read(p) for p in (ROOT/'asset_contracts/assets').glob('*.json')}
    def check(self):return c.check_tree(to_tree(compile_source(self.text)['ir']),self.batch,self.binding,self.task,self.contracts)
    def reject(self,pattern):
        with self.assertRaisesRegex(ValueError,pattern):self.check()
    def test_complete_batch(self):self.assertEqual((3,12),(self.check()['pallets'],self.check()['materials']))
    def test_inventory_only(self):
        self.assertNotIn('routing',self.batch);self.assertNotIn('transport_plans',self.binding)
        for p in self.batch['pallets']:
            self.assertEqual({'id','items'},set(p))
            for i in p['items']:self.assertEqual({'material','category','source'},set(i))
    def test_explicit_calls(self):
        ir=compile_source(self.text)['ir'];main=ir['body']['children'][0]['body']
        self.assertIn('target=C1.station1',self.text);self.assertIn('target=C1.station2',self.text);self.assertIn('target=C1.exit',self.text)
        self.assertNotIn('pallet.stops',self.text);self.assertNotIn('transport_plan',self.text)
        self.assertEqual('for-each',ir['body']['children'][0]['kind'])
    def test_wrong_output(self):
        self.text=self.text.replace('pallet, "A", R1, C2, C2.entry, R1.home','pallet, "A", R1, C3, C3.entry, R1.home');self.reject('分类出料')
    def test_wrong_station(self):self.text=self.text.replace('target=C1.station1','target=C1.station2',1);self.reject('可达工位')
    def test_early_exit(self):self.text=self.text.replace('target=C1.station1','target=C1.exit',1);self.reject('未清空')
    def test_miss_category(self):self.text=self.text.replace('pallet, "A", R1','pallet, "C", R1');self.reject('未拆物料')
    def test_missing_retreat(self):self.text=self.text.replace('target=home','target=output_entry');self.reject('未退位')
    def test_missing_arrival(self):self.text=self.text.replace('        await wait.carrier_present(pallet.id, C1.entry, timeout=ticks(1800))\n','');self.reject('不在本机路线')
    def test_missing_departure(self):self.text=self.text.replace('        await wait.carrier_departed(pallet.id, timeout=ticks(1800))\n','');self.reject('已有托盘|全部出线')
    def test_no_drive(self):self.binding['instances']['C1']['features']['carrier_indexing']=False;self.reject('未启用')
    def test_wrong_goal(self):self.task['all'][0]['items'][0]['target']='C1.exit';self.reject('分类出料')
    def test_wrong_goal_handler(self):self.task['all'][0]['items'][0]['handler']='R2';self.reject('处理工位')
    def test_task_cannot_hide_stops(self):self.batch['pallets'][0]['stops']=[];self.reject('不能包含工序')
    def test_wrong_carrier_type(self):self.text=self.text.replace('carrier=pallet.id','carrier=C1',1);self.reject('名义引用')
    def test_reverse_motion(self):self.text=self.text.replace('target=C1.station2','target=C1.entry',1);self.reject('反向输送')
    def test_unknown_physical_stop(self):self.text=self.text.replace('target=C1.station1','target=C1.missing',1);self.reject('名义引用')
    def test_filter_only_category(self):
        self.text=self.text.replace('category=category','robot=robot',1)
        with self.assertRaises(CompileError):compile_source(self.text)
    def test_filter_is_not_arbitrary_python(self):
        self.text=self.text.replace('items_of(pallet.items, category=category)','[i for i in pallet.items]')
        with self.assertRaises(CompileError):compile_source(self.text)
    def test_filter_is_in_ir(self):
        ir=compile_source(self.text)['ir'];seen=[]
        def walk(n):
            if isinstance(n,dict):
                if n.get('kind')=='select':seen.append(n['equals'])
                for v in n.values():walk(v)
            elif isinstance(n,list):
                for v in n:walk(v)
        walk(ir);self.assertEqual(['A','B'],seen)
        self.assertEqual(ir,from_tree(to_tree(ir)))
    def test_corrected_route_differs_from_original(self):
        old=from_tree(parse((ROOT/'legacy/ac-flow-0.2/S01/process.acp').read_text(encoding='utf-8')))
        self.assertNotEqual(semantic_form(old),semantic_form(compile_source(self.text)['ir']))

if __name__=='__main__':unittest.main()
