"""Freeze dependencies for all corpus inputs; never create truth labels."""
import argparse
import hashlib
import json
from pathlib import Path


def read(path):return json.loads(Path(path).read_text(encoding='utf-8'))
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def freeze(root,dsl):
    root=Path(root).resolve();dsl=Path(dsl).resolve();tool=Path(__file__).resolve().parent
    shared=sorted((root/'shared').rglob('*.json'))
    tool_files=sorted(tool.glob('*.py'))
    dsl_files=[dsl/name for name in ['tools/check_design.py','process-ir.schema.json','01-language.md','02-ir.md','language.ebnf']]
    cache={}
    def hashed(p):
        if p not in cache:cache[p]=sha(p)
        return cache[p]
    for cid in read(root/'manifest.json')['cases']:
        folder=root/'cases'/cid;case=read(folder/'case.json')
        inputs=[folder/'case.json']+[(folder/v).resolve() for v in case['inputs'].values()]
        if (folder/'mutation.json').exists():inputs.append(folder/'mutation.json')
        scene=sorted((root/'scenes'/case['scene_id']).glob('*.json'))
        entries=[]
        for label,base,files in [('dataset',root,shared+scene+inputs),('dsl',dsl,dsl_files),('tool',tool,tool_files)]:
            for path in sorted(set(files)):
                if not path.is_relative_to(base):raise ValueError('outside dependency root')
                entries.append({'root':label,'path':path.relative_to(base).as_posix(),'sha256':hashed(path)})
        (folder/'dependencies.lock.json').write_text(json.dumps({'version':'0.1','files':entries,'oracle_excluded':True},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    for pair in (root/'equivalents').iterdir():
        if pair.is_dir():
            entries={p.name:sha(p) for p in pair.iterdir() if p.is_file() and p.name!='dependencies.lock.json'}
            (pair/'dependencies.lock.json').write_text(json.dumps({'files':entries,'equivalence_proven':False},indent=2)+'\n',encoding='utf-8')
    for change in (root/'changes').iterdir():
        if change.is_dir():
            entries={p.relative_to(change).as_posix():sha(p) for p in change.rglob('*') if p.is_file() and p.name!='dependencies.lock.json'}
            (change/'dependencies.lock.json').write_text(json.dumps({'files':entries,'regression_run':False},indent=2)+'\n',encoding='utf-8')
    return len(read(root/'manifest.json')['cases'])


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--dataset',type=Path,required=True);p.add_argument('--dsl-root',type=Path,required=True);p.add_argument('--write',action='store_true',required=True)
    a=p.parse_args();print(f'Frozen {freeze(a.dataset,a.dsl_root)} case dependency locks')
