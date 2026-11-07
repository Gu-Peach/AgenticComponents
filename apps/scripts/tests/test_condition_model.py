import copy, json, sys, tempfile, unittest, shutil, struct
from pathlib import Path

APPS=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(APPS/'scripts/lib'))
from condition_model import validate_condition_model
from scene_devices import load_scene_devices

class ConditionModel(unittest.TestCase):
    def contract(self,name='robot_arm'):
        return json.loads((APPS/'public/scene/S01/contracts'/f'{name}.json').read_text(encoding='utf-8-sig'))
    def model(self,c):return c['runtime_contract']['condition_model']
    def invalid(self,c):
        with self.assertRaises(ValueError):validate_condition_model(c)
    def test_five_shared_contracts_cover_registered_definitions(self):
        counts={}
        for path in (APPS/'public/scene/S01/contracts').glob('*.json'):
            c=self.contract(path.stem);validate_condition_model(c)
            counts[path.stem]=sum(e['status']=='structured' for e in self.model(c)['expressions'].values())
        self.assertEqual(counts,{'conveyor':16,'robot_arm':6,'workpiece':0,'workpiece_carrier':0,'material_source_station':0})
    def test_legacy_contract_without_extension_still_valid(self):
        c=self.contract();del c['runtime_contract']['condition_model']
        for table in ('observation_definitions','authorization_definitions'):
            for d in c['runtime_contract'][table].values():d.pop('expression_ref',None)
        validate_condition_model(c)
    def test_dangling_extension_reference_rejected(self):
        c=self.contract();del c['runtime_contract']['condition_model'];self.invalid(c)
    def test_unknown_version_and_premature_execution_rejected(self):
        for key,value in [('schema_version','ac-condition/99'),('execution_mode','active')]:
            c=self.contract();self.model(c)[key]=value;self.invalid(c)
    def test_missing_expression_or_binding_rejected(self):
        c=self.contract();del self.model(c)['expressions']['pick_and_place.pre_1'];self.invalid(c)
        c=self.contract();self.model(c)['expressions']['pick_and_place.pre_1']['expr']={'op':'ref','binding':'missing'};self.invalid(c)
    def test_signal_reference_and_type_rejected(self):
        for key,value in [('port','invented_sensor'),('value_type','number'),('required_quality','unknown')]:
            c=self.contract();self.model(c)['bindings']['pick_and_place.busy_run'][key]=value;self.invalid(c)
    def test_parameter_and_payload_reference_rejected(self):
        c=self.contract();self.model(c)['bindings']['move_to_pose.ik_position_tolerance_m']['parameter']='invented_threshold';self.invalid(c)
        c=self.contract();self.model(c)['bindings']['pick_and_place.source_pickable']['arguments']['material']['name']='invented_payload';self.invalid(c)
    def test_comparison_units_and_logic_types_rejected(self):
        c=self.contract();self.model(c)['expressions']['move_to_pose.completion']['expr']['args'][1]['right']={'op':'literal','value':.02,'unit':'m/s'};self.invalid(c)
        c=self.contract();self.model(c)['expressions']['pick_and_place.pre_1']['expr']={'op':'not','arg':{'op':'literal','value':1,'unit':'1'}};self.invalid(c)
    def test_request_scope_and_absent_subject_rejected(self):
        c=self.contract();self.model(c)['bindings']['pick_and_place.matching_success']['scope']='run';self.invalid(c)
        c=self.contract();self.model(c)['bindings']['move_to_pose.matching_success']['scope']='request_subject';self.invalid(c)
    def test_self_trigger_and_done_cycles_rejected(self):
        c=self.contract();m=self.model(c);b=copy.deepcopy(m['bindings']['pick_and_place.busy_run']);b['port']='start_pick';m['bindings']['pick_and_place.self_trigger']=b
        m['expressions']['pick_and_place.pre_1']['expr']={'op':'ref','binding':'pick_and_place.self_trigger'};self.invalid(c)
        c=self.contract();m=self.model(c);b=copy.deepcopy(m['bindings']['pick_and_place.holding_material_request_subject']);b['port']='done';m['bindings']['pick_and_place.done_cycle']=b
        m['expressions']['pick_and_place.completion']['expr']={'op':'ref','binding':'pick_and_place.done_cycle'};self.invalid(c)
    def test_resource_grant_cannot_gate_candidate(self):
        c=self.contract('conveyor');self.model(c)['expressions']['transport_to_position.ready']['expr']={'op':'ref','binding':'transport_to_position.resources_granted'};self.invalid(c)
    def test_opaque_preserves_original_source_and_key(self):
        c=self.contract('workpiece');key=next(iter(self.model(c)['expressions']));self.model(c)['expressions'][key]['expr']['key']='made_up';self.invalid(c)
    def test_empty_groups_nonfinite_numbers_and_code_rejected(self):
        for expr in [{'op':'any','args':[]},{'op':'literal','value':float('nan'),'unit':'1'},{'op':'eval','source':'return true'}]:
            c=self.contract();self.model(c)['expressions']['pick_and_place.pre_1']['expr']=expr;self.invalid(c)
    def test_excessive_depth_rejected(self):
        c=self.contract();expr={'op':'literal','value':True,'unit':'1'}
        for _ in range(34):expr={'op':'not','arg':expr}
        self.model(c)['expressions']['pick_and_place.pre_1']['expr']=expr;self.invalid(c)
    def test_scene_loader_rejects_invalid_shared_condition(self):
        source=APPS/'public/scene/S01';manifest=json.loads((source/'scene.json').read_text(encoding='utf-8-sig'))
        raw=(source/manifest['model']).read_bytes();gltf=json.loads(raw[20:20+struct.unpack_from('<I',raw,12)[0]])
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copytree(source/'contracts',folder/'contracts');shutil.copytree(source/'device',folder/'device')
            c=self.contract('conveyor');self.model(c)['schema_version']='invalid';(folder/'contracts/conveyor.json').write_text(json.dumps(c),encoding='utf8')
            with self.assertRaisesRegex(ValueError,'Condition model'):
                load_scene_devices(folder,manifest,gltf)

if __name__=='__main__':unittest.main()
