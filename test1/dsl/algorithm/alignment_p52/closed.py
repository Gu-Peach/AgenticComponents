"""Check both successor directions at every reachable pair in a finite fixture."""
from collections import deque
import time
from .relation import canonical,key,diff


def compare(sut,ref,bound=128,seconds=30,max_pairs=20000):
    started=time.monotonic();queue=deque([(sut.initial,ref.initial)]);seen=set();edges=0;max_tick=0
    while queue:
        if time.monotonic()-started>seconds:return dict(status='LIMIT',limit='TIMEOUT',pairs=len(seen),edges=edges)
        a,b=queue.popleft();identity=(key(a),key(b))
        if identity in seen:continue
        if len(seen)>=max_pairs:return dict(status='LIMIT',limit='PAIR_LIMIT',pairs=len(seen),edges=edges)
        seen.add(identity);max_tick=max(max_tick,a['tick'])
        delta=diff(canonical(a),canonical(b,True))
        if delta:return dict(status='DIFFERENT',tick=a['tick'],differences=delta,pairs=len(seen))
        if a['outcome']!='running':continue
        if a['tick']>=bound:return dict(status='LIMIT',limit='HORIZON',pairs=len(seen),edges=edges)
        left={};right={}
        for state,events in sut.successors(a):left.setdefault(key(canonical(state)),[]).append((state,events))
        for state,events in ref.successors(b):right.setdefault(key(canonical(state,True)),[]).append((state,events))
        if left.keys()!=right.keys():
            only_left=set(left)-set(right);only_right=set(right)-set(left)
            sample_left=left[next(iter(only_left or left))][0][0]
            sample_right=right[next(iter(only_right or right))][0][0]
            return dict(status='DIFFERENT_SUCCESSORS',tick=a['tick'],sut_only=len(only_left),reference_only=len(only_right),
                differences=diff(canonical(sample_left),canonical(sample_right,True))[:20],pairs=len(seen),
                before_sut=a,before_reference=b)
        if not left:return dict(status='DEADLOCK',tick=a['tick'],pairs=len(seen))
        for label,ls in left.items():
            rs=right[label]
            # The relation records every future-read controller/plant/channel
            # field. Extra SUT fields are passive query history, so retain every
            # distinct SUT history even when a reference state is shared.
            for s,_ in ls:
                for r,_ in rs:queue.append((s,r));edges+=1
            if len(queue)>max_pairs*8:return dict(status='LIMIT',limit='FRONTIER_LIMIT',pairs=len(seen),edges=edges)
    return dict(status='CLOSED_MATCH',pairs=len(seen),edges=edges,max_tick=max_tick,seconds=time.monotonic()-started,
                scope='Complete finite diagnostic fixture only; not all corpus models or arbitrary Python equivalence.')
