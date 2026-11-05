import copy,json,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from validate_device_specs import read,validate_bundle,validate_spec
from spec_sources import load_norms
class DeviceSpecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.schema=read(ROOT/'schema/device-spec.schema.json');cls.norms=load_norms(ROOT.parent.parent/'docs')
    def setUp(self):self.spec=read(ROOT/'assets/robot_arm.json')
    def reject(self):self.assertTrue(validate_spec(self.spec,self.schema,self.norms))
    def test_eight_standard_one_experiment(self):
        r=validate_bundle(ROOT);self.assertTrue(r['valid'],r['errors']);self.assertEqual(8,len(r['standard']));self.assertEqual(1,len(r['experimental']));self.assertFalse(r['execution_ready'])
    def test_behavior_name_is_normative(self):self.spec['transport_behaviors'][0]['behavior_id']='transfer_material';self.reject()
    def test_behavior_subset_allowed(self):self.spec['transport_behaviors'].pop();self.assertEqual([],validate_spec(self.spec,self.schema,self.norms))
    def test_duplicate_behavior_rejected(self):self.spec['transport_behaviors'].append(copy.deepcopy(self.spec['transport_behaviors'][0]));self.reject()
    def test_plc_type_mismatch(self):self.spec['signal_ports'][0]['value_type']='boolean';self.reject()
    def test_missing_signal_role(self):del self.spec['signal_ports'][0]['signal_role'];self.reject()
    def test_unknown_condition(self):self.spec['transport_behaviors'][0]['condition_contract']['preconditions'][0]['key']='invented';self.reject()
    def test_wrong_condition_source(self):self.spec['transport_behaviors'][0]['condition_contract']['preconditions'][0]['source']='signal';self.reject()
    def test_missing_mutability(self):del self.spec['params_schema']['max_payload_kg']['mutability'];self.reject()
    def test_invented_parameter(self):self.spec['params_schema']['foo']=copy.deepcopy(self.spec['params_schema']['max_payload_kg']);self.reject()
    def test_wrong_default_type(self):self.spec['params_schema']['max_payload_kg']['default']=True;self.reject()
    def test_wrong_unit(self):self.spec['params_schema']['cartesian_speed_mps']['unit']='deg/s';self.reject()
    def test_unknown_parameter_reference(self):self.spec['type_specific_contract']['bad_param']='absent';self.reject()
    def test_input_direction(self):self.spec['transport_behaviors'][0]['input_signals']=['holding_material'];self.reject()
    def test_completion_required(self):self.spec['transport_behaviors'][0]['completion_contract']['checks']=[];self.reject()
    def test_no_false_implementation(self):self.spec['transport_behaviors'][0]['implementation_status']='implemented';self.reject()
    def test_passive_has_no_commands(self):
        self.spec=read(ROOT/'assets/material.json');self.spec['signal_ports'][0]['direction']='input';self.reject()
    def test_services_not_removed_from_pallet(self):
        spec=read(ROOT/'assets/pallet.json');names={b['behavior_id'] for b in spec['transport_behaviors']};self.assertIn('reserve_carrier_slot',names);self.assertIn('confirm_load',names);self.assertFalse(any(p['direction']=='input' for p in spec['signal_ports']))
    def test_spatial_no_process_information(self):
        self.spec=read(ROOT/'assets/conveyor.json');self.spec['interfaces'][0]['signal_refs']=[];self.reject()
    def test_rotary_signal_units(self):
        spec=read(ROOT/'assets/rotary_table.json');p=next(x for x in spec['signal_ports'] if x['port_id']=='angleTag');self.assertEqual('°',p['unit'])
    def test_shared_contract_not_project_instance(self):self.spec['schema_id']='R1';self.reject()
    def test_no_legacy_parallel_structure(self):self.spec['behaviors']=[];self.reject()
    def test_material_projection_is_integer(self):
        spec=read(ROOT/'assets/material.json');p=next(x for x in spec['signal_ports'] if x['port_id']=='holder_id');self.assertEqual(('integer','DINT'),(p['value_type'],p['plc_type']))
    def test_observer_not_schedulable(self):self.spec['transport_behaviors'][-1]['schedulable']=True;self.reject()
    def test_invented_signal_rejected(self):
        self.spec['signal_ports'].append(dict(port_id='teleport',direction='input',value_type='boolean',plc_type='BOOL',description='bad',signal_role='command',retention='state'));self.reject()
    def test_unused_optional_parameter_can_be_omitted(self):
        self.spec=read(ROOT/'assets/conveyor.json');del self.spec['params_schema']['encoder_pitch_m'];del self.spec['type_specific_contract']['encoder_model'];self.assertEqual([],validate_spec(self.spec,self.schema,self.norms))
    def test_parameter_still_required_by_structure_cannot_be_omitted(self):
        del self.spec['params_schema']['joint_speed_rad_s'];self.reject()
    def test_robot_scalar_schema_does_not_replace_payload(self):
        for name in ('execute_job','wait_time'):
            self.assertEqual({},next(b for b in self.spec['transport_behaviors'] if b['behavior_id']==name)['arguments_schema'])
if __name__=='__main__':unittest.main()
