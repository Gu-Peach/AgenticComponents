import argparse
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from final_p5.efficiency import build
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--scores',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();build(a.scores,a.output)
