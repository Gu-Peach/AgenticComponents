import argparse
from pathlib import Path
import sys
BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from alignment_p5.gate import assert_comparable

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',type=Path,required=True);parser.add_argument('--audit',type=Path,required=True)
    a=parser.parse_args()
    try:print(assert_comparable(a.workspace,a.audit))
    except ValueError as e:
        print(str(e));sys.exit(2)
