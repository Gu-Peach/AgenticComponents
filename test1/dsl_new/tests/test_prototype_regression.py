"""Keep earlier frontends reproducible against their frozen inputs."""
import subprocess,sys,unittest,os
from pathlib import Path
class PrototypeRegression(unittest.TestCase):
 def test_frozen_frontends(self):
  root=Path(os.environ.get('DSL_ARCHIVE_ROOT',Path(__file__).resolve().parents[1]/'legacy/ac-python-0.1'))
  result=subprocess.run([sys.executable,'-B','-m','unittest','discover','-s','tests','-p','test_*.py'],cwd=root,capture_output=True,text=True)
  self.assertEqual(0,result.returncode,result.stdout+result.stderr)
if __name__=='__main__':unittest.main()
