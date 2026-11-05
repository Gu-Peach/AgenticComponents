import sys,unittest,copy
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from audit_device_bindings import audit_all,audit_scene,read
from declarative_frontend import compile_source
class StrictBindings(unittest.TestCase):
    def setUp(self):
        self.specs={e['id']:read(ROOT/'asset_contracts'/e['path']) for e in read(ROOT/'asset_contracts/catalog.json')['assets']};self.binding=read(ROOT/'processes/S01/bindings.json')
    def test_all_scenes_report_binding_migration(self):
        result=audit_all(ROOT);self.assertEqual(12,len(result['scenes']));self.assertFalse(result['contract_binding_valid']);self.assertFalse(result['executable'])
    def test_proposed_advance_cannot_bypass_contract(self):
        ir=compile_source('with process("S01", version="ac-declarative/0.1"):\n    invoke("bad", C1, "advance_pitch")\n')
        result=audit_scene(ir,self.binding,self.specs);self.assertTrue(any(e['code']=='BEHAVIOR_NOT_IN_DEVICE_CONTRACT' for e in result['errors']))
    def test_known_discrete_behavior_is_recognized(self):
        c=self.specs['conveyor'];binding=copy.deepcopy(self.binding);binding['instances']={'C1':dict(contract='conveyor',version=c['version'],parameters={k:v['default'] for k,v in c['params_schema'].items() if 'default'in v})}
        ir=compile_source('with process("S01", version="ac-declarative/0.1"):\n    invoke("stop", C1, "stop_conveying")\n')
        result=audit_scene(ir,binding,self.specs);self.assertTrue(result['contract_binding_valid'],result['errors']);self.assertFalse(result['executable'])
    def test_old_robot_alias_not_silently_accepted(self):
        ir=compile_source('with process("S01", version="ac-declarative/0.1"):\n    invoke("bad", R1, "transfer_material")\n')
        result=audit_scene(ir,self.binding,self.specs);self.assertTrue(any(e['code']=='BEHAVIOR_NOT_IN_DEVICE_CONTRACT' for e in result['errors']))
    def test_conveyor_subject_parameter_is_required(self):
        ir=compile_source('with process("S01", version="ac-declarative/0.1"):\n    invoke("bad", C2, "transport_to_exit", material="M01_1")\n')
        result=audit_scene(ir,self.binding,self.specs);self.assertTrue(any(e['code']=='ARGUMENTS_DIFFER_FROM_CONTRACT' and 'subject_id'in e['message'] for e in result['errors']))
    def test_processing_extension_is_not_standard(self):
        result=audit_all(ROOT)['scenes'][4];self.assertTrue(any(e['code']=='EXPERIMENTAL_BEHAVIOR_NOT_ADMITTED' for e in result['errors']))
    def test_empty_scalar_schema_does_not_mean_payload_free(self):
        spec=self.specs['robot_arm'];binding=copy.deepcopy(self.binding);binding['instances']={'R1':dict(contract='robot_arm',version=spec['version'],parameters={k:v['default'] for k,v in spec['params_schema'].items() if 'default'in v})}
        ir=compile_source('with process("S01", version="ac-declarative/0.1"):\n    invoke("job", R1, "execute_job")\n')
        result=audit_scene(ir,binding,self.specs);self.assertFalse(result['contract_binding_valid']);self.assertTrue(any(e['code']=='ACTION_PAYLOAD_ADAPTER_REQUIRED' for e in result['errors']))
if __name__=='__main__':unittest.main()
