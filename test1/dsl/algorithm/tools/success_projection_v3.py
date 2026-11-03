"""Independent over-approximation of successful poststates, not a timed runner.

Guards are erased and every branch is retained. Thus a negative reachability
answer is sound only if every resulting poststate misses the independent goal.
No acverify imports, solver outputs or pre-existing answer labels are used.
"""
import copy
import hashlib
import itertools
import json
from build_standard_answers import RefError, require, expr_children


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


class SuccessProjection:
    def __init__(self, case, max_states=2048, max_steps=100000):
        self.case = case
        self.max_states, self.max_steps = max_states, max_steps
        self.steps = 0
        self.proof = []
        self.has_parallel = any(n[0] == 'par' for n in case.nodes.values())
        require(not case.env.get('events'), 'PROJECTION_UNSUPPORTED',
                'Absolute-time external writes require a separate stability proof')
        self.initial = {}
        raw = case.initial
        for m in raw['materials']:
            for k in ('region', 'holder', 'support', 'held_by'):
                self.initial['m|' + m['id'] + '|' + k] = (raw[k] if raw.get('material') == m['id'] else m[k])
        if 'material' in raw:
            for k in ('region', 'holder', 'support', 'held_by'):
                self.initial['m|' + raw['material'] + '|' + k] = raw[k]
        for d in case.devices:
            ds = raw.get('device_states', {}).get(d, {})
            for k, default in [('drive', 'stopped'), ('held_material', None),
                               ('clamped_material', None), ('actual_index', 0), ('actual_level', 0)]:
                self.initial['d|' + d + '|' + k] = ds.get(k, default)
            if 'drives' in raw:
                self.initial['d|' + d + '|drive'] = raw['drives'].get(d, 'stopped')
            for m in raw['materials']:
                self.initial['op|' + d + '|' + m['id']] = sum(
                    r['material'] == m['id'] for r in ds.get('operation_history', []))
                self.initial['cycle|' + d + '|' + m['id']] = ds.get('cycle_counts', {}).get(m['id'], 0)
        for key, v in raw.get('external', {}).items():
            self.initial['external|' + key] = v['value'] if v.get('valid') is True else None
        self._validate_models()

    def _validate_models(self):
        # The theorem requires all phases exactly once on successful completion.
        for m in self.case.used_models.values():
            phases = m['phases']
            ids = [p['id'] for p in phases]
            require(bool(ids) and len(ids) == len(set(ids)), 'PROJECTION_UNSUPPORTED', 'Nonlinear phase graph')
            for i, p in enumerate(phases):
                require(p['successor'] == (ids[i + 1] if i + 1 < len(ids) else 'completed')
                        and p['fault_successor'] == 'stopping'
                        and p.get('request_identity_preserved') is True,
                        'PROJECTION_UNSUPPORTED', 'Success/failure or request identity rule changed')
            require(all(x.get('preserve_effects') is True for x in m['failure_outcomes']),
                    'PROJECTION_UNSUPPORTED', 'Undeclared recovery semantics')

    def owner(self, location):
        return self.case.locations[location]['owner']

    def apply(self, s, action, call, writes):
        values = {'device': action['device'], 'request': '<fresh-request>', **action['args']}
        a = [values[x[1:]] if isinstance(x, str) and x.startswith('$') else x for x in call['args']]
        op = call['effect']
        def put(key, value):
            s[key] = value
            writes.add(key)
        def mat(mid, **fields):
            for k, v in fields.items(): put('m|' + mid + '|' + k, v)
        def dev(d, **fields):
            for k, v in fields.items(): put('d|' + d + '|' + k, v)
        if op in ('reserve_target', 'publish_success'): return
        if op == 'capture':
            mat(a[0], held_by=a[1]); dev(a[1], held_material=a[0])
        elif op == 'clear_source':
            mat(a[0], region=a[2] + '.tool', support=a[2] + '.tool', holder=a[2])
        elif op == 'place_supported': mat(a[0], region=a[1], support=a[1])
        elif op == 'release_tool':
            mat(a[0], held_by=None); dev(a[1], held_material=None)
        elif op in ('commit_transfer', 'emit_registered'):
            mat(a[0], region=a[1], support=a[1], holder=self.owner(a[1]))
        elif op in ('advance_to_exit', 'wrap_to_entry'):
            loc = a[1] + ('.exit' if op == 'advance_to_exit' else '.entry')
            mat(a[0], region=loc, support=loc)
        elif op in ('increment_cycle', 'record_operation'):
            key = ('cycle|' if op == 'increment_cycle' else 'op|') + a[1] + '|' + a[0]
            put(key, s[key] + 1)
        elif op == 'clamp_workpiece': dev(a[1], clamped_material=a[0])
        elif op == 'unclamp_workpiece': dev(a[1], clamped_material=None)
        elif op in ('begin_index', 'begin_lift'):
            dev(a[0], drive='indexing' if op == 'begin_index' else 'moving')
        elif op == 'finish_index': dev(a[1], actual_index=a[0], drive='stopped')
        elif op == 'finish_lift': dev(a[1], actual_level=a[0], drive='stopped')
        else: raise RefError('PROJECTION_UNSUPPORTED', 'Effect: ' + op)

    def unique(self, values):
        result = {}
        for s, w in values:
            key = digest(s)
            result[key] = (s, w | result.get(key, (None, set()))[1])
        require(len(result) <= self.max_states, 'PROJECTION_LIMIT', 'Poststate budget')
        return list(result.values())

    def node(self, n, state):
        self.steps += 1
        require(self.steps <= self.max_steps, 'PROJECTION_LIMIT', 'Proof expansion budget')
        kind = n[0]; s = copy.deepcopy(state); writes = set()
        if kind == 'invoke':
            a = self.case.actions[n[1]]
            for phase in a['model']['phases']:
                for call in phase['effects']: self.apply(s, a, call, writes)
            out = [(s, writes)]
        elif kind in ('await', 'delay'):
            out = [(s, writes)]  # Erasing a guard adds paths; it cannot prove existence.
        elif kind == 'fail': out = []
        elif kind in ('seq', 'repeat'):
            out = [(s, writes)]
            children = n[2:] if kind == 'seq' else [n[3]] * int(n[2])
            for child in children:
                out = self.unique([(new, old_w | w) for old, old_w in out
                                   for new, w in self.node(child, old)])
        elif kind == 'branch':
            children = expr_children(n)
            if not self.has_parallel:
                # Only world observations are eligible for pruning. Request-scoped
                # reads need a separate dominance/freshness argument.
                def world_only(p):
                    if p[0] == 'condition': return world_only(self.case.conditions[p[1]])
                    if p[0] in ('all', 'any', 'not'): return all(world_only(x) for x in p[1:])
                    return p[0] == 'is' and p[1][1] == 'world'
                if all(world_only(item[1]) for item in n[4:-1]):
                    try:
                        values = [self.truth(s, self.case.condition_expr(item[1])) for item in n[4:-1]]
                        children = ([] if n[2] == 'exclusive' and sum(values) > 1 else
                                    [children[values.index(True) if True in values else -1]])
                    except RefError:
                        pass
            out = self.unique([v for child in children for v in self.node(child, s)])
        elif kind == 'with-control':
            c = self.case.controls[self.case.env['controls'][n[2]]]
            contract = self.case.models[c['contract_ref']]
            require(contract['enter']['writes']['run'] is True and contract['exit']['writes']['run'] is False,
                    'PROJECTION_UNSUPPORTED', 'Control enter/exit template')
            key = 'd|' + c['owner'] + '|drive'; s[key] = 'moving'
            out = self.node(n[4], s)
            for new, w in out: new[key] = 'stopped'; w.add(key)
        elif kind == 'par':
            groups = [self.node(child, s) for child in n[2:]]
            footprints = [set().union(*(w for _, w in g)) if g else set() for g in groups]
            require(all(not a.intersection(b) for i, a in enumerate(footprints) for b in footprints[i+1:]),
                    'PROJECTION_UNSUPPORTED', 'Parallel branches have overlapping successful effects')
            out = []
            # Disjoint writes commute. Branch guards stay erased, including reads of peers.
            for choice in itertools.product(*groups):
                new = copy.deepcopy(s); w = set()
                for post, footprint in choice:
                    for key in footprint: new[key] = post[key]
                    w |= footprint
                out.append((new, w))
                require(len(out) <= self.max_states, 'PROJECTION_LIMIT', 'Parallel product budget')
            out = self.unique(out)
        else: raise RefError('PROJECTION_UNSUPPORTED', 'Node: ' + kind)
        self.proof.append({'node': n[1], 'rule': kind, 'pre': digest(state),
                           'posts': sorted(digest(v) for v, _ in out),
                           'writes': sorted(set().union(*(w for _, w in out)) if out else set())})
        return out

    def truth(self, s, e):
        op = e['op']; m = e.get('material'); d = e.get('device')
        if op == 'all': return all(self.truth(s, a) for a in e['args'])
        if op == 'any': return any(self.truth(s, a) for a in e['args'])
        if op == 'not': return not self.truth(s, e['arg'])
        if op == 'false': return False
        if op in ('no_active_requests', 'no_grants'): return True
        if op in ('at', 'supported', 'holder'):
            field = {'at': 'region', 'supported': 'support', 'holder': 'holder'}[op]
            return s['m|' + m + '|' + field] == e['device' if op == 'holder' else 'location']
        if op == 'tools_empty': return all(s['d|' + dev + '|held_material'] is None for dev in self.case.devices)
        if op == 'drives_stopped': return all(s['d|' + dev + '|drive'] == 'stopped' for dev in self.case.devices)
        if op == 'drive_stopped': return s['d|' + d + '|drive'] == 'stopped'
        if op == 'unclamped': return s['d|' + d + '|clamped_material'] is None
        if op == 'index_is': return s['d|' + d + '|actual_index'] == e['value']
        if op in ('operation_count', 'cycle_count'):
            return s[('op|' if op == 'operation_count' else 'cycle|') + d + '|' + m] >= e['count']
        if op == 'external':
            value = s['external|' + e['key']]
            require(type(value) is bool, 'PROJECTION_UNSUPPORTED', 'Unknown goal fact')
            return value
        raise RefError('PROJECTION_UNSUPPORTED', 'Goal: ' + op)

    def run(self):
        posts = self.node(self.case.body, self.initial)
        goals = [self.truth(s, self.case.goal_expr()) for s, _ in posts]
        raw = self.case.task['goal']
        if 'op' not in raw:
            goals = [value and s['m|' + raw['material'] + '|held_by'] == raw['held_by']
                     for value, (s, _) in zip(goals, posts)]
        conclusions = {}
        if all(goals): conclusions['V09'] = 'HOLDS'
        if not any(goals): conclusions['V10a'] = 'UNREACHABLE'
        return {'kind': 'successful_poststate_overapproximation/0.3', 'case_id': self.case.id,
                'input_hashes': copy.deepcopy(self.case.hashes), 'premises': {
                    'no_absolute_external_events': True, 'linear_exactly_once_success_phases': True,
                    'failure_cannot_continue_to_root_success': 'method1-semantics/0.2',
                    'guards_erased_except_stable_sequential_world_branch': True,
                    'parallel_effects_disjoint_when_present': True,
                    'no_unmodeled_autonomous_effects': 'symbolic plant assumption'},
                'proof_tree': self.proof, 'poststates': [s for s, _ in posts],
                'goal_values': goals, 'conclusions': conclusions,
                'scope': 'Universal successful-poststate claims only; no positive reachability or timing claim'}


def check_certificate(case, certificate):
    fresh = SuccessProjection(case).run()
    require(digest(fresh) == digest(certificate), 'BAD_CERTIFICATE', 'Proof/input/poststate mismatch')
    return {'checked': True, 'checker': 'success_projection_v3', 'proof_sha256': digest(fresh)}
