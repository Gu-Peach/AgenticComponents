"""Candidate evidence construction. Admission is performed by separate checkers."""
import time
from reference.common import clone
from reference.enumerate import enumerate_model


def walk(model,bound=3000,policy='minimum',seconds=30):
    current=clone(model.initial);steps=[];start=time.monotonic();limit=None
    while current['outcome']=='running' and current['tick']<bound:
        if time.monotonic()-start>=seconds:limit='TIMEOUT';break
        generator=model.successors(current);chosen=None
        try:
            for nxt,events in generator:
                if policy=='minimum':chosen=(nxt,events);break
                if policy!='fresh_accept_stale_result':raise ValueError('Unknown witness policy')
                if nxt['faults_used']!=current['faults_used']:continue
                packets=[p for p in nxt['mail'] if p['sample_tick']==nxt['tick']]
                match=True
                for packet in packets:
                    delay=model.d.profile['feedback'][1] if packet['kind'] in ('result','stop') else model.d.profile['feedback'][0]
                    if packet['due']!=packet['sample_tick']+1+delay:match=False;break
                if match:chosen=(nxt,events);break
        finally:generator.close()
        if chosen is None:raise ValueError('No legal successor matches witness selection')
        current,events=chosen;steps.append({'state':current,'events':events})
        if policy=='fresh_accept_stale_result' and 'V10b' in current['violations']:break
    return {'kind':'trace_certificate/0.1','model_digest':model.model_digest,'initial':model.initial,'steps':steps,
            'construction':{'policy':policy,'bound':bound,'limit':limit,'elapsed_seconds':time.monotonic()-start}}


def graph(model,bound=256,seconds=20):
    g=enumerate_model(model,bound=bound,max_states=30000,seconds=seconds,memory_mb=512,retain_edges=True)
    if not g['summary']['frontier_exhausted']:
        return None,g['summary']
    return {'kind':'graph_certificate/0.1','model_digest':model.model_digest,'coverage_bound':bound,
            'states':g['states'],'edges':g['edges']},g['summary']
