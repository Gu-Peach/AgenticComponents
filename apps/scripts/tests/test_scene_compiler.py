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

    def test_loading_quantities_are_driven_by_dsl_and_checked_against_physical_slots(self):
        source = (APPS/'public/scene/S02/process.py').read_text(encoding='utf-8')
        _, devices, _ = self.scene('S02')
        authored = {k:v for k,v in devices.items() if not v.get('asset_kind','').startswith('runtime_')}
        def expand(source):
            ir = compiler.SceneParser(source).compile()
            devices = compiler.expand_prefabs(ir,authored)
            return ir['task'], devices
        small, subjects = expand(source.replace('count=6','count=2').replace("'upper': 12", "'upper': 4"))
        self.assertEqual((small['pallet_count'],small['material_count']),(2,34))
        self.assertEqual(len(subjects['P01']['locations']),25)
        self.assertEqual([i['category'] for i in small['pallets'][0]['items']].count('upper'),4)
        self.assertNotIn('M01_18',subjects)
        with self.assertRaisesRegex(ValueError,'exceed compatible slot capacity'):
            expand(source.replace("'upper': 12", "'upper': 13"))
        with self.assertRaisesRegex(ValueError,'support layer'):
            expand(source.replace("'cover': 1", "'cover': 0"))
        authored['Pallet']['parameters']['allow_partial_load'] = False
        with self.assertRaisesRegex(ValueError,'partial loading'):
            expand(source.replace("'upper': 12", "'upper': 2"))
        authored['Pallet']['prefab']['slots'][1]['id'] = authored['Pallet']['prefab']['slots'][0]['id']
        with self.assertRaisesRegex(ValueError,'Duplicate carrier slot'):
            expand(source)

    def test_twelve_compile_without_legacy_inputs(self):
        for p in sorted((APPS/'public/scene').glob('S[0-9][0-9]')):
            with self.subTest(scene=p.name):validate_inputs(*self.scene(p.name))

    def test_table_index_uses_model_stations_and_dsl_setpoint(self):
        ir, devices, goal = self.scene('S11')
        action = next(n for n in compiler.walk(ir['body']) if n.get('id') == 'index_to_robot')
        target = action['arguments']['angleTag']['args'][0]
        target['value'] = 90
        with self.assertRaisesRegex(ValueError, 'Unknown indexing station at index_to_robot'):
            validate_inputs(ir, devices, goal)
        policy = devices['T1']['contract']['type_specific_contract']['indexing_policy']
        policy.update(process_deg=90, stations_deg=[0, 90])
        validate_inputs(ir, devices, goal)

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

    def test_optional_robot_grip_resolves_the_material_port_in_ordinary_loading(self):
        for scene, step in [('S02','place_lower'),('S06','load_machine')]:
            with self.subTest(scene=scene):
                ir,devices,goal=self.scene(scene)
                node=next(n for n in compiler.walk(ir['body']) if n.get('id')==step)
                params=node['payload']['kwargs']
                validate_inputs(ir,devices,goal)
                params['grasp']={'kind':'literal','value':'fixture_port'}
                with self.assertRaisesRegex(ValueError,'Unknown material grasp frame'):
                    validate_inputs(ir,devices,goal)
                for d in devices.values():
                    if d.get('asset_kind')=='runtime_material':
                        d['contract']['type_specific_contract']['grasping']['frames']={'fixture_port':{'position_m':[0,.1,0],'approach_axis':[0,-1,0]}}
                validate_inputs(ir,devices,goal)
                params['invented']={'kind':'literal','value':'fixture_port'}
                with self.assertRaisesRegex(ValueError,'Payload fields differ'):
                    validate_inputs(ir,devices,goal)

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

    def test_canonical_handoff_requires_an_explicit_supported_start_and_receiver(self):
        ir,devices,goal=self.scene('S04')
        calls=[n for n in compiler.walk(ir['body']) if n.get('kind')=='invoke' and
               n.get('behavior') in ('pick_and_handoff','place_held_material')]
        self.assertEqual(len(calls),2)
        for call in calls:call['behavior']='pick_and_place'
        validate_inputs(ir,devices,goal,'robot-handoff@1')
        with self.assertRaisesRegex(ValueError,'redirects'):
            validate_inputs(ir,devices,goal)
        # A different instance's payload must never acquire someone else's grip.
        calls[1]['payload']['args'][0]['value']='R1.pick_and_handoff'
        with self.assertRaisesRegex(ValueError,'redirects'):
            validate_inputs(ir,devices,goal,'robot-handoff@1')

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
