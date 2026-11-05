"""Cross-scene contract migration must not erase ordering or handoff obligations."""
import copy, sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from audit_device_bindings import read,audit_all,audit_scene,walk
from declarative_frontend import compile_source

class AllScenes(unittest.TestCase):
    def setUp(self):
        self.specs={p.stem:read(p) for p in (ROOT/'asset_contracts/assets').glob('*.json')}
        self.interfaces=read(ROOT/'declarative_dsl/interfaces.json')

    def scene(self,name):
        p=ROOT/'processes'/name
        return compile_source((p/'process.py').read_text(encoding='utf-8')),read(p/'bindings.json'),read(p/'batch.json')

    def audit(self,ir,binding,batch):
        return audit_scene(ir,binding,self.specs,self.interfaces,batch)

    def test_all_twelve_use_no_wait_language_and_real_references(self):
        report=audit_all(ROOT)
        self.assertTrue(report['asset_definition_valid'])
        self.assertEqual(12,len(report['scenes']))
        for result in report['scenes']:
            with self.subTest(scene=result['scene']):
                ir,binding,batch=self.scene(result['scene'])
                self.assertEqual('ac-declarative/0.3',ir['language'])
                self.assertFalse(any(n.get('kind')=='await' for n in walk(ir)))
                self.assertTrue(result['declaration_references_valid'],result['errors'])
                self.assertFalse(result['executable'])
                self.assertEqual(result['calls'],len(result['automatic_obligations']['behaviors']))

    def test_s02_three_station_parallel_and_explicit_fill_drain(self):
        ir,binding,batch=self.scene('S02')
        par=next(n for n in walk(ir) if n.get('kind')=='par')
        self.assertEqual(3,len(par['children']))
        calls=[n for n in walk(ir) if n.get('kind')=='invoke' and n['behavior']=='move_by_distance']
        self.assertEqual(2,len(calls))
        self.assertIn('waves_060',binding['iteration_contracts'])
        del binding['iteration_contracts']
        self.assertFalse(self.audit(ir,binding,batch)['declaration_references_valid'])

    def test_s12_processing_precedes_rotary_handoff_in_same_branch(self):
        ir,_,_=self.scene('S12')
        side=next(n for n in walk(ir) if n.get('id')=='side_a_290')
        behaviors=[n['behavior'] for n in walk(side) if n.get('kind')=='invoke']
        self.assertLess(behaviors.index('process_material'),behaviors.index('rotate_to_station'))
        self.assertLess(behaviors.index('unclamp'),behaviors.index('rotate_to_station'))
        self.assertFalse(any(n.get('id')=='rotary_handoff_302' for n in walk(ir)))

    def test_experimental_contract_is_checked_but_not_promoted(self):
        ir,binding,batch=self.scene('S08');result=self.audit(ir,binding,batch)
        self.assertTrue(result['declaration_references_valid'])
        self.assertFalse(result['contract_binding_valid'])
        self.assertIn('EXPERIMENTAL_BEHAVIOR_NOT_ADMITTED',{e['code'] for e in result['errors']})
        node=next(n for n in walk(ir) if n.get('kind')=='invoke' and n['behavior']=='process_material')
        node['arguments']['recipe']['value']='unknown_recipe'
        self.assertFalse(self.audit(ir,binding,batch)['declaration_references_valid'])

    def test_missing_experimental_completion_cannot_pass(self):
        ir,binding,batch=self.scene('S08')
        binding['experimental_condition_bindings']['MC1/clamp']['completion']={}
        self.assertFalse(self.audit(ir,binding,batch)['declaration_references_valid'])

    def test_batch_field_types_checked_against_actual_records(self):
        ir,binding,batch=self.scene('S07')
        batch['jobs'][0]['height']='not a height'
        self.assertFalse(self.audit(ir,binding,batch)['declaration_references_valid'])

    def test_select_must_use_declared_field(self):
        ir,binding,batch=self.scene('S09')
        select=next(n for n in walk(ir) if n.get('kind')=='select')
        select['kwargs']['typo']=select['kwargs'].pop('machine')
        self.assertFalse(self.audit(ir,binding,batch)['declaration_references_valid'])

    def test_pallet_exchange_not_lost(self):
        ir,binding,batch=self.scene('S10')
        self.assertTrue(self.audit(ir,binding,batch)['declaration_references_valid'])
        del binding['iteration_contracts']
        self.assertFalse(self.audit(ir,binding,batch)['declaration_references_valid'])

if __name__=='__main__':unittest.main()
