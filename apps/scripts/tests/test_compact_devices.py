import copy, importlib.util, json, shutil, struct, sys, tempfile, unittest
from pathlib import Path

APPS=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(APPS/'scripts/lib'))
from scene_devices import load_scene_devices

class CompactDevices(unittest.TestCase):
    def setUp(self):
        self.source=APPS/'public/scene/S01'
        self.manifest=json.loads((self.source/'scene.json').read_text(encoding='utf-8'))
        self.device=json.loads((self.source/'device/R1.json').read_text(encoding='utf-8'))
        raw=(self.source/self.manifest['model']).read_bytes()
        self.gltf=json.loads(raw[20:20+struct.unpack_from('<I',raw,12)[0]])
    def load(self,mutation):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);(folder/'device').mkdir();(folder/'contracts').mkdir()
            contract=self.source/'device'/self.device['contract_ref']
            shutil.copy2(contract,folder/'contracts'/contract.name)
            data=copy.deepcopy(self.device);mutation(data,folder)
            (folder/'device/R1.json').write_text(json.dumps(data),encoding='utf-8')
            return load_scene_devices(folder,{**self.manifest,'devices':['device/R1.json']},self.gltf)
    def test_compact_references_cannot_escape_package(self):
        def mutate(data,_):data['contract_ref']='../../../outside.json'
        with self.assertRaisesRegex(ValueError,'escapes'):self.load(mutate)
    def test_invalid_shared_contract_is_rejected(self):
        def mutate(_,folder):(folder/'contracts/robot_arm.json').write_text('{}',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'Invalid shared contract'):self.load(mutate)
    def test_removed_parameters_cannot_be_silently_reintroduced(self):
        def mutate(data,_):data['parameters']['cartesian_speed_mps']=0.2
        with self.assertRaisesRegex(ValueError,'Unsupported instance parameter'):self.load(mutate)
    def test_known_joint_chain_cannot_reference_other_robot(self):
        def mutate(data,_):data['model']['urdf']['joints'][0]['nodeName']='Axis_1_005n'
        with self.assertRaisesRegex(ValueError,'hierarchy'):self.load(mutate)
    def test_invalid_explicit_axis_is_not_normalized_into_success(self):
        def mutate(data,_):data['model']['urdf']['joints'][0]['axis']=[2,0,0]
        with self.assertRaisesRegex(ValueError,'axis'):self.load(mutate)
    def test_defaults_resolve_but_pending_axes_remain_pending(self):
        def leave_unknown(data,_):data['model']['urdf']['joints'][0]['axis']=None
        devices,sources=self.load(leave_unknown);device=devices['R1']
        self.assertEqual(8,len(device['parameters']))
        self.assertEqual(6,len(device['contract']['type_specific_contract']['urdf']['joints']))
        self.assertIsNone(device['contract']['type_specific_contract']['urdf']['joints'][0]['axis'])
        self.assertIn('joint_1.axis',device['required_confirmations'])
        self.assertIn('contracts/robot_arm.json',sources)

if __name__=='__main__':unittest.main()
