import sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from wait_catalog import PREDICATES,ARITIES,render_table
from python_frontend import compile_source,CompileError

class WaitCatalogTests(unittest.TestCase):
    def test_complete_nine_methods(self):
        self.assertEqual(9,len(PREDICATES));self.assertEqual(2,ARITIES['carrier_present'])
        self.assertEqual(['pallet','location'],[p['name'] for p in PREDICATES['carrier_present']['parameters']])
    def test_tables_are_current(self):
        table=render_table()
        for name in ('Python风格DSL规范.md','批次语言说明.md','等待条件目录.md'):
            self.assertIn(table,(ROOT/name).read_text(encoding='utf-8'),name)
        comments='\n'.join('# '+line for line in table.splitlines())
        self.assertIn(comments,(ROOT/'processes/S01/process.py').read_text(encoding='utf-8'))
    def test_unknown_wait_rejected_by_frontend(self):
        text='@process(version="ac-python/0.1", scene="S01")\nasync def main():\n    await wait.invented("P01", timeout=ticks(10))\n    await verify("batch_goal")\n'
        with self.assertRaisesRegex(CompileError,'未登记'):compile_source(text)
    def test_wrong_arity_rejected_by_frontend(self):
        text='@process(version="ac-python/0.1", scene="S01")\nasync def main():\n    await wait.carrier_present("P01", timeout=ticks(10))\n    await verify("batch_goal")\n'
        with self.assertRaisesRegex(CompileError,'参数数量'):compile_source(text)
    def test_scene_wait_methods_exactly_cover_registry(self):
        found=set()
        def walk(n):
            if isinstance(n,dict):
                if n.get('kind')=='await':found.add(n['predicate'])
                for v in n.values():walk(v)
            elif isinstance(n,list):
                for v in n:walk(v)
        for p in (ROOT/'processes').glob('S*/process.py'):walk(compile_source(p.read_text(encoding='utf-8'))['ir'])
        self.assertEqual(set(PREDICATES),found)

if __name__=='__main__':unittest.main()
