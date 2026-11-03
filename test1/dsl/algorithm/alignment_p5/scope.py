"""Keep evaluation IDs, legacy windows and non-vacuity obligations separate."""
from collections import Counter
from .io import digest, read, sha


def freeze_scope(oracle):
    queries=read(oracle/'query-registry.json')['queries']
    by_id={q['query_id']:q for q in queries}
    if len(by_id)!=len(queries):raise ValueError('Duplicate reference query')
    view=read(oracle/'benchmark-view.json')
    selected=view['query_ids']
    if len(set(selected))!=len(selected) or set(selected)-set(by_id):raise ValueError('Invalid view membership')
    replacements={r['extended_query_id']:r['original_query_id'] for r in view['replacements']}
    if len(replacements)!=len(view['replacements']):raise ValueError('Duplicate window replacement')
    for new,old in replacements.items():
        a,b=by_id[old],by_id[new]
        if any(a[k]!=b[k] for k in ('case_id','profile','property_id','bound_ticks','model_digest','input_digest','response_window_ticks','property_version','property_spec_digest')):
            raise ValueError('Replacement changes more than the response query scope')
        if a['property_id']!='V10b' or a['covered_trigger_cutoff']>=1 or b['covered_trigger_cutoff']!=b['bound_ticks']:
            raise ValueError('Unexpected window substitution')
        if b['checked_until']!=b['bound_ticks']+b['response_window_ticks']:
            raise ValueError('Incomplete extension tail')
    originals={q['query_id'] for q in queries if q['tail_policy']!='cover_triggers_through_K_extend_checks'}
    inadequate={q['query_id'] for q in queries if q['tail_policy']=='legacy_full_windows_only_report_uncovered' and q['covered_trigger_cutoff']<1}
    if set(replacements.values())!=inadequate or set(selected)!=(originals-inadequate)|set(replacements):
        raise ValueError('Common view omitted, duplicated or substituted a non-window query')
    rows=[]
    for qid in selected:
        q=by_id[qid]
        row={k:q[k] for k in ('query_id','source_query_id','case_id','profile','property_id','bound_ticks',
             'model_digest','input_digest','property_version','tail_policy','response_window_ticks','covered_trigger_cutoff','checked_until','applicability')}
        row.update(original_query_id=replacements.get(qid,qid),reference_semantics=q['timing_scope'],
            query_scope_changed=qid in replacements,
            evaluation_role='protocol_conformance' if q['property_id'] in ('V02','V03','V07') else 'process_property',
            comparison_admission='PENDING_SEMANTIC_ALIGNMENT')
        rows.append(row)
    remaining=read(oracle/'remaining-obligations.json')
    return dict(id='method1-p5-common-scope/0.1',reference_manifest_sha256=sha(oracle/'manifest.json'),
        query_count=len(rows),applicability=dict(Counter(r['applicability'] for r in rows)),
        original_queries_preserved=True,replaced_window_count=len(replacements),
        original_window_obligations=remaining['queries'],
        nonvacuity_obligations=[{k:v for k,v in r.items() if k!='verdict'} for r in remaining['nonvacuity_queries']],
        construction_property_policy='Separate protocol conformance from malformed-process detection; no arbitrary PLC accuracy claim.',
        historical_baselines='v3/v4 scores remain historical; baseline/storage/portfolio need the same aligned transition semantics.',
        plc_baseline='NOT_CONFIGURED: no admitted PLC translation, property mapping or external checker in this phase.',
        records=rows,records_digest=digest(rows),verdicts_exposed_to_diagnostics=False,
        metrics_policy=dict(reference_coverage='Report vacuity and unknown triggers separately.',
            solved_coverage='Determinate aligned answers / applicable certified queries.',
            answered_accuracy='Correct / determinate aligned answers; also report correct / all reference queries.',
            efficiency='Paired scope and budgets; report timeout rate separately from completed runtime.',
            statistical_unit='scene/parent-case clusters; repeated K/property/environment rows are not independent samples.'))
