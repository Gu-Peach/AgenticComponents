"""Bind each implementation independently from the same raw case files."""
import copy
from pathlib import Path
import sys


def setup(workspace):
    workspace = Path(workspace).resolve()
    for path in (workspace, workspace / 'src'):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    return workspace


def pair(workspace, case_id, profile='nominal'):
    workspace = setup(workspace)
    from acverify.pipeline import build
    from reference.frontend import load
    from reference.transition import ReferenceModel
    sut = build(workspace / 'datasets/ac-path-v1/cases' / case_id / 'case.json', workspace, profile)
    ref = ReferenceModel(load(workspace, case_id, profile))
    return sut, ref


def singleton(workspace, case_id, upper=False, one_action=False, fault=None, feedback=None):
    """Explicit diagnostic restriction, never replace corpus query inputs."""
    sut, ref = pair(workspace, case_id)
    data, env, definition = copy.deepcopy(sut.data), copy.deepcopy(sut.profile), copy.deepcopy(ref.d)
    for field in ('accept', 'phase', 'stop', 'feedback'):
        value = env[field][int(upper)]
        env[field] = [value, value]
        definition.profile[field] = [value, value]
    env.update(faults=[fault] if fault else [], max_faults=int(bool(fault)))
    definition.profile.update(faults=[fault] if fault else [], max_faults=int(bool(fault)))
    if feedback is not None:
        env.update(feedback=[feedback, feedback], max_age=feedback + 2)
        definition.profile.update(feedback=[feedback, feedback], max_age=feedback + 2)
    if one_action:
        from reference.fixtures import set_program
        first = next(n for n in data['ir']['nodes'] if n['kind'] == 'invoke')
        node = first['node_id']
        data['ir']['entry'] = node
        data['ir']['nodes'] = [first]
        data['resolved'] = {node: data['resolved'][node]}
        set_program(definition, definition.nodes[node])
    from acverify.model import TransitionModel
    from reference.transition import ReferenceModel
    return TransitionModel(data, env), ReferenceModel(definition)


def action_definitions(sut, ref):
    left = {k: dict(device=a['device'], behavior=a['behavior'], args=a['arguments'], model=a['model_ref']) for k, a in sut.actions.items()}
    right = {k: dict(device=a['device'], behavior=a['behavior'], args=a['args'], model=a['model']['id']) for k, a in ref.d.actions.items()}
    return left, right


def profile_definitions(sut, ref):
    fields = ('accept', 'phase', 'stop', 'feedback', 'events', 'faults', 'max_faults', 'forced_stop_loss', 'max_age')
    return ({k: sut.profile[k] for k in fields}, {k: ref.d.profile[k] for k in fields})


def node_shapes(sut, ref):
    left, right = {}, {}
    for key, n in sut.nodes.items():
        kind = n['kind']
        value = {'kind': kind}
        if kind in ('seq', 'par'): value['children'] = n['children']
        if kind == 'repeat': value.update(count=n['count'], child=n['child'])
        if kind == 'with-control': value.update(child=n['child'], control=n['control_ref'])
        if kind == 'branch': value.update(mode=n['mode'], children=[c['child'] for c in n['cases']] + [n['otherwise']])
        left[key] = value
    for key, n in ref.d.nodes.items():
        kind = n[0]
        value = {'kind': kind}
        if kind in ('seq', 'par'): value['children'] = [c[1] for c in n[2:]]
        if kind == 'repeat': value.update(count=int(n[2]), child=n[3][1])
        if kind == 'with-control': value.update(child=n[4][1], control=n[2])
        if kind == 'branch': value.update(mode=n[2], children=[c[-1][1] for c in n[4:]])
        right[key] = value
    return left, right
