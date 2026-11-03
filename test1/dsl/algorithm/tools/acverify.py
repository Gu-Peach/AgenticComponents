"""Run the source package without installing it into global Python."""
from pathlib import Path
import sys
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'src'))
if (root/'.deps').is_dir():sys.path.insert(0,str(root/'.deps'))
from acverify.cli import main
if __name__=='__main__':main()
