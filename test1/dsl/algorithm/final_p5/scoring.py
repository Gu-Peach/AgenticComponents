"""Connect sealed predictions to the separately frozen reference ledger."""
from collections import Counter,defaultdict
from pathlib import Path
import statistics
from .common import setup,read,read_rows,write,write_rows,sha,digest,seal,verify_files
from .experiment import assert_admitted,METHODS

DEFINITE={'HOLDS','VIOLATED','REACHABLE','UNREACHABLE'}


def classify(gold,prediction,status):
    if gold['truth_status']=='NOT_APPLICABLE':return 'not_applicable'
    if gold['truth_status']!='CERTIFIED':raise ValueError('Uncertified truth in score denominator')
    if status=='WORKER_TIMEOUT':return 'worker_timeout'
    if status!='COMPLETED':return 'worker_error'
    if prediction['verdict']=='UNKNOWN':return 'unknown'
    if prediction['verdict'] not in DEFINITE:raise ValueError('Invalid prediction for an applicable property')
    return 'correct' if prediction['verdict']==gold['verdict'] else 'incorrect'


def metric(rows):
    c=Counter(r['outcome'] for r in rows);n=len(rows)-c['not_applicable'];answered=c['correct']+c['incorrect']
    return dict(total=len(rows),applicable=n,counts=dict(c),determinate=answered,
        solved_coverage=answered/n if n else None,answered_accuracy=c['correct']/answered if answered else None,
        correct_fraction_of_all=c['correct']/n if n else None,
        trigger_conflicts=sum(r['trigger_conflict'] for r in rows),
        trigger_unknown_reference=sum(r['gold_vacuous'] is None for r in rows if r['outcome']!='not_applicable'))


def groups(rows,fields):
    result=defaultdict(list)
    for row in rows:result['|'.join(str(row[k]) for k in fields)].append(row)
    return {k:metric(v) for k,v in sorted(result.items())}


def score(workspace,review,experiment,output):
    workspace=setup(workspace);review=review.resolve();experiment=experiment.resolve();output=output.resolve()
    if output.exists():raise ValueError('Use a fresh scoring directory')
    completion=read(experiment/'completion.json')
    if not completion.get('all_jobs_recorded') or not completion.get('predictions_sealed'):raise ValueError('Predictions not sealed')
    verify_files(experiment,read(experiment/'manifest.json')['files']);gate=assert_admitted(workspace,review)
    plan=read(experiment/'plan.json');plan_sha=sha(experiment/'plan.json')
    if sha(__file__)!=plan['scoring_source_sha256']:raise ValueError('Scoring implementation changed after plan freeze')
    if plan['reference_admission_manifest_sha256']!=sha(review/'manifest.json'):raise ValueError('Admission differs from frozen plan')
    # The first gold read happens only after prediction and admission checks.
    if sha(review/'gold.jsonl')!=gate['gold_sha256']:raise ValueError('Gold changed')
    gold={r['query_id']:r for r in read_rows(review/'gold.jsonl')}
    queries=read(review/'queries.json')['records'];query_map={q['query_id']:q for q in queries};by_group=defaultdict(list)
    for q in queries:by_group[q['case_id'],q['profile']].append(q)
    if gold.keys()!=query_map.keys():raise ValueError('Gold/query IDs differ')
    rows=[];jobs=[];witnesses={};conflicts=[]
    for job in plan['jobs']:
        directory=experiment/'jobs'/job['id'];verify_files(directory,read(directory/'manifest.json')['files'])
        envelope=read(directory/'result.json');status=envelope['status'];qs=by_group[job['case_id'],job['profile']]
        if envelope['job']!=job or envelope['plan_sha256']!=plan_sha:raise ValueError('Job provenance differs')
        if status=='INPUT_OR_SOURCE_DRIFT':raise ValueError('Unscorable input/source drift job')
        predictions={};report=envelope.get('report',{})
        if status=='COMPLETED':
            predictions={r['query_id']:r for r in report['results']}
            if len(predictions)!=len(report['results']) or predictions.keys()!={q['query_id'] for q in qs}:raise ValueError('Missing/duplicate worker query')
            if report['optimization']!=job['method'] or report['model_digest']!=plan['model_digests'][job['case_id']+'|'+job['profile']]:raise ValueError('Wrong implementation/model result')
            if report['implementation_hashes']!=plan['implementation_hashes']:raise ValueError('Worker source differs')
        current=[]
        for q in qs:
            g=gold[q['query_id']];pred=predictions.get(q['query_id'],dict(verdict='UNKNOWN',trigger_reachability='UNKNOWN',vacuous=None))
            if pred.get('property_id',q['property_id'])!=q['property_id']:raise ValueError('Prediction property differs')
            if g['truth_status']=='NOT_APPLICABLE' and status=='COMPLETED' and pred['verdict']!='NOT_APPLICABLE':raise ValueError('Worker applicability differs from the frozen query')
            outcome=classify(g,pred,status)
            trigger_conflict=(g['truth_status']=='CERTIFIED' and g['trigger_reachability'] in ('REACHABLE','UNREACHABLE')
                and pred.get('trigger_reachability') in ('REACHABLE','UNREACHABLE') and g['trigger_reachability']!=pred['trigger_reachability'])
            row=dict(job_id=job['id'],role=job['role'],method=job['method'],seconds=job['seconds'],repeat=job['repeat'],
                query_id=q['query_id'],case_id=job['case_id'],profile=job['profile'],scene=job['scene'],parent=job['parent'],
                property_id=q['property_id'],bound=q['bound_ticks'],comparison_role=g['comparison_role'],
                gold_verdict=g['verdict'],gold_vacuous=g['vacuous'],gold_trigger=g['trigger_reachability'],
                prediction=pred['verdict'],prediction_vacuous=pred.get('vacuous'),prediction_trigger=pred.get('trigger_reachability'),
                outcome=outcome,trigger_conflict=bool(trigger_conflict),worker_status=status)
            rows.append(row);current.append(row)
            if outcome=='incorrect' or trigger_conflict:conflicts.append(row)
            if status=='COMPLETED' and pred['verdict'] in ('HOLDS','UNREACHABLE'):
                if not report['statistics']['explored_all_prefixes']:raise ValueError('Universal result without exhausted prefix')
                if q['property_id']=='V10b' and not report['statistics']['finite_model_closed']:raise ValueError('Response assertion without closure')
            if status=='COMPLETED' and pred['verdict'] in ('VIOLATED','REACHABLE'):
                ref=envelope['witnesses'].get(q['query_id'])
                if not ref or q['query_id'] not in report['replays']:raise ValueError('Positive verdict without witness/replay')
                path=directory/ref['path']
                if not path.resolve().is_relative_to(directory.resolve()) or sha(path)!=ref['sha256']:raise ValueError('Witness missing/drift/escape')
                key=ref['payload_digest']
                item=witnesses.setdefault(key,dict(path=path.relative_to(experiment).as_posix(),sha256=ref['sha256'],payload_digest=key,
                    model_digest=report['model_digest'],case_id=job['case_id'],profile=job['profile'],queries={}))
                if item['model_digest']!=report['model_digest']:raise ValueError('Witness digest collision/model mismatch')
                item['queries'][q['query_id']]=pred['verdict']
        phases=report.get('search_phases',[]);stats=report.get('statistics',{})
        wall_path=experiment/'wall-times'/(job['id']+'.json');wall=read(wall_path)['wall_seconds'] if wall_path.exists() else None
        applicable=[r for r in current if r['outcome']!='not_applicable']
        jobs.append(dict(**job,status=status,limit=stats.get('limit'),
            all_applicable_decided=bool(applicable) and all(r['outcome'] in ('correct','incorrect') for r in applicable),
            all_applicable_correct=bool(applicable) and all(r['outcome']=='correct' and not r['trigger_conflict'] for r in applicable),
            determinate_queries=sum(r['outcome'] in ('correct','incorrect') for r in current),applicable_queries=len(applicable),
            frontend_seconds=report.get('frontend_seconds'),search_seconds=report.get('search_and_packaging_seconds'),
            replay_seconds=report.get('replay_seconds'),worker_seconds=envelope.get('worker_seconds'),wall_seconds=wall,
            states=stats.get('states'),phase_states=sum(p['states'] for p in phases),
            peak_sampled_rss_bytes=max((p['peak_sampled_rss_bytes'] for p in phases),default=None),
            finite_model_closed=stats.get('finite_model_closed'),error=envelope.get('message')))
    full=[r for r in rows if r['role']=='full'];repeated=[r for r in rows if r['role']=='repeated']
    for method in METHODS:
        actual=[r['query_id'] for r in full if r['method']==method]
        if len(actual)!=len(queries) or set(actual)!=set(query_map):raise ValueError('Full-query denominator changed')
    output.mkdir(parents=True)
    write_rows(output/'query-scores.jsonl',rows);write_rows(output/'job-scores.jsonl',jobs)
    write(output/'witness-index.json',list(witnesses.values()));write(output/'disagreements.json',conflicts)
    coverage=dict(full_by_method=groups(full,['method']),full_by_property=groups(full,['method','property_id']),
                  full_by_profile=groups(full,['method','profile']),full_by_scene=groups(full,['method','scene']),
                  full_by_parent=groups(full,['method','parent']),full_by_role=groups(full,['method','comparison_role']),
                  full_by_vacuity=groups(full,['method','gold_vacuous']),repeated_by_budget=groups(repeated,['method','seconds']))
    write(output/'metrics.json',coverage)
    summary=dict(stage='P5.5-scoring',jobs=len(jobs),queries_scored=len(rows),primary_query_rows=len(full),
        worker_statuses=dict(Counter(j['status'] for j in jobs)),disagreements=len(conflicts),unique_positive_witnesses=len(witnesses),
        full_by_method=coverage['full_by_method'],raw_original_window_insufficient_retained=1065,
        plc_baseline='NOT_CONFIGURED',reference_basis=gate['proof_basis'],efficiency_report_pending=True,
        total_recorded_job_wall_seconds=sum(j['wall_seconds'] or 0 for j in jobs),wall_time_records_missing=sum(j['wall_seconds'] is None for j in jobs))
    write(output/'summary.json',summary)
    seal(output,stage='P5.5-scoring',predictions_manifest_sha256=sha(experiment/'manifest.json'),admission_manifest_sha256=sha(review/'manifest.json'))
    print({k:v for k,v in summary.items() if k!='full_by_method'},flush=True)
