import sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from model_profiles import read,validate_profiles
class ModelProfiles(unittest.TestCase):
    def test_sources_and_models_are_pinned(self):self.assertEqual([],validate_profiles(ROOT))
    def test_passive_engine_has_no_fake_io(self):
        p=next(x for x in read(ROOT/'model-profiles.json')['profiles'] if x['id']=='engine_block')
        self.assertEqual((0,0,False),(p['signal_count'],p['behavior_count'],p['mass_has_default']))
    def test_robot_step_entry_is_separate(self):
        p=next(x for x in read(ROOT/'model-profiles.json')['profiles'] if x['id']=='robot_UR10')
        self.assertIn('wait_time',p['step_only_behaviors']);self.assertNotIn('wait_time',p['top_level_payload_behaviors'])
    def test_conveyor_plc_gateway_is_not_promoted(self):
        p=next(x for x in read(ROOT/'model-profiles.json')['profiles'] if x['id']=='Conveyor_aankws')
        self.assertIn('request_id',p['supported_io']['not_implemented']);self.assertEqual(['runTag','speedTag'],p['supported_io']['inputs'])
if __name__=='__main__':unittest.main()
