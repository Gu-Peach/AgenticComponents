import copy,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib'))
from scene_layout import validate_sorting_station

class SceneLayout(unittest.TestCase):
    def setUp(self):
        self.scene={'coordinate_system':{'frame':'scene_world_m','length_unit':'m','up_axis':'Y'},
            'sorting_station':{'id':'sorting','frame':'scene_world_m','position_m':[-0.3324,0.1999,-1.1967],
                'reference':'carrier_origin','support_device':'C2','carrier_template':'Pallet','robots':['R1','R2'],'capacity':1,'status':'candidate'}}
        self.devices={'C2':{'contract':{'device_type':'conveyor'}},'Pallet':{'asset_kind':'carrier_prefab'},
            'R1':{'contract':{'device_type':'robot_arm'}},'R2':{'contract':{'device_type':'robot_arm'}}}
    def test_candidate_is_not_promoted_to_calibrated(self):
        self.assertEqual('candidate',validate_sorting_station(self.scene,self.devices)['status'])
        self.scene['sorting_station']['status']='calibrated'
        with self.assertRaisesRegex(ValueError,'evidence'):validate_sorting_station(self.scene,self.devices)
    def test_reference_and_coordinate_frame_are_explicit(self):
        for field,value in [('reference','tcp'),('frame','device_local')]:
            bad=copy.deepcopy(self.scene);bad['sorting_station'][field]=value
            with self.assertRaises(ValueError):validate_sorting_station(bad,self.devices)
    def test_invalid_position_and_device_references_rejected(self):
        for field,value in [('position_m',[0,float('nan'),0]),('support_device','missing'),('robots',['R1','C2']),('carrier_template','R2')]:
            bad=copy.deepcopy(self.scene);bad['sorting_station'][field]=value
            with self.assertRaises(ValueError):validate_sorting_station(bad,self.devices)
    def test_legacy_scenes_without_station_are_unchanged(self):
        self.assertIsNone(validate_sorting_station({},{}))

if __name__=='__main__':unittest.main()
