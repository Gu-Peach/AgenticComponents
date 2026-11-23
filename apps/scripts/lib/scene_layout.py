"""Validate scene-level process points without treating candidate poses as calibrated."""
import math

def validate_sorting_station(manifest,devices):
    station=manifest.get('sorting_station')
    if station is None:return None
    coordinates=manifest.get('coordinate_system',{})
    if coordinates!={'frame':'scene_world_m','length_unit':'m','up_axis':'Y'}:raise ValueError('Sorting station requires an explicit metre/Y-up scene frame')
    if station.get('frame')!=coordinates['frame'] or station.get('reference')!='carrier_origin':raise ValueError('Sorting station frame/reference is invalid')
    position=station.get('position_m')
    if not isinstance(position,list) or len(position)!=3 or not all(type(v)in(int,float) and math.isfinite(v) for v in position):raise ValueError('Sorting station position must have three finite coordinates')
    if not isinstance(station.get('id'),str) or not station['id']:raise ValueError('Sorting station ID is missing')
    support=devices.get(station.get('support_device'))
    if not support or support['contract'].get('device_type') not in ('conveyor','lift_table','rotary_table'):raise ValueError('Sorting station support device is invalid')
    carrier=devices.get(station.get('carrier_template'))
    if not carrier or carrier.get('asset_kind')!='carrier_prefab':raise ValueError('Sorting station carrier template is invalid')
    robots=station.get('robots')
    if not isinstance(robots,list) or not robots or not all(isinstance(id,str) for id in robots) or len(set(robots))!=len(robots):raise ValueError('Sorting station robot references are invalid')
    if any(devices.get(id,{}).get('contract',{}).get('device_type')!='robot_arm' for id in robots):raise ValueError('Sorting station robot is not declared')
    if type(station.get('capacity'))is not int or station['capacity']<1:raise ValueError('Sorting station capacity must be positive')
    if station.get('status')!='candidate':raise ValueError('Sorting station has no execution-calibration evidence')
    return station

def bind_position_targets(manifest,devices):
    station=validate_sorting_station(manifest,devices)
    for id,device in devices.items():
        if device['contract'].get('device_type')!='conveyor':continue
        targets={key:{'reference':'carrier_origin',**location} for key,location in device.get('locations',{}).items() if 'position' in location}
        if station and station['support_device']==id:targets['scene.'+station['id']]={'frame':station['frame'],'position':station['position_m'],'reference':station['reference'],'status':station['status']}
        device['position_targets']=targets
        groups=[g for g in manifest.get('drive_groups',{}).values() if id in g['members']]
        if len(groups)>1:raise ValueError('Conveyor belongs to multiple drive groups')
        if groups:
            if any(member not in devices or devices[member]['contract'].get('device_type')!='conveyor' for member in groups[0]['members']):raise ValueError('Invalid group member')
            device['drive_group']=groups[0]
