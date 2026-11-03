"""Structural proof rules are admitted only for an explicitly reviewed kernel."""
import hashlib
import json
from pathlib import Path
from reference import transition


def check_kernel(model):
    policy=json.loads((Path(__file__).parent/'trusted-kernel.json').read_text(encoding='utf8'))
    if type(model) is not transition.ReferenceModel or model.version!=policy['reference_version']:
        raise ValueError('Unreviewed reference implementation')
    root=Path(transition.__file__).parent
    for relative,expected in policy['reference_files'].items():
        actual=hashlib.sha256((root/relative).read_bytes()).hexdigest()
        if actual!=expected:raise ValueError('Trusted reference kernel changed: '+relative)
    return policy['id']


def check_workspace(workspace):
    policy=json.loads((Path(__file__).parent/'trusted-kernel.json').read_text(encoding='utf8'))
    for relative,expected in policy['workspace_files'].items():
        if hashlib.sha256((Path(workspace)/relative).read_bytes()).hexdigest()!=expected:
            raise ValueError('Reviewed normalization input changed: '+relative)
