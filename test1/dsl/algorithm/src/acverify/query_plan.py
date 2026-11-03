"""Share a search budget; an early witness never proves an unrelated property."""
import time
import copy
from .backends import explore
from .diagnostics import trace


def search(model, bound, states, seconds, memory_mb, mode, portfolio=False, keep_edges=False):
    started = time.perf_counter()
    early = None
    if portfolio:
        early = explore(model, bound, states, seconds * .15, memory_mb,
                        'compact', 'witness', optimized=True, keep_edges=False,
                        target_properties=['V09', 'V10a'])
        # Keep only concrete traces across phases; discard the first graph so
        # two complete state stores do not occupy the memory budget together.
        witnesses = {pid: trace(model, early, index) for pid, index in early['bad'].items()}
        if early['goal'] is not None: witnesses['goal'] = trace(model, early, early['goal'])
        early_report = early['report']
        del early
    else:
        witnesses = {}; early_report = None
    remaining = max(0, seconds - (time.perf_counter() - started))
    graph = explore(model, bound, states, remaining, memory_mb, mode, 'complete',
                    optimized=True, keep_edges=keep_edges)
    complete_report = copy.deepcopy(graph['report'])
    result = graph['report']
    # Existential evidence survives timeouts in the exhaustive phase. Its
    # trajectory is checked by pipeline.replay before publication.
    for pid in witnesses:
        property_id = 'V10a' if pid == 'goal' else pid
        if result['properties'][property_id]['applicable']:
            result['properties'][property_id]['verdict'] = ('GOAL_REACHABLE_WITHIN_BOUND'
                                                           if pid == 'goal' else 'VIOLATED_IN_MODEL')
            result['properties'][property_id]['evidence_origin'] = 'witness_phase'
            result['properties'][property_id]['vacuous'] = False
            result['properties'][property_id]['trigger_reachable'] = True
    result['search_phases'] = ([early_report] if early_report else []) + [complete_report]
    result['search_budget_seconds'] = seconds
    result['elapsed_seconds'] = time.perf_counter() - started
    result['aggregate_states_visited'] = sum(r['states'] for r in result['search_phases'])
    result['peak_sampled_rss_bytes'] = max(r['peak_sampled_rss_bytes'] for r in result['search_phases'])
    return graph, witnesses
