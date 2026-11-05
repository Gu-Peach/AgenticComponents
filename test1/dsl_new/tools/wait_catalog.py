"""The shared wait-predicate declarations used by both DSL checking layers."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def load_catalog(path=None):
    data=json.loads((path or ROOT/'language/wait-predicates.json').read_text(encoding='utf-8'))
    if data['schema_version']!='ac-wait-predicates/0.1':raise ValueError('Unknown wait catalog version')
    predicates={}
    for record in data['predicates']:
        name=record['name'];parameters=record['parameters']
        if name in predicates or not name.isidentifier() or name.startswith('_'):raise ValueError('Duplicate or invalid wait name')
        if not parameters or len({p['name'] for p in parameters})!=len(parameters):raise ValueError('Invalid wait signature')
        if any(p['type'] not in ('material_ref','location_ref','device_ref','pallet_ref') for p in parameters):raise ValueError('Invalid wait reference type')
        if not record['providers'] or not record['description']:raise ValueError('Missing wait evidence definition')
        predicates[name]=record
    return predicates

PREDICATES=load_catalog()
ARITIES={name:len(record['parameters']) for name,record in PREDICATES.items()}

def render_table():
    lines=['| 方法 | 参数 | 等待什么 |','| --- | --- | --- |']
    for name,record in PREDICATES.items():
        lines.append('| `wait.'+name+'` | '+', '.join(p['name'] for p in record['parameters'])+' | '+record['description']+' |')
    return '\n'.join(lines)

if __name__=='__main__':print(render_table())
