"""Query-specific horizons; the solver never reads reference verdicts."""
from .core import require
from .properties import IDS
from .monitor import root_goal


def validate(model,queries):
    seen=set()
    for q in queries:
        require(q['query_id'] not in seen,'INVALID_QUERY','Duplicate query ID');seen.add(q['query_id'])
        require(q['property_id'] in IDS,'INVALID_QUERY','Unknown property')
        require(q['case_id']==model.data['descriptor']['case_id'],'INVALID_QUERY','Case differs')
        require(q['profile'].split('@')[0]==model.profile['id'].split('@')[0],'INVALID_QUERY','Profile differs')
        k=q['bound_ticks'];end=q['checked_until']
        require(type(k) is int and k>=0 and type(end) is int and end>=k,'INVALID_QUERY','Invalid query horizon')
        require(q['applicability'] in ('APPLICABLE','NOT_APPLICABLE'),'INVALID_QUERY','Unknown applicability')
        if q['property_id']=='V10b':
            window=q['response_window_ticks'];cutoff=q['covered_trigger_cutoff']
            require(type(cutoff) is int,'INVALID_QUERY','Trigger cutoff must be an integer')
            require(type(window) is int and window>0 and window==model.data['queries'].get('response_window_ticks'),
                    'INVALID_QUERY','Response window differs from model')
            if q['tail_policy']=='cover_triggers_through_K_extend_checks':
                require(cutoff==k and end==k+window,'INVALID_QUERY','Incomplete or altered response tail')
            elif q['tail_policy']=='legacy_full_windows_only_report_uncovered':
                require(cutoff==max(-1,k-window) and end==k,'INVALID_QUERY','Legacy window differs')
            else:require(False,'INVALID_QUERY','Unknown response tail policy')
        else:require(end==k,'INVALID_QUERY','Safety/reachability horizon changed')


def observed(model,state,q):
    pid=q['property_id'];k=q['bound_ticks']
    if q['applicability']=='NOT_APPLICABLE':return dict(verdict=None,trigger=False)
    if pid=='V10a':
        reached=state['tick']<=k and state['outcome']=='succeeded' and root_goal(model,state)
        return dict(verdict='REACHABLE' if reached else None,trigger=reached)
    if pid=='V10b':
        cutoff=q['covered_trigger_cutoff'];end=q['checked_until']
        if cutoff<1:return dict(verdict=None,trigger=False,reason='NO_FULL_RESPONSE_WINDOW')
        bad=[(key,v) for key,v in state['response_violations'].items() if v['accepted_at']<=cutoff and v['deadline']<=end and v['tick']<=end]
        trigger=any(t<=cutoff for t in state['acceptances'].values())
        return dict(verdict='VIOLATED' if bad else None,trigger=trigger,
                    witness_tick=min((v['deadline'] for _,v in bad),default=None))
    when=state['first_violation'].get(pid)
    return dict(verdict='VIOLATED' if when is not None and when<=k else None,
                trigger=state['trigger_ticks'].get(pid,k+1)<=k,witness_tick=when)


def summarize(q,positive,trigger,complete,closed,uncovered):
    if q['applicability']=='NOT_APPLICABLE':return dict(verdict='NOT_APPLICABLE',vacuous=None,trigger_reachability='UNKNOWN')
    if positive:return dict(verdict=positive['verdict'],vacuous=False,trigger_reachability='REACHABLE',witness_tick=positive.get('witness_tick'))
    if q['property_id']=='V10b' and q['covered_trigger_cutoff']<1:
        return dict(verdict='UNKNOWN',vacuous=None,trigger_reachability='UNKNOWN',reason='NO_FULL_RESPONSE_WINDOW')
    enough=complete and (closed or q['property_id']!='V10b') and not uncovered
    if enough:
        pid=q['property_id']
        return dict(verdict='UNREACHABLE' if pid=='V10a' else 'HOLDS',
            vacuous=False if pid=='V10a' else not trigger,trigger_reachability='REACHABLE' if trigger else 'UNREACHABLE')
    return dict(verdict='UNKNOWN',vacuous=None,trigger_reachability='REACHABLE' if trigger else 'UNKNOWN',
                reason='UNCOVERED_MONITOR' if uncovered else 'INCOMPLETE_SEARCH_OR_RESPONSE_CLOSURE')
