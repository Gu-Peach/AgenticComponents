import argparse
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from final_p5.report import build
if __name__=='__main__':
    p=argparse.ArgumentParser()
    for name in ('review','experiment','scores','efficiency','witnesses','static','output'):p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();build(a.review,a.experiment,a.scores,a.efficiency,a.witnesses,a.static,a.output)
