"""R1 command line; default plan is separate from the frozen P5 experiment."""
from pathlib import Path
import argparse
import sys
BASE=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(BASE),str(BASE/'src'),str(BASE/'.deps')]
from r1_experiment.runner import prepare,run,worker

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=('prepare','run','smoke','worker'))
    p.add_argument('--workspace',type=Path,default=BASE)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--spec',type=Path)
    p.add_argument('--profiling',action='store_true')
    a=p.parse_args()
    if a.action=='prepare':
        plan=prepare(a.workspace,a.output)
        print({k:plan[k] for k in ('id','roles','search_seconds_ceiling')})
    elif a.action=='worker':
        if a.spec is None:p.error('--spec required')
        print(worker(a.workspace,a.spec,a.output,a.profiling),flush=True)
    else:run(a.workspace,a.output,a.action=='smoke')
