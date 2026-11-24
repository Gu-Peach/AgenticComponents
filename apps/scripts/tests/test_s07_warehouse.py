import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import test_scene_compiler as support


class WarehouseAuthoring(unittest.TestCase):
    def setUp(self):
        self.folder = support.APPS / 'public/scene/S07'
        self.ir, self.devices, self.goal = support.SceneCompiler().scene('S07')

    def test_real_assets_slots_and_independent_goal(self):
        manifest = support.compiler.read(self.folder / 'scene.json')
        self.assertEqual(hashlib.sha256((self.folder / manifest['model']).read_bytes()).hexdigest(), manifest['model_sha256'])
        active = {k: d for k, d in self.devices.items() if k not in self.goal['expected']['material_ids'] and d.get('asset_kind') != 'material_prefab'}
        self.assertEqual(set(active), {'C1', 'C2', 'F1', 'T1', 'T2', 'L1', 'L2', 'STORE'})
        self.assertTrue(all(d['node_binding']['status'] == 'bound' for d in active.values()))
        meshes = [i for d in active.values() for i in d['node_binding']['owned_mesh_indices']]
        self.assertEqual(len(meshes), len(set(meshes)))
        slots = self.devices['STORE']['locations']
        self.assertEqual(len(slots), 16)
        self.assertEqual({(s['column'], s['level']) for s in slots.values()}, {(c, l) for c in range(1, 5) for l in range(1, 5)})
        for i, height in enumerate([1, 1.6, 2.2, 2.8], 1):
            self.assertAlmostEqual(slots[f'STORE.slot{i}']['position'][1], height, places=5)
        self.assertNotIn('X1', self.devices)
        self.assertEqual(self.goal['expected']['material_count'], 4)
        support.validate_inputs(self.ir, self.devices, self.goal)

    def test_named_targets_are_checked_for_every_order(self):
        self.ir['task']['jobs'][3]['slot'] = 'STORE.absent'
        with self.assertRaisesRegex(ValueError, 'Unknown named location|Invalid location reference'):
            support.validate_inputs(self.ir, self.devices, self.goal)

    def test_wrong_unit_and_cross_lift_transfer_rejected(self):
        broken = copy.deepcopy(self.devices)
        call = next(n for n in support.compiler.walk(self.ir) if n.get('kind') == 'invoke' and n.get('behavior') == 'move_to_position')
        call['arguments']['position_m'] = {'kind':'quantity','args':[{'kind':'literal','value':1},{'kind':'literal','value':'s'}],'kwargs':{}}
        with self.assertRaisesRegex(ValueError, 'Argument unit mismatch'):
            support.validate_inputs(self.ir, broken, self.goal)
        self.ir, self.devices, self.goal = support.SceneCompiler().scene('S07')
        self.ir['task']['jobs'][0]['slot'] = 'C2.entry'
        with self.assertRaisesRegex(ValueError, 'Transfer route'):
            support.validate_inputs(self.ir, self.devices, self.goal)

    def test_numeric_axis_limits_apply_to_each_order(self):
        self.ir['task']['jobs'][2]['in_slot_position'] = -100
        with self.assertRaisesRegex(ValueError, r'T1.inbound_rail_to_slot.position_m'):
            support.validate_inputs(self.ir,self.devices,self.goal)

    def test_wrong_platform_hierarchy_rejected(self):
        manifest = support.compiler.read(self.folder / 'scene.json')
        import struct
        raw = (self.folder / manifest['model']).read_bytes()
        gltf = json.loads(raw[20:20 + struct.unpack_from('<I', raw, 12)[0]])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for directory in ['device', 'contracts']:
                (root / directory).mkdir()
                for file in (self.folder / directory).glob('*.json'):
                    (root / directory / file.name).write_bytes(file.read_bytes())
            path = root / 'device/L1.json'
            d = support.compiler.read(path)
            d['model']['handler']['node'] = 'Handler_006n'
            path.write_text(json.dumps(d), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'hierarchy differs'):
                support.compiler.load_scene_devices(root, manifest, gltf)

    def test_rebuild_retains_runtime_and_calibration_blockers(self):
        with tempfile.TemporaryDirectory() as temp:
            support.compiler.build(self.folder.parent, 'S07', Path(temp))
            bundle = support.compiler.read(Path(temp) / 'S07/.generated/scene.bundle.json')
            self.assertFalse(bundle['executable'])
            blockers = {(b['code'], b.get('device'), b.get('requirement')) for b in bundle['blockers']}
            self.assertIn(('CALIBRATION_REQUIRED', 'T1', 'contact_and_motion_validation'), blockers)
            self.assertNotIn(('NODE_BINDING_REQUIRED', 'M01', None), blockers)
            self.assertEqual(bundle['runtime_profile'], 'warehouse.virtual-linear@1')
            self.assertNotIn('bindings.json', bundle['source_hashes'])
            self.assertIn('contracts/linear_rail.json', bundle['source_hashes'])

    def test_user_box_is_finite_and_independently_identified(self):
        self.assertEqual(self.devices['Workpiece']['node_binding']['root']['three_name'], 'Visual_Components_Box_00Mn')
        materials = [self.devices[id] for id in self.goal['expected']['material_ids']]
        self.assertEqual(len({d['subject_id'] for d in materials}), 4)
        for d in materials:
            for actual, expected in zip(d['geometry']['bounds']['size'], [.45,.4,.45]):self.assertAlmostEqual(actual,expected,places=5)


if __name__ == '__main__':
    unittest.main()
