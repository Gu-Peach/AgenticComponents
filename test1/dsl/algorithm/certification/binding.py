"""Versioned reference-query identities; source queries are never overwritten."""
from reference.common import digest
from pathlib import Path
import json
from reference import properties

IDS={'V01','V02','V03','V04','V05','V06','V07','V08','V09','V10a','V10b'}
FIELDS=('source_query_id','case_id','profile','model_digest','input_digest','timing_scope','property_version',
        'property_spec_digest','property_id','bound_ticks','applicability','tail_policy','response_window_ticks',
        'covered_trigger_cutoff','checked_until')


def identity(q):return digest({k:q.get(k) for k in FIELDS})


def make_query(source,model,property_spec_digest):
    q={k:source[k] for k in ('case_id','profile','property_id','bound_ticks','applicability')}
    q.update(source_query_id=source['query_id'],model_digest=model.model_digest,input_digest=model.d.input_digest,
        timing_scope=model.d.profile['timing_scope'],property_version='whole-line-properties/0.1',
        property_spec_digest=property_spec_digest,tail_policy=source.get('tail_policy'),
        response_window_ticks=source.get('response_window_ticks'),covered_trigger_cutoff=source.get('covered_trigger_cutoff'),
        checked_until=source.get('checked_until',source['bound_ticks']),
        source_scope=source['profile_scope'],source_property_version=source['property_version'],
        semantic_alignment='reference_scope_only; tested-runtime alignment pending')
    q['query_id']=identity(q);validate_query(q,model);return q


def validate_query(q,model):
    if q['query_id']!=identity(q):raise ValueError('Query identity does not match its scope')
    if q['model_digest']!=model.model_digest or q['input_digest']!=model.d.input_digest:raise ValueError('Wrong bound reference model')
    if q['case_id']!=model.d.case_id or q['profile']!=model.d.profile['name']:raise ValueError('Wrong case/profile')
    if q['timing_scope']!=model.d.profile['timing_scope']:raise ValueError('Wrong timing interpretation')
    if q['property_id'] not in IDS:raise ValueError('Unknown property')
    spec=json.loads((Path(properties.__file__).parent/'specs/property-spec.json').read_text(encoding='utf8'))
    if q['property_version']!=spec['id'] or q['property_spec_digest']!=digest(spec):raise ValueError('Unknown property interpretation')
    k=q['bound_ticks']
    if type(k) is not int or k<0:raise ValueError('Invalid query horizon')
    if q['property_id']=='V10b':
        d=q['response_window_ticks']
        if type(d) is not int or d<=0 or model.d.profile['response_window']!=d:raise ValueError('Response window differs from reference model')
        if q['tail_policy']=='legacy_full_windows_only_report_uncovered':
            if q['covered_trigger_cutoff']!=max(-1,k-d) or q['checked_until']!=k:raise ValueError('Invalid legacy response scope')
        elif q['tail_policy']=='cover_triggers_through_K_extend_checks':
            if q['covered_trigger_cutoff']!=k or q['checked_until']!=k+d:raise ValueError('Invalid extended response scope')
        else:raise ValueError('Undefined response horizon policy')


def resolve_many(model,queries,payload):
    from .evidence_check import bind,check_trace,check_graph,verdict_from_checked
    from . import logic,success_effects
    kind=payload['kind']
    for query in queries:validate_query(query,model);bind(model,query,payload)
    if kind=='trace_certificate/0.1':checked=check_trace(model,payload)
    elif kind=='graph_certificate/0.1':checked=check_graph(model,payload)
    elif kind=='logical_certificate/0.1':checked=logic.check(model,payload)
    elif kind=='success_effect_certificate/0.1':checked=success_effects.check(model,payload)
    else:raise ValueError('Unknown evidence type')
    results=[]
    for query in queries:
        if query['applicability']=='NOT_APPLICABLE':result={'verdict':None,'reason':'NOT_APPLICABLE'}
        elif kind in ('trace_certificate/0.1','graph_certificate/0.1'):result=verdict_from_checked(model,query,checked)
        elif kind=='logical_certificate/0.1':result=logic.verdict(query,checked)
        else:result=success_effects.verdict(query,checked)
        results.append(result)
    receipt={k:v for k,v in checked.items() if k not in ('states','edges','initial','observations','derivation')}
    receipt.update(checker_version='p3-evidence/0.1',payload_digest=digest(payload))
    return results,receipt


def resolve(model,query,payload):
    results,receipt=resolve_many(model,[query],payload)
    return results[0],receipt
