"""Independent finite enumeration of a latched observation channel.

No acverify imports. Choose absolute delivery times on enqueue, unlike the
production verifier's per-tick defer/deliver branching. Exhaustion is recorded.
"""
from collections import deque


def enumerate_channel(config):
    # State: observed_at (0 if unseen), FIFO tuples (sample_tick, delivery_tick).
    states={(0,())};visited=1
    for tick in range(1,config['horizon']+1):
        following=set()
        for observed,queue in states:
            pending=list(queue)
            while pending and pending[0][1]<=tick:
                born,due=pending.pop(0)
                if not observed and config['identity_valid'] and 0<=tick-born<=config['max_age']:
                    observed=tick
            if observed:
                following.add((observed,()));continue
            if tick<config['ready_tick'] or config.get('suppress',False):
                following.add((0,tuple(pending)));continue
            earliest=tick+1+config['delay'][0];latest=tick+1+config['delay'][1]
            if pending:earliest=max(earliest,pending[-1][1])
            for due in range(earliest,latest+1):
                following.add((0,tuple(pending+[(tick,due)])))
        states=following;visited+=len(states)
    outcomes=sorted({s[0] for s in states})
    return {'observed_ticks':outcomes,'can_observe':any(outcomes),
            'must_observe_by_horizon':bool(outcomes) and 0 not in outcomes,
            'exhausted':True,'enumerated_states':visited,
            'scope':'finite feedback-channel fixture, not complete production-line truth'}


def fixtures():
    rows=[]
    for kind in ('accepted','result','stop'):
        for delay in ([0,0],[0,1],[1,1],[0,3],[3,3]):
            for age in (1,2):
                for valid in (False,True):
                    rows.append({'id':f'{kind}-{delay[0]}-{delay[1]}-age{age}-id{int(valid)}',
                        'kind':kind,'delay':delay,'max_age':age,'identity_valid':valid,
                        'ready_tick':1,'horizon':6,'suppress':False})
    rows.append({'id':'missing-stop-confirmation','kind':'stop','delay':[0,1],'max_age':2,
                 'identity_valid':True,'ready_tick':1,'horizon':6,'suppress':True})
    return rows
