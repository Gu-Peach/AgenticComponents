"""Requirement-by-requirement completion audit of P5.3 through P5.5."""
from collections import Counter
from .common import setup,read,read_rows,sha,digest,write,seal,verify_files
from .experiment import assert_admitted,METHODS


def run(workspace,review,triggers,recheck,experiment,scores,efficiency,witnesses,report,static,analysis_plan,visual_qa,output):
    workspace=setup(workspace);output=output.resolve()
    if output.exists():raise ValueError('Use a new completion-audit directory')
    roots=dict(review=review,triggers=triggers,recheck=recheck,experiment=experiment,scores=scores,efficiency=efficiency,witnesses=witnesses,report=report)
    for root in roots.values():verify_files(root,read(root/'manifest.json')['files'])
    gate=assert_admitted(workspace,review);plan=read(experiment/'plan.json');completion=read(experiment/'completion.json')
    score=read(scores/'summary.json');replay=read(witnesses/'summary.json');eff=read(efficiency/'summary.json')
    truth=read(review/'summary.json');trigger=read(triggers/'summary.json');prior=read(recheck/'summary.json')
    struct=read(static);report_state=read(report/'report-summary.json');analysis=read(analysis_plan)
    check=[]
    def require(ident,ok,evidence,scope):check.append(dict(id=ident,status='PASS' if ok else 'FAIL',evidence=evidence,scope=scope))
    require('P53-reference-recheck',prior['conflicts']==0 and prior['independent_aggregation_differences']==0 and prior['new_evidence_rechecked']==12112,
            'recheck/summary.json','All P4 new evidence rechecked; inherited P3 immutable evidence retained with hash checks.')
    require('P53-correspondence-review',truth['instances']==1080 and truth['reviewed_clauses']==12 and truth['monitor_boundary_frames']==3144,
            'review/correspondence-review.json; instance-premises.json; monitor-boundaries.json','Conditional source review, not a proof-assistant claim.')
    require('P53-scope',truth['queries']==27495 and truth['truth_statuses']=={'CERTIFIED':26970,'NOT_APPLICABLE':525} and truth['source_verdicts_changed']==0,
            'review/queries.json; gold.jsonl','Exact selected view; legacy insufficient windows not relabeled.')
    remaining=read(review/'remaining-obligations.json')
    require('P53-trigger-review',trigger['conflicts']==0 and trigger['verdicts_changed'] is False and len(remaining['original_insufficient_windows'])==1065,
            'triggers/evidence-checks.json; review/remaining-obligations.json','Resolved/unknown trigger states and original window obligations retained.')
    require('P53-static-separation',struct['case_count']==576 and struct['unexpected_count']==0 and struct['structural_counts']=={'VALID':360,'INVALID_SYNTAX':72,'INVALID_TYPE':72,'UNKNOWN_CAPABILITY':72},
            'static/validation.json','Frontend task separate from dynamic query denominator.')
    require('P54-frozen-plan',len(plan['jobs'])==4536 and plan['workers']==1 and Counter(j['role'] for j in plan['jobs'])=={'full':3240,'repeated':1296},
            'experiment/plan.json','All cases/profiles and predeclared repeats; fixed paired method order and budgets.')
    require('P54-job-completion',completion['all_jobs_recorded'] and completion['predictions_sealed'] and completion['recorded']==4536 and score['jobs']==4536,
            'experiment/completion.json; all jobs manifests','Finished jobs can contain UNKNOWN; no claim that all queries are decided.')
    require('P54-operational-validity',set(score['worker_statuses'])<={'COMPLETED','WORKER_TIMEOUT'},
            'scores/job-scores.jsonl','Unexpected worker/input/source errors require investigation; a recorded error is not a valid mathematical answer.')
    require('P54-plan-provenance',completion['plan_sha256']==sha(experiment/'plan.json') and plan['reference_admission_manifest_sha256']==sha(review/'manifest.json'),
            'experiment/plan.json; completion.json','One reviewed input/implementation scope for every method.')
    require('P54-analysis-definition',analysis['prediction_plan_sha256']==sha(experiment/'plan.json') and analysis['scoring_source_sha256']==plan['scoring_source_sha256'],
            'analysis-plan.json','Main formulas before execution; audit/interval implementations before opening formal prediction values.')
    for method in METHODS:
        m=score['full_by_method'][method]
        require('P55-denominator-'+method,m['total']==27495 and m['applicable']==26970,
                'scores/metrics.json','All applicable rows include unanswered/errors; N/A separate.')
    require('P55-score-consistency',score['disagreements']==0,'scores/disagreements.json','Known verdict/trigger contradictions must be investigated, never silently dropped.')
    require('P55-positive-evidence',replay['issues']==0 and replay['verified']==replay['witnesses']==score['unique_positive_witnesses'],
            'witnesses/checks/*; reference-traces/*','Every distinct positive witness mapped to both models and checked against its query.')
    require('P55-repeated-efficiency',eff['repeated_jobs']==1296 and eff['case_count']==24 and eff['parent_count']==24 and eff['scenes']==12,
            'efficiency/paired-comparisons.json; repeated-job-data.json','Joint-completion time ratios separate from solve coverage/timeouts; grouped repeats.')
    require('P55-report',report_state['review_status']=='PASS' and len(report_state['figures'])==6,
            'report/P5最终实验报告.md; PNG/SVG artifacts','All plots from sealed metrics; conditional and unimplemented claims disclosed.')
    qa=read(visual_qa)
    require('P55-visual-inspection',len(qa['figures'])==6 and all(r['status']=='PASS' and sha(report/r['file'])==r['sha256'] for r in qa['figures']),
            'visual-qa.json','Rendered figures visually inspected for legibility, labeling and clipping after generation.')
    require('P55-source-links',all(report_state['source_manifests'][name]==sha(roots[name]/'manifest.json') for name in ('review','experiment','scores','efficiency','witnesses')),
            'report/report-summary.json','Report linked to the actual audited data packages.')
    require('P55-plc-boundary',report_state['plc_comparison_performed'] is False and plan['plc_baseline'].startswith('NOT_CONFIGURED'),
            'report limitations; experiment/plan.json','Conditional future PLC baseline not substituted by an algorithm ablation.')
    output.mkdir(parents=True)
    write(output/'requirements.json',check)
    all_decided=all(m['determinate']==m['applicable'] for m in score['full_by_method'].values())
    final=dict(p53_complete=all(c['status']=='PASS' for c in check if c['id'].startswith('P53')),
               p54_complete=all(c['status']=='PASS' for c in check if c['id'].startswith('P54')),
               p55_complete=all(c['status']=='PASS' for c in check if c['id'].startswith('P55')),
               all_required_checks_passed=all(c['status']=='PASS' for c in check),checks=len(check),
               all_jobs_finished=completion['all_jobs_recorded'] and completion['recorded']==score['jobs']==len(plan['jobs']),
               admitted_evidence_valid=replay['issues']==0 and replay['verified']==replay['witnesses'],
               selected_view_truth_complete=truth['truth_statuses']=={'CERTIFIED':26970,'NOT_APPLICABLE':525},all_algorithm_queries_decided=all_decided,
               unresolved_trigger_records=len(remaining['trigger_unknown']),original_window_obligations_retained=len(remaining['original_insufficient_windows']),
               plc_comparison='NOT_CONFIGURED_CONDITIONAL_FUTURE_WORK',
               review_basis='AI source-level conditional correspondence review plus machine-checked evidence; not arbitrary PLC/physical certification.',
               source_manifests={name:sha(root/'manifest.json') for name,root in roots.items()})
    write(output/'completion.json',final);seal(output,stage='P5-final-completion-audit')
    print(final,flush=True)
