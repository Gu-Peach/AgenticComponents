from certification.binding import validate_query,resolve_many as old_resolve
from certification.evidence_check import bind
from reference.common import digest
from . import invariants,event_rules,goal_projection,response_bound
from . import quiet_wait
from certification.evidence_check import verdict_from_checked

HANDLERS={'p4_invariant/0.1':invariants,'p4_event_frame/0.1':event_rules,
          'p4_goal_projection/0.1':goal_projection,'p4_response_bound/0.1':response_bound}


def resolve_many(model,queries,payload):
    kind=payload['kind']
    if kind=='p4_macro_trace/0.1':
        for q in queries:validate_query(q,model);bind(model,q,payload)
        checked=quiet_wait.check_trace(model,payload)
        results=[{'verdict':None,'reason':'NOT_APPLICABLE'} if q['applicability']=='NOT_APPLICABLE' else verdict_from_checked(model,q,checked) for q in queries]
        receipt={k:v for k,v in checked.items() if k not in ('observations','initial')}
        receipt.update(checker_version='p4-evidence/0.1',payload_digest=digest(payload))
        return results,receipt
    if kind not in HANDLERS:return old_resolve(model,queries,payload)
    for q in queries:validate_query(q,model);bind(model,q,payload)
    handler=HANDLERS[kind];checked=handler.check(model,payload);results=[]
    for q in queries:
        results.append({'verdict':None,'reason':'NOT_APPLICABLE'} if q['applicability']=='NOT_APPLICABLE' else handler.verdict(q,checked))
    return results,{'checker_version':'p4-evidence/0.1','model_digest':model.model_digest,
                    'payload_digest':digest(payload),'checked_derivation':checked}
