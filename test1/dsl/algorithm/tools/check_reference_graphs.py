"""Check graph closure independently of the P2 enumeration loop.

The reference transition relation remains the trusted semantic kernel. This is
not an independent proof that the kernel refines every device implementation.
"""
from collections import Counter,defaultdict,deque
from pathlib import Path
from types import SimpleNamespace
import argparse
import json
import sys

BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from reference.transition import ReferenceModel
from reference.common import canonical


def check_graph(payload):
    model=ReferenceModel(SimpleNamespace(**payload['definition']));states=payload['states'];edges=payload['edges']
    if payload['model_digest']!=model.model_digest:raise ValueError('Reference model digest differs')
    if not states or states[0]!=model.initial:raise ValueError('Initial state differs')
    keys=[canonical(s) for s in states]
    if len(set(keys))!=len(keys):raise ValueError('Duplicate canonical state')
    index={key:i for i,key in enumerate(keys)};outgoing=defaultdict(list)
    for edge in edges:
        if not (0<=edge['from']<len(states) and 0<=edge['to']<len(states)):raise ValueError('Invalid edge endpoint')
        outgoing[edge['from']].append(edge)
    for i,state in enumerate(states):
        actual=Counter(canonical([e['to'],e['events']]) for e in outgoing[i]);expected=Counter()
        for nxt,events in model.successors(state):
            key=canonical(nxt)
            if key not in index:raise ValueError('Missing legal successor of state '+str(i))
            expected[canonical([index[key],events])]+=1
        if actual!=expected:raise ValueError('Missing, extra or altered transitions at state '+str(i))
    reachable={0};queue=deque([0])
    while queue:
        for edge in outgoing[queue.popleft()]:
            if edge['to'] not in reachable:reachable.add(edge['to']);queue.append(edge['to'])
    if len(reachable)!=len(states):raise ValueError('Unreachable states included')
    return {'checked':True,'states':len(states),'edges':len(edges),
            'scope':'Exact closure against independent reference transition kernel; not source-to-kernel refinement proof'}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('graph',type=Path);a=p.parse_args()
    print(json.dumps(check_graph(json.loads(a.graph.read_text(encoding='utf8'))),ensure_ascii=False))
