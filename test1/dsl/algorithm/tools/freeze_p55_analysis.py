"""Pin scoring/audit/interval implementations before opening prediction values."""
import argparse
from pathlib import Path
import sys
BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from final_p5.common import read,write,sha

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--experiment',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    if a.output.exists():raise ValueError('Analysis plan already exists')
    plan=read(a.experiment/'plan.json')
    if sha(BASE/'final_p5/scoring.py')!=plan['scoring_source_sha256']:raise ValueError('Scorer differs from frozen run plan')
    write(a.output,dict(prediction_plan_sha256=sha(a.experiment/'plan.json'),scoring_source_sha256=sha(BASE/'final_p5/scoring.py'),
        efficiency_source_sha256=sha(BASE/'final_p5/efficiency.py'),witness_auditor_sha256=sha(BASE/'final_p5/witness_audit.py'),
        prediction_rows_read_for_development=False,formulas_predeclared_in_run_plan=plan['metric_contract'],
        refinement='Scene-cluster percentile intervals for predeclared joint-complete paired runtime ratios; no timeouts treated as completed times.',
        stage='before prediction sealing and scoring'))
    print(str(a.output))
