"""Explicitly refresh dependency locks after reviewing pilot input/tool edits."""
import argparse
import hashlib
import json
from pathlib import Path
from pilot_frontend import read


def freeze(dataset,dsl_root):
    dataset=Path(dataset).resolve(); dsl_root=Path(dsl_root).resolve(); tool=Path(__file__).resolve().parent
    common=list((dataset/'shared').rglob('*.json'))+list((dataset/'scenes/S04').glob('*.json'))
    tool_files=[tool/n for n in ('pilot_frontend.py','pilot_model.py','pilot_verify.py')]
    dsl_files=[dsl_root/n for n in ('tools/check_design.py','process-ir.schema.json','01-language.md','02-ir.md','language.ebnf')]
    selected=[c for c in read(dataset/'manifest.json')['cases'] if read(dataset/'cases'/c/'case.json').get('profile_scope')=='s04-pilot-timed-microsteps/0.1']
    for cid in selected:
        folder=dataset/'cases'/cid; descriptor=read(folder/'case.json')
        inputs=[folder/'case.json']+[(folder/v).resolve() for v in descriptor['inputs'].values()]
        rows=[]
        for label,root,paths in [('dataset',dataset,common+inputs),('dsl',dsl_root,dsl_files),('tool',tool,tool_files)]:
            for path in sorted(set(paths)):
                if not path.is_relative_to(root): raise ValueError('dependency outside root')
                rows.append({'root':label,'path':path.relative_to(root).as_posix(),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
        (folder/'dependencies.lock.json').write_text(json.dumps({'version':'0.1','files':rows},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return len(selected)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--dataset',type=Path,default=Path(__file__).resolve().parents[1]/'datasets/ac-path-v1')
    p.add_argument('--dsl-root',type=Path,default=Path(__file__).resolve().parents[2])
    p.add_argument('--write',action='store_true',required=True)
    args=p.parse_args(); print(f'Locked {freeze(args.dataset,args.dsl_root)} cases')
