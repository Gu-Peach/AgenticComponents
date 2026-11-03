"""Independent finite interleaving oracle for the handoff contract kernel.

This is an untimed abstraction. It does not label whole-line timed queries and
does not import the tested transition system. Faults preserve physical effects.
"""
import copy
import hashlib
import json
from collections import deque, Counter


def key(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def fixtures():
    for mode in ('disjoint', 'shared_destination', 'shared_actor', 'shared_material'):
        for faults in (False, True):
            yield {'id': mode + ('-fault' if faults else '-healthy'),
                   'mode': mode, 'faults': faults, 'capacity': 1, 'max_faults': int(faults)}
    yield {'id': 'shared-capacity-two', 'mode': 'shared_destination', 'faults': True,
           'capacity': 2, 'max_faults': 1}


class HandoffKernel:
    def __init__(self, config, mutation=None):
        self.config = config
        self.mutation = mutation
        self.requests = []
        for i in range(2):
            m = 'M0' if config['mode'] == 'shared_material' else 'M' + str(i)
            actor = 'R0' if config['mode'] == 'shared_actor' else 'R' + str(i)
            target = 'D0' if config['mode'] == 'shared_destination' else 'D' + str(i)
            self.requests.append({'id': str(i), 'material': m, 'source': 'S' + m,
                                  'target': target, 'actor': actor})
        mats = {r['material']: {'physical': r['source'], 'support': r['source'],
                               'ledger': r['source'], 'held': None} for r in self.requests}
        self.initial = {'phase': [0, 0], 'stage': [0, 0], 'materials': mats,
                        'grants': {}, 'reservations': {}, 'commits': [], 'abort': False,
                        'fault': None, 'epoch': [0, 0], 'fault_count': 0,
                        'capture_error': False, 'erased_partial_effect': False}

    def claims(self, r):
        return sorted({r['actor'] + ':motion', r['material'] + ':claim',
                       r['source'] + ':zone', r['target'] + ':zone'})

    def clear(self, s, i):
        who = str(i)
        s['grants'] = {r: owner for r, owner in s['grants'].items() if owner != who}
        s['reservations'].pop(who, None)

    def safe(self, s, i):
        r = self.requests[i]; m = s['materials'][r['material']]
        return m['held'] is None and (m['physical'] == m['ledger'] == r['source'] or
               str(i) in s['commits'] and m['physical'] == m['ledger'] == r['target'])

    def successors(self, s):
        # phase 0 waiting, 1..7 active, 8 stopping, 9 failed/cancelled,
        # 10 isolated, 11 succeeded. stage preserves the last physical effect.
        if self.config['faults'] and not s['abort'] and any(1 <= p <= 7 for p in s['phase']):
            n = copy.deepcopy(s); n['abort'] = True
            n['phase'] = [8 if 1 <= p <= 7 else 9 if p == 0 else p for p in n['phase']]
            yield n, {'kind': 'controller_cancel'}
        if self.config['faults'] and s['fault_count'] < self.config['max_faults']:
            for i, phase in enumerate(s['phase']):
                if phase not in range(1, 9): continue
                for fault in ('permission_loss', 'restart', 'stop_ack_loss'):
                    if fault == 'stop_ack_loss' and phase != 8: continue
                    n = copy.deepcopy(s)
                    n.update(abort=True, fault={'kind': fault, 'request': i}, fault_count=s['fault_count'] + 1)
                    if fault == 'restart': n['epoch'][i] += 1
                    for j, p in enumerate(n['phase']):
                        if 1 <= p <= 7: n['phase'][j] = 8
                        elif p == 0: n['phase'][j] = 9
                    if self.mutation == 'rollback' and 1 <= s['stage'][i] <= 5:
                        r = self.requests[i]
                        n['materials'][r['material']].update(physical=r['source'], support=r['source'],
                                                           ledger=r['source'], held=None)
                        n['erased_partial_effect'] = True
                    yield n, {'kind': fault, 'request': i}
        for i, phase in enumerate(s['phase']):
            r = self.requests[i]; who = str(i); m = s['materials'][r['material']]
            if phase in (9, 10, 11): continue
            n = copy.deepcopy(s); nm = n['materials'][r['material']]
            if phase == 0:
                if s['abort']:
                    n['phase'][i] = 9
                else:
                    wanted = self.claims(r)
                    occupied = sum(v['ledger'] == r['target'] for v in s['materials'].values())
                    reserved = sum(v == r['target'] for v in s['reservations'].values())
                    if m['physical'] != r['source'] or m['held'] is not None: continue
                    if any(resource in s['grants'] for resource in wanted): continue
                    if occupied + reserved >= self.config['capacity']: continue
                    n['grants'].update({resource: who for resource in wanted})
                    n['reservations'][who] = r['target']; n['phase'][i] = 1
            elif phase == 8:
                fault = s['fault']
                missing = fault and fault['request'] == i and fault['kind'] in ('restart', 'stop_ack_loss')
                if not missing and self.safe(s, i):
                    self.clear(n, i); n['phase'][i] = 9
                else: n['phase'][i] = 10
                # A peer can lose its stop evidence even if the original fault
                # was elsewhere; this is modeled as a separate timeout choice.
                if not missing:
                    isolated = copy.deepcopy(s); isolated['phase'][i] = 10
                    yield isolated, {'kind': 'stop_unknown', 'request': i}
            else:
                n['stage'][i] = phase
                if phase == 1:
                    n['capture_error'] |= (m['physical'] != r['source'] or
                        any(s['grants'].get(resource) != who for resource in self.claims(r)))
                    nm['held'] = r['actor']
                    if self.mutation == 'release_held': self.clear(n, i)
                elif phase == 2:
                    nm.update(physical=r['actor'] + '.tool', support=r['actor'] + '.tool', ledger=r['actor'] + '.tool')
                elif phase == 3: nm.update(physical=r['target'], support=r['target'])
                elif phase == 4: nm['held'] = None
                elif phase == 5:
                    nm['ledger'] = r['target']; n['reservations'].pop(who, None)
                    n['commits'].append(who)
                    if self.mutation == 'duplicate_commit': n['commits'].append(who)
                elif phase == 6: pass  # Held done state; publication has no physical effect.
                elif phase == 7: self.clear(n, i)
                n['phase'][i] = 11 if phase == 7 else phase + 1
            yield n, {'kind': 'request_step', 'request': i, 'from': phase, 'to': n['phase'][i]}

    def violations(self, s):
        bad = set()
        if s['capture_error']: bad.add('capture_without_valid_source_or_grant')
        if s['erased_partial_effect']: bad.add('failure_rolled_back_physical_effect')
        if len(s['commits']) != len(set(s['commits'])): bad.add('duplicate_commit')
        for i, phase in enumerate(s['phase']):
            if phase in range(1, 9) or phase == 10:
                if any(s['grants'].get(r) != str(i) for r in self.claims(self.requests[i])):
                    bad.add('active_or_isolated_request_lost_grant')
        for target in {r['target'] for r in self.requests}:
            count = sum(v['ledger'] == target for v in s['materials'].values())
            count += sum(v == target for v in s['reservations'].values())
            if count > self.config['capacity']: bad.add('capacity_overcommit')
        for mid, m in s['materials'].items():
            if m['held'] is not None and not any(
                r['material'] == mid and r['actor'] == m['held'] and s['phase'][i] not in (0, 9, 11)
                for i, r in enumerate(self.requests)):
                bad.add('held_material_without_live_owner')
        return sorted(bad)


def enumerate_kernel(config, mutation=None, state_limit=100000):
    model = HandoffKernel(config, mutation)
    states = [model.initial]; seen = {key(model.initial): 0}; queue = deque([0])
    parents = [None]; edges = []; bad = {}; terminal = Counter(); closed = True
    while queue:
        index = queue.popleft(); state = states[index]
        for name in model.violations(state): bad.setdefault(name, index)
        next_states = list(model.successors(state))
        if not next_states:
            terminal['all_succeeded' if all(p == 11 for p in state['phase']) else
                     'isolated' if 10 in state['phase'] else
                     'failed' if state['abort'] else 'blocked'] += 1
        for nxt, event in next_states:
            k = key(nxt)
            if k not in seen:
                if len(states) >= state_limit: closed = False; break
                seen[k] = len(states); states.append(nxt); parents.append((index, event)); queue.append(seen[k])
            edges.append((index, seen[k], event))
        if not closed: break
    witnesses = {}
    for name, index in bad.items():
        path = []
        while parents[index] is not None:
            prev, event = parents[index]; path.append({'event': event, 'state': states[index]}); index = prev
        witnesses[name] = list(reversed(path))
    return {'schema': 'independent-handoff-kernel/0.3', 'config': config, 'mutation': mutation,
            'closed': closed, 'states': len(states), 'edges': len(edges),
            'terminal_counts': dict(terminal), 'violations': sorted(bad), 'counterexamples': witnesses,
            'graph_sha256': hashlib.sha256(key({'states': states, 'edges': edges}).encode()).hexdigest(),
            'scope': 'Untimed two-request kernel; no whole-line timing/refinement claim',
            'assumptions': ['atomic grant and reserve', 'one ledger location per material',
                            'linear exactly-once phases', 'global failure propagation',
                            'controller cancellation allowed in fault fixtures',
                            'unknown stop can retain isolation indefinitely']}


def suite():
    results = [enumerate_kernel(c) for c in fixtures()]
    cfg = next(c for c in fixtures() if c['id'] == 'disjoint-fault')
    mutations = [enumerate_kernel(cfg, name) for name in ('release_held', 'rollback', 'duplicate_commit')]
    return {'fixtures': results, 'mutations': mutations,
            'complete': all(x['closed'] for x in results + mutations),
            'invariants_hold': all(not x['violations'] for x in results),
            'all_mutations_detected': all(x['violations'] for x in mutations),
            'whole_line_truth_complete': False}


if __name__ == '__main__':
    print(json.dumps(suite(), ensure_ascii=False, indent=2))
