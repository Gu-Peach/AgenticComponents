import argparse
from pathlib import Path
import sys
BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--review',type=Path);p.add_argument('--worker',action='store_true');p.add_argument('--job',type=Path);p.add_argument('--plan-only',action='store_true')
    a=p.parse_args()
    if a.worker:
        from final_p5.worker import execute
        print(execute(a.workspace,a.job,a.output.resolve()))
    else:
        from final_p5.experiment import run
        if a.review is None:p.error('--review is required')
        run(a.workspace,a.review,a.output,BASE,a.plan_only)
