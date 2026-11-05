"""Run former interface checks only against their frozen former assets."""
import subprocess,sys,unittest
from pathlib import Path
class PreviousDeclarations(unittest.TestCase):
 def test_frozen_device_contract_stage(self):
  root=Path(__file__).resolve().parents[1]/'legacy/pre-device-spec'
  result=subprocess.run([sys.executable,'-B','-m','unittest','discover','-s','tests','-p','test_*.py'],cwd=root,capture_output=True,text=True)
  self.assertEqual(0,result.returncode,result.stdout+result.stderr)
