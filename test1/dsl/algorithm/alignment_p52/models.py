import copy
from pathlib import Path
import sys

BASE=Path(__file__).resolve().parents[1]


def setup(workspace):
    workspace=Path(workspace).resolve()
    for root in (workspace,BASE/'src'):
        if str(root) not in sys.path:sys.path.insert(0,str(root))
    return workspace


def pair(workspace,case_id,profile='nominal',fast_copy=False):
    workspace=setup(workspace)
    from acverify_v3.pipeline import build
    from reference.frontend import load
    from reference.transition import ReferenceModel
    return build(workspace/'datasets/ac-path-v1/cases'/case_id/'case.json',workspace,profile,fast_copy),ReferenceModel(load(workspace,case_id,profile))


def fixture(workspace,case='S04-P01',single=False,upper=False,feedback=None,faults=(),stop=None,stop_ticks=None):
    sut,ref=pair(workspace,case)
    data,profile,d=copy.deepcopy(sut.data),copy.deepcopy(sut.profile),copy.deepcopy(ref.d)
    for key in ('accept','phase','stop','feedback'):
        v=profile[key][int(upper)];profile[key]=[v,v];d.profile[key]=[v,v]
    profile.update(faults=list(faults),max_faults=int(bool(faults)));d.profile.update(faults=list(faults),max_faults=int(bool(faults)))
    if feedback is not None:
        profile.update(feedback=[feedback,feedback],max_age=feedback+2);d.profile.update(feedback=[feedback,feedback],max_age=feedback+2)
    if stop is not None:profile['stop']=list(stop);d.profile['stop']=list(stop)
    if stop_ticks is not None:
        for policies in (data['environment']['policies'],d.env['policies']):
            for p in policies.values():p['stop_ticks']=stop_ticks
    if single:
        first=next(n for n in data['ir']['nodes'] if n['kind']=='invoke');key=first['node_id']
        data['ir']['entry']=key;data['ir']['nodes']=[first];data['resolved']={key:data['resolved'][key]}
        from reference.fixtures import set_program
        set_program(d,d.nodes[key])
    from acverify_v3.model import TransitionModel
    from reference.transition import ReferenceModel
    return TransitionModel(data,profile),ReferenceModel(d)
