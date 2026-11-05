"""Read the user's normative behavior tables and parameter examples."""
import json,re
from pathlib import Path
TYPES=['conveyor','lift_table','material_source_station','robot_arm','rotary_table','storage_rack','workpiece','workpiece_carrier']
def load_norms(folder):
    folder=Path(folder);text=(folder/'schema.md').read_text(encoding='utf-8');markers=list(re.finditer(r'^\*\*([1-8])\. (.*?)\*\*',text,re.M));behaviors={};signals={}
    if len(markers)!=8:raise ValueError('Expected eight canonical device sections')
    for index,m in enumerate(markers):
        end=markers[index+1].start() if index<7 else text.index('## 补充说明一')
        rows={}
        for line in text[m.start():end].splitlines():
            cells=[p.strip().replace('`','') for p in line.strip().strip('|').split('|')]
            if line.startswith('| `') and len(cells)==5 and re.fullmatch(r'[a-z_]+',cells[0]):rows[cells[0]]=cells
        behaviors[TYPES[index]]=rows
        declared={}
        for line in text[m.start():end].splitlines():
            if not re.match(r'^\| (in|out) \|',line):continue
            cells=line.split('|');direction='input' if cells[1].strip()=='in' else 'output'
            for token in re.findall(r'`([^`]+)`',cells[2]):
                if ':' not in token:continue
                names,plc=token.split(':',1);plc=plc.strip()
                if plc not in ('BOOL','INT','DINT','REAL'):continue
                if '～'in names:
                    first,last=names.split('～');parts=re.match(r'([a-z]+)(\d+)(.*)',first);lastnum=int(re.search(r'\d+',last).group())
                    names='/'.join(parts[1]+str(i)+parts[3] for i in range(int(parts[2]),lastnum+1))
                for name in names.split('/'):
                    if not name.strip().endswith('_i'):declared[name.strip()]={'direction':direction,'plc_type':plc}
        signals[TYPES[index]]=declared
    parameters={}
    for block in re.findall(r'```json\s*\n(.*?)```',(folder/'参数契约.md').read_text(encoding='utf-8'),re.S):
        try:value=json.loads(block)
        except ValueError:continue
        if isinstance(value,dict) and 'device_type'in value and 'params_schema'in value:parameters[value['device_type']]=value
    if set(parameters)!=set(TYPES):raise ValueError('Expected all eight parameter examples')
    return dict(behaviors=behaviors,parameters=parameters,signals=signals)
