"""Entry point for the current batch DSL checker."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from check_batches import check_all,check_scene,read,main
if __name__=="__main__":sys.exit(main())
