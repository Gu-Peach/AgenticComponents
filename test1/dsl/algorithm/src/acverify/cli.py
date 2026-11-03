"""CLI for check/build/verify/replay/benchmark; datasets and answers remain unchanged."""
import argparse
import json
from pathlib import Path
import sys
from .core import read_json, VerificationError
from .pipeline import check,build,verify
from .diagnostics import replay


def write(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['check','build','verify','replay','benchmark'])
    parser.add_argument('input',type=Path)
    parser.add_argument('--workspace',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--profile',default='nominal');parser.add_argument('--bound',type=int,default=256)
    parser.add_argument('--states',type=int,default=20000);parser.add_argument('--seconds',type=float,default=30)
    parser.add_argument('--memory-mb',type=int,default=512);parser.add_argument('--reduction',choices=['full','compact','clock','auto'],default='auto')
    parser.add_argument('--search',choices=['complete','witness'],default='complete');parser.add_argument('--backend',choices=['explicit','z3-graph'],default='explicit')
    parser.add_argument('--output',type=Path);parser.add_argument('--trace',type=Path)
    parser.add_argument('--optimization',choices=['none','storage','portfolio'],default='none')
    parser.add_argument('--target-properties',nargs='+')
    parser.add_argument('--limit',type=int,default=0);parser.add_argument('--parents-only',action='store_true')
    parser.add_argument('--quiet',action='store_true');parser.add_argument('--summary-only',action='store_true')
    args=parser.parse_args()
    if min(args.bound,args.states,args.seconds,args.memory_mb)<=0:parser.error('Budgets must be positive')
    deps=args.workspace/'.deps'
    if deps.is_dir():sys.path.insert(0,str(deps))
    if args.command=='check':
        result=check(args.input,args.workspace)
        if args.output:write(args.output,result)
    elif args.command=='build':
        try:result=build(args.input,args.workspace,args.profile).export()
        except VerificationError as error:result={'status':error.code,'message':str(error),'details':error.details}
        if args.output:write(args.output,result)
    elif args.command=='replay':
        if not args.trace:parser.error('--trace is required')
        witness=read_json(args.trace);model=build(args.input,args.workspace,args.profile)
        result=replay(model,witness)
        if args.output:write(args.output,result)
    else:
        if not args.output:parser.error('--output is required for verify and benchmark')
        if args.command=='benchmark':
            manifest=read_json(args.input);root=args.input.parent
            ids=manifest['cases']
            if args.parents_only:ids=[c for c in ids if read_json(root/'cases'/c/'case.json')['parent_id'] is None]
            if args.limit:ids=ids[:args.limit]
            inputs=[root/'cases'/c/'case.json' for c in ids]
        else:inputs=[args.input]
        rows=[];full_results=[]
        for index,case in enumerate(inputs,1):
            result,traces,ir=verify(case,args.workspace,args.profile,args.bound,args.states,args.seconds,args.memory_mb,args.reduction,args.search,args.backend,optimization=args.optimization,target_properties=args.target_properties)
            cid=result.get('case_id',case.parent.name if case.name=='case.json' else case.name)
            dest=args.output/cid
            result['witnesses_saved']=not args.summary_only
            if not args.summary_only:
                write(dest/'result.json',result)
                if ir:write(dest/'model.json',ir)
                for key,w in traces.items():write(dest/(key+'.trace.json'),w)
            row={'case_id':cid,'status':result.get('status'),'states':result.get('states'),
                 'finite_model_exhausted':result.get('finite_model_exhausted'), 'limit':result.get('limit'),
                 'properties':{k:v['verdict'] for k,v in result.get('properties',{}).items()}}
            rows.append(row);full_results.append(result)
            if not args.quiet:print(json.dumps(row,ensure_ascii=False),flush=True)
            elif index%25==0 or index==len(inputs):print(f'Checked {index}/{len(inputs)}',flush=True)
        write(args.output/'summary.json',rows)
        if args.summary_only:write(args.output/'results.json',full_results)
        return
    print(json.dumps(result,ensure_ascii=False,indent=2))
    if result.get('status') not in (None,'VALID_INPUT','CHECKED'):raise SystemExit(2)


if __name__=='__main__':main()
