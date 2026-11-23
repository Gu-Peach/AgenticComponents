import copy, importlib.util, json, sys, unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

APPS=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(APPS/'scripts'))
spec=importlib.util.spec_from_file_location('scene_catalog_builder', APPS/'scripts/build-scene-catalog.py')
compiler=importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)
from lib.scene_binding_check import validate_inputs

class SceneCompiler(unittest.TestCase):
    def test_generated_catalog_skips_unchanged_output(self):
        with TemporaryDirectory() as temp:
            out = Path(temp)/'.generated'/'scene.bundle.json'
            data = {'id': 'S10', 'name': '码垛'}
            compiler.write(out, data)
            expected = out.read_bytes()
            with patch.object(Path, 'replace', side_effect=AssertionError('unexpected write')):
                compiler.write_generated(out, data)
            self.assertEqual(out.read_bytes(), expected)

    def test_failed_catalog_replacement_keeps_original_output(self):
        with TemporaryDirectory() as temp:
            out = Path(temp)/'index.json'
            compiler.write_generated(out, {'version': 1, 'entries': []})
            expected = out.read_bytes()
            with patch.object(Path, 'replace', side_effect=OSError('file unavailable')):
                with self.assertRaisesRegex(OSError, 'file unavailable'):
                    compiler.write_generated(out, {'version': 1, 'entries': [{'id': 'S10'}]})
            self.assertEqual(out.read_bytes(), expected)
            self.assertEqual(list(out.parent.iterdir()), [out])

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

    def test_bottle_handoff_binds_two_material_frames_and_distinct_robots(self):
        ir, devices, goal = self.scene('S04')
        validate_inputs(ir, devices, goal)
        handoff = next(n for n in compiler.walk(ir['body']) if n.get('id') == 'head_to_tail_handoff')
        fields = handoff['payload']['kwargs']
        for field, replacement, error in (
            ('receiver_grasp', {'kind': 'literal', 'value': 'unknown'}, 'Unknown material grasp frame'),
            ('receiver_grasp', {'kind': 'literal', 'value': 'head'}, 'distinct grasp frames'),
            ('receiver', {'kind': 'ref', 'name': 'R1'}, 'receiver must differ'),
            ('receiver', {'kind': 'ref', 'name': 'C1'}, 'Invalid robot reference'),
        ):
            with self.subTest(field=field, replacement=replacement):
                saved = fields[field]
                try:
                    fields[field] = replacement
                    with self.assertRaisesRegex(ValueError, error):
                        validate_inputs(ir, devices, goal)
                finally:
                    fields[field] = saved

    def test_s04_material_orientation_is_defined_on_the_second_belt(self):
        ir, devices, _ = self.scene('S04')
        self.assertEqual(ir['task']['material_count'], 4)
        self.assertEqual(devices['R1']['node_binding']['root']['name'], 'robot(UR10)(2)')
        self.assertEqual(devices['R2']['node_binding']['root']['name'], 'robot(UR10)(1)(center)')
        self.assertEqual(devices['M01']['creation_policy'], 'adopt_existing_glb')
        self.assertEqual(devices['M04']['creation_policy'], 'clone_on_admission')
        frames = devices['M01']['contract']['type_specific_contract']['grasping']['frames']
        self.assertAlmostEqual(frames['head']['position_m'][1], .215, places=5)
        self.assertEqual(frames['tail']['position_m'], [0, 0, 0])
        for endpoint in ('C2.entry', 'C2.exit'):
            pose = devices['C2']['locations'][endpoint]['material_pose']
            x, y, z, w = pose['orientation_quaternion']
            self.assertEqual(pose['contact_frame'], 'head')
            # The Y component of material-local +Y in scene coordinates.
            self.assertAlmostEqual(1 - 2 * (x*x + z*z), -1)
            self.assertAlmostEqual(x*x + y*y + z*z + w*w, 1)
        self.assertTrue(devices['C2']['contract']['type_specific_contract']['transport_pose']['verify_throughout'])

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
