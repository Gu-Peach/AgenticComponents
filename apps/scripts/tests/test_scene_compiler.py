import copy, importlib.util, json, sys, unittest
from pathlib import Path

APPS=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(APPS/'scripts'))
spec=importlib.util.spec_from_file_location('scene_catalog_builder', APPS/'scripts/build-scene-catalog.py')
compiler=importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)
from lib.scene_binding_check import validate_inputs

class SceneCompiler(unittest.TestCase):
    def scene(self,id='S01'):
        p=APPS/'public/scene'/id
        ir=compiler.SceneParser((p/'process.py').read_text(encoding='utf-8')).compile()
        manifest=compiler.read(p/'scene.json')
        raw=(p/manifest['model']).read_bytes()
        import struct
        gltf=json.loads(raw[20:20+struct.unpack_from('<I',raw,12)[0]])
        devices,_=compiler.load_scene_devices(p,manifest,gltf)
        compiler.bind_position_targets(manifest,devices)
        devices=compiler.expand_prefabs(ir,devices)
        return ir,devices,compiler.read(p/'task-spec.json')

    def test_twelve_compile_without_legacy_inputs(self):
        for p in sorted((APPS/'public/scene').glob('S[0-9][0-9]')):
            with self.subTest(scene=p.name):validate_inputs(*self.scene(p.name))

    def test_arbitrary_python_is_not_executed(self):
        for source in ['import os', 'print("hello")', 'x = 1']:
            with self.assertRaises(ValueError):compiler.SceneParser(source).compile()

    def test_missing_device_field_is_not_accepted(self):
        ir,devices,goal=self.scene()
        node=next(n for n in compiler.walk(ir) if n.get('kind')=='payload')
        node['kwargs']['material']['field']='does_not_exist'
        with self.assertRaises(ValueError):validate_inputs(ir,devices,goal)

    def test_wrong_units_and_negative_counts_rejected(self):
        ir,devices,goal=self.scene()
        call=next(n for n in compiler.walk(ir) if n.get('kind')=='invoke')
        call['arguments']['subject_id']={'kind':'quantity','args':[{'kind':'literal','value':1},{'kind':'literal','value':'s'}],'kwargs':{}}
        with self.assertRaises(ValueError):validate_inputs(ir,devices,goal)
        ir,devices,goal=self.scene()
        node=next(n for n in compiler.walk(ir) if n.get('kind')=='repeat')
        node['count']={'kind':'literal','value':-1}
        with self.assertRaises(ValueError):validate_inputs(ir,devices,goal)

    def test_independent_goal_count_must_match(self):
        ir,devices,goal=self.scene();goal['expected']['material_count']+=1
        with self.assertRaises(ValueError):validate_inputs(ir,devices,goal)

    def test_recipe_must_belong_to_device(self):
        ir,devices,goal=self.scene('S08');devices['MC1']['recipes']={}
        with self.assertRaises(ValueError):validate_inputs(ir,devices,goal)

if __name__=='__main__':unittest.main()
