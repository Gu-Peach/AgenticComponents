"""Observation-only hooks, enabled solely in separate profiling workers."""
from collections import Counter
from contextlib import contextmanager
import cProfile
import pstats
import sys
import time


@contextmanager
def observe(destination):
    from acverify_v3 import model, search, pipeline
    stats = dict(explorations=[], branches={}, first_positive={}, maxima={})
    counts = Counter()
    phases = []
    active = [False]
    started = time.perf_counter()
    original_init = model.TransitionModel.__init__
    original_search = search.explore
    original_pipeline = pipeline.explore
    original_observed = search.observed
    previous_trace = sys.gettrace()

    def maxima(state):
        values = dict(inbox=len(state['inbox']), tasks=len(state['tasks']),
                      active_requests=sum(t['kind']=='invoke' and t['phase'] not in model.TERMINAL for t in state['tasks'].values()),
                      levels=len(state['levels']), lost_stop=len(state['lost_stop']))
        for k,v in values.items():stats['maxima'][k]=max(stats['maxima'].get(k,0),v)

    def init(self,*args,**kwargs):
        original_init(self,*args,**kwargs)
        for name in ('successors','fault_variants','plant_variants','sample_levels'):
            original = getattr(self,name)
            def wrapper(*a,_original=original,_name=name,**kw):
                if not active[0]:
                    yield from _original(*a,**kw)
                    return
                counts[_name+'_calls']+=1
                gen=_original(*a,**kw)
                try:
                    for state,events in gen:
                        counts[_name+'_yields']+=1
                        if _name=='successors':maxima(state)
                        if _name=='fault_variants':
                            counts['fault_choice_'+str(next((e.get('fault') for e in reversed(events) if e.get('kind')=='fault'),'none'))]+=1
                        yield state,events
                finally:gen.close()
            setattr(self,name,wrapper)

    def observed(m,state,q):
        value=original_observed(m,state,q)
        if active[0] and value['verdict'] and q['query_id'] not in stats['first_positive']:
            stats['first_positive'][q['query_id']]=dict(seconds=time.perf_counter()-started,tick=state['tick'],verdict=value['verdict'])
        return value

    def trace(frame,event,arg):
        if frame.f_code is original_search.__code__:
            if event=='line':
                local=frame.f_locals
                if 'frontier' in local:
                    stats['maxima']['frontier']=max(stats['maxima'].get('frontier',0),len(local['frontier']))
            elif event=='return':
                local=frame.f_locals
                reason=local.get('limit')
                if reason=='STATE_OR_STORAGE_LIMIT':
                    reason='STATE_LIMIT' if len(local['states'])>=local['state_limit'] else 'SERIALIZED_STORAGE_LIMIT'
                phases.append(dict(limit_detail=reason,expanded_calls=counts['successors_calls'],
                                   max_frontier=stats['maxima'].get('frontier',0)))
            return trace
        return None

    def explore(*a,**kw):
        active[0]=True
        try:
            graph=original_search(*a,**kw)
            s=graph['statistics']
            stats['explorations'].append(dict(**s,duplicate_ratio=1-(s['states']-1)/s['edges'] if s['edges'] else None))
            return graph
        finally:active[0]=False

    profiler=cProfile.Profile()
    model.TransitionModel.__init__=init
    search.observed=observed
    search.explore=explore
    pipeline.explore=explore
    sys.settrace(trace)
    profiler.enable()
    try:yield stats
    finally:
        profiler.disable()
        sys.settrace(previous_trace)
        model.TransitionModel.__init__=original_init
        search.observed=original_observed
        search.explore=original_search
        pipeline.explore=original_pipeline
        profiler.dump_stats(str(destination))
        measured=pstats.Stats(profiler)
        functions=[]
        for (file,line,function),(primitive,calls,self_time,cumulative,_) in measured.stats.items():
            functions.append(dict(file=file,line=line,function=function,calls=calls,
                                  self_seconds=self_time,cumulative_seconds=cumulative))
        stats.update(branches=dict(counts),search_limits=phases,
                     functions=sorted(functions,key=lambda r:r['self_seconds'],reverse=True),
                     profiling_only=True,timing_not_comparable_to_uninstrumented=True,
                     branch_count_policy='Stage calls/yields include upstream multiplicity; never multiply them as independent branch factors.',
                     first_positive_clock='Worker profiling elapsed, not pure solver time; universal verdicts only at exhaustion.')
