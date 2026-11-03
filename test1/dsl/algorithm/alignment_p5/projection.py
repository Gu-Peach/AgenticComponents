"""A public-state diagnostic projection, not a bisimulation relation."""
import copy


def public_state(state, reference=False):
    w = state['plant' if reference else 'world']
    materials = {k: {f: v[f] for f in ('type', 'region', 'support', 'holder', 'held_by')} for k, v in w['materials'].items()}
    devices = {}
    fields = ('drive', 'run_command', 'held_material', 'clamped_material', 'access_closed', 'permit', 'actual_index', 'actual_level', 'epoch')
    for k, v in w['devices'].items():
        devices[k] = {f: v[f] for f in fields}
        devices[k]['cycle_counts'] = {m: v['cycle_counts'].get(m, 0) for m in materials}
        devices[k]['operation_history'] = sorted(v['operation_history'], key=lambda r: (r['request'], r['material']))
    external = {k: {f: v.get(f) for f in ('value', 'valid', 'provider_epoch')} for k, v in w['external'].items()}
    return copy.deepcopy(dict(tick=state['tick'], outcome=state['outcome'], materials=materials, devices=devices,
        occupancy={k: sorted(v) for k, v in w['ledger' if reference else 'occupancy'].items()},
        grants=w['grants'], reservations=w['reservations'], external=external,
        committed=sorted(w['commits'] if reference else w['committed'])))


def differences(left, right, path='', limit=30):
    rows = []
    def walk(a, b, p):
        if len(rows) >= limit: return
        if type(a) is dict and type(b) is dict:
            for k in sorted(set(a) | set(b)):
                if k not in a or k not in b:
                    rows.append(dict(path=p + '/' + k, sut=a.get(k), reference=b.get(k), missing='sut' if k not in a else 'reference'))
                else: walk(a[k], b[k], p + '/' + k)
        elif a != b or type(a) is not type(b):
            rows.append(dict(path=p or '/', sut=a, reference=b))
    walk(left, right, path)
    return rows


def choose_step(model, state, fault=None):
    """Only accept a unique successor for this explicit singleton schedule."""
    matches = []
    generator = model.successors(state)
    try:
        for nxt, events in generator:
            injected = [e for e in events if e['kind'] == 'fault']
            if (not injected if fault is None else len(injected) == 1 and injected[0]['fault'] == fault):
                matches.append((nxt, events))
                if len(matches) > 1: break
    finally:
        generator.close()
    if len(matches) != 1:
        raise ValueError('Diagnostic schedule is not uniquely coupled: ' + str(len(matches)))
    return matches[0]


def paired_trace(sut, ref, bound=512, fault_tick=None, fault=None):
    a, b = copy.deepcopy(sut.initial), copy.deepcopy(ref.initial)
    tape = [dict(tick=0, sut=a, reference=b, sut_events=[], reference_events=[])]
    for tick in range(bound + 1):
        diff = differences(public_state(a), public_state(b, True))
        if diff:
            return dict(status='DIVERGED', first_difference_tick=tick, differences=diff, steps=tape,
                        sut_model_digest=sut.model_digest, reference_model_digest=ref.model_digest,
                        scope='Unique coupled singleton schedule; public-state projection only.')
        if a['outcome'] != 'running' or b['outcome'] != 'running':
            return dict(status='MATCHED_TERMINAL_PROJECTION', last_tick=tick, steps=tape,
                        sut_model_digest=sut.model_digest, reference_model_digest=ref.model_digest,
                        scope='One restricted schedule; not model equivalence or query admission.')
        if tick == bound: break
        selected = fault if tick + 1 == fault_tick else None
        a, ae = choose_step(sut, a, selected)
        b, be = choose_step(ref, b, selected)
        tape.append(dict(tick=tick + 1, sut=copy.deepcopy(a), reference=copy.deepcopy(b), sut_events=ae, reference_events=be))
    return dict(status='PREFIX_ONLY', last_tick=bound, steps=tape, sut_model_digest=sut.model_digest,
                reference_model_digest=ref.model_digest, scope='No conclusion beyond this prefix or schedule.')


def replay_pair(sut, ref, payload):
    if payload['sut_model_digest'] != sut.model_digest or payload['reference_model_digest'] != ref.model_digest:
        raise ValueError('Diagnostic model binding changed')
    first = payload['steps'][0]
    if first['sut'] != sut.initial or first['reference'] != ref.initial:
        raise ValueError('Trace initial state mismatch')
    if first['tick'] != 0:
        raise ValueError('Initial trace timestamp changed')
    prior = first
    for step in payload['steps'][1:]:
        if step['tick'] != prior['tick']+1 or any(step[side]['tick']!=step['tick'] for side in ('sut','reference')):
            raise ValueError('Trace timestamp differs from state clocks')
        if differences(public_state(prior['sut']), public_state(prior['reference'], True)):
            raise ValueError('Earlier difference was omitted')
        for model, side in ((sut, 'sut'), (ref, 'reference')):
            gen = model.successors(prior[side])
            try:
                if not any(n == step[side] and e == step[side + '_events'] for n, e in gen):
                    raise ValueError('Illegal ' + side + ' step at ' + str(step['tick']))
            finally: gen.close()
        prior = step
    diff = differences(public_state(prior['sut']), public_state(prior['reference'], True))
    if (payload['status'] == 'DIVERGED') != bool(diff):
        raise ValueError('Difference label does not match terminal projection')
    if diff and (payload['first_difference_tick'] != prior['tick'] or payload['differences'] != diff):
        raise ValueError('First difference record changed')
    if payload['status'] == 'MATCHED_TERMINAL_PROJECTION' and any(prior[k]['outcome']=='running' for k in ('sut','reference')):
        raise ValueError('Running prefix mislabeled as a terminal match')
    if payload['status'] in ('MATCHED_TERMINAL_PROJECTION','PREFIX_ONLY') and payload['last_tick'] != prior['tick']:
        raise ValueError('Last trace timestamp changed')
    return dict(checked_steps=len(payload['steps']) - 1, differences=diff, initial_equal=True)
