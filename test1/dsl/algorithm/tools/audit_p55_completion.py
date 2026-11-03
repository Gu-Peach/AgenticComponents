import argparse
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from final_p5.completion_audit import run
if __name__=='__main__':
    p=argparse.ArgumentParser()
    for name in ('workspace','review','triggers','recheck','experiment','scores','efficiency','witnesses','report','static','analysis-plan','visual-qa','output'):
        p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();run(a.workspace,a.review,a.triggers,a.recheck,a.experiment,a.scores,a.efficiency,a.witnesses,a.report,a.static,a.analysis_plan,a.visual_qa,a.output)
