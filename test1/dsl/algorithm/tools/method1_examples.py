"""Reproduce selected method-one integration evidence; never write dataset labels."""
import argparse
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from acverify.pipeline import verify
from acverify.cli import write


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace',type=Path,default=ROOT)
    parser.add_argument('--output',type=Path,default=ROOT/'artifacts/method1-v1/examples')
    args=parser.parse_args();sys.path.insert(0,str(args.workspace/'.deps'))
    jobs=[('S04-P01','nominal','clock','complete','z3-graph'),
          ('S04-P01-DV01','nominal','clock','complete','explicit'),
          ('S04-P01-DV02','nominal','clock','complete','explicit'),
          ('S04-P01-DV03','nominal','clock','complete','explicit'),
          ('S04-P01-DV04','nominal','clock','complete','z3-graph'),
          ('S04-P01','stop_unknown_c1','clock','complete','explicit'),
          ('S03-P02','nominal','clock','complete','explicit'),
          ('S12-P03','nominal','compact','witness','explicit'),
          ('S10-P04','nominal','compact','witness','explicit'),
          ('S01-P01','fault','clock','complete','explicit')]
    rows=[]
    for cid,profile,reduction,search,backend in jobs:
        result,traces,model=verify(args.workspace/'datasets/ac-path-v1/cases'/cid/'case.json',args.workspace,
            profile=profile,bound=3000,states=20000,seconds=5,memory_mb=512,reduction=reduction,search=search,backend=backend)
        dest=args.output/cid/profile;write(dest/'result.json',result)
        if model:write(dest/'model.json',model)
        for name,t in traces.items():write(dest/(name+'.trace.json'),t)
        row={'case_id':cid,'profile':profile,'status':result['status'],'states':result.get('states'),'limit':result.get('limit'),
             'properties':{k:v['verdict'] for k,v in result.get('properties',{}).items()}}
        rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
    write(args.output/'summary.json',rows)


if __name__=='__main__':main()
