"""Serial, resumable, source-pinned paired experiments."""
from collections import defaultdict,Counter
from pathlib import Path
import platform
import random
import subprocess
import sys
import time
import os
from itertools import permutations
from .common import setup,read,write,sha,digest,seal,verify_files

METHODS=('none','storage','portfolio')
SEED=20261103


def assert_admitted(workspace,review):
    verify_files(review,read(review/'manifest.json')['files'])
    gate=read(review/'gate.json')
    if gate['status']!='ADMITTED_CONDITIONAL_REVIEW' or not gate['eligible_for_accuracy']:raise ValueError('P5.3 admission is not open')
    verify_files(workspace,gate['source_hashes'])
    from alignment_p5.io import sources
    if sources(workspace)!=gate['legacy_source_hashes']:raise ValueError('Reference/legacy sources changed')
    if sha(review/'queries.json')!=gate['queries_sha256']:raise ValueError('Admitted queries changed')
    return gate


def make_plan(workspace,review,output,code_root):
    workspace=setup(workspace);gate=assert_admitted(workspace,review)
    qdata=read(review/'queries.json');queries=qdata['records'];groups=defaultdict(list)
    for q in queries:groups[q['case_id'],q['profile']].append(q)
    model_map={(r['case_id'],r['profile']):r['sut_model_digest'] for r in read(review/'instance-premises.json')}
    descriptors={cid:read(workspace/'datasets/ac-path-v1/cases'/cid/'case.json') for cid,_ in groups}
    families=defaultdict(dict)
    for cid,d in descriptors.items():families[d['scene_id']].setdefault(d['parent_id'] or cid,[]).append(cid)
    selected=[]
    for scene_index,(scene,parents) in enumerate(sorted(families.items())):
        ranked=sorted(parents,key=lambda p:digest([SEED,scene,p]))[:2]
        for position,parent in enumerate(ranked):
            members=sorted(parents[parent]);variant=(scene_index*2+position)%len(members)
            selected.append(dict(scene=scene,parent=parent,case_id=members[variant],variant_slot=variant))
    jobs=[]
    def add(cid,profile,method,seconds,repeat,role):
        d=descriptors[cid]
        job=dict(case_id=cid,profile=profile,method=method,seconds=seconds,repeat=repeat,role=role,
                 scene=d['scene_id'],parent=d['parent_id'] or cid,state_limit=20000,memory_mb=512)
        job['id']=digest(job)[:24];jobs.append(job)
    for cid,profile in sorted(groups):
        for method in METHODS:add(cid,profile,method,.5,0,'full')
    for chosen in selected:
        cid=chosen['case_id']
        for _,profile in sorted(k for k in groups if k[0]==cid):
            for seconds in (.5,2.):
                for repeat in range(3):
                    for method in METHODS:add(cid,profile,method,seconds,repeat,'repeated')
    blocks=defaultdict(list)
    for job in jobs:blocks[(job['case_id'],job['profile'],job['seconds'],job['repeat'],job['role'])].append(job)
    ordered=list(blocks.values());random.Random(SEED).shuffle(ordered);orders=list(permutations(METHODS));jobs=[]
    for i,block in enumerate(ordered):
        by_method={j['method']:j for j in block}
        jobs.extend(by_method[m] for m in orders[i%len(orders)])
    if len({j['id'] for j in jobs})!=len(jobs):raise ValueError('Duplicate job ID')
    implementation={p.name:sha(p) for p in (workspace/'src/acverify_v3').iterdir() if p.suffix in ('.py','.json')}
    runner_files=['final_p5/common.py','final_p5/worker.py','final_p5/experiment.py','tools/run_p54_experiment.py']
    runner_sources={p:sha(code_root/p) for p in runner_files}
    plan=dict(id='method1-p54/0.1',seed=SEED,methods=list(METHODS),jobs=jobs,selected_repeated_cases=selected,
              reference_admission_manifest_sha256=sha(review/'manifest.json'),queries_sha256=sha(review/'queries.json'),
              query_records_digest=qdata['records_digest'],gold_not_read_by_plan_or_workers=True,
              implementation_hashes=implementation,runner_sources=runner_sources,
              scoring_source_sha256=sha(code_root/'final_p5/scoring.py'),
              metric_contract={'solved_coverage':'determinate/applicable','answered_accuracy':'correct/determinate; null when zero',
                               'correct_all':'correct/applicable','unknown':'retained; not a correct or incorrect determinate answer',
                               'efficiency':'paired same scope/budget; completed-and-correct runtime ratios separate from coverage and timeout rates'},
              input_locks={cid:sha(workspace/'datasets/ac-path-v1/cases'/cid/'dependencies.lock.json') for cid in descriptors},
              case_descriptors={cid:sha(workspace/'datasets/ac-path-v1/cases'/cid/'case.json') for cid in descriptors},
              model_digests={cid+'|'+prof:value for (cid,prof),value in model_map.items()},
              workers=1,worker_watchdog_extra_seconds=45,python=sys.version,platform=platform.platform(),
              timing_policy='Search budgets shared by portfolio passes; model construction, replay and worker wall time reported separately. Sampled RSS, not a hard OS memory reservation.',
              selection_policy='Two parent families per scene by seeded hash, then a fixed rotating semantic-variant slot. No outcome-based selection.',
              ordering_policy='Seeded shuffled case/profile/budget/repeat blocks; cycle all six method permutations within blocks.',
              scope_policy='All admitted original-view queries scored once per method in full cohort; repeated sample is separate. N/A is never in the applicable accuracy denominator.',
              plc_baseline='NOT_CONFIGURED; these are aligned algorithm baselines/ablations, not a PLC-tool comparison.')
    if output.exists():
        if read(output/'plan.json')!=plan:raise ValueError('Resume plan/source/input differs; use a new output directory')
        return plan
    output.mkdir(parents=True)
    write(output/'plan.json',plan);write(output/'queries.json',qdata)
    inputs={}
    for (cid,profile),qs in groups.items():
        relative='inputs/'+cid+'/'+profile+'.json';h=write(output/relative,dict(records=qs))
        inputs[cid+'|'+profile]=dict(path=relative,sha256=h)
    write(output/'input-index.json',inputs)
    snapshot=output/'source-snapshot'
    for folder in ('src/acverify_v3',):
        for p in (workspace/folder).iterdir():
            if p.suffix in ('.py','.json'):
                dest=snapshot/p.relative_to(workspace);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(p.read_bytes())
    for relative in runner_sources:
        dest=snapshot/relative;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((code_root/relative).read_bytes())
    seal(snapshot,kind='p54-frozen-sources/0.1')
    return plan


def validate_resume(output,plan):
    index=read(output/'input-index.json')
    for item in index.values():
        if sha(output/item['path'])!=item['sha256']:raise ValueError('Frozen worker query changed')
    verify_files(output/'source-snapshot',read(output/'source-snapshot/manifest.json')['files'])
    return index


def run(workspace,review,output,code_root,plan_only=False):
    workspace=setup(workspace);review=review.resolve();output=output.resolve();code_root=code_root.resolve()
    plan=make_plan(workspace,review,output,code_root);inputs=validate_resume(output,plan);plan_sha=sha(output/'plan.json')
    if plan_only:
        print(dict(jobs=len(plan['jobs']),roles=dict(Counter(j['role'] for j in plan['jobs'])),selected=len(plan['selected_repeated_cases'])),flush=True);return
    if (output/'completion.json').exists() and read(output/'completion.json').get('predictions_sealed'):
        verify_files(output,read(output/'manifest.json')['files'])
        print(dict(already_complete=True,jobs=len(plan['jobs']),output=str(output)),flush=True);return
    import psutil
    state_path=output/'runner-state.json'
    if state_path.exists():
        prior=read(state_path)
        if prior.get('status')=='RUNNING':
            try:
                live=psutil.Process(prior['pid'])
                if live.is_running() and live.create_time()==prior['process_created']:
                    raise ValueError('An experiment runner is still live: PID '+str(prior['pid']))
            except psutil.NoSuchProcess:pass
    runner=dict(status='RUNNING',pid=os.getpid(),process_created=psutil.Process().create_time(),plan_sha256=plan_sha)
    write(state_path,runner)
    completed=0;begin=time.monotonic()
    for job in plan['jobs']:
        final=output/'jobs'/job['id'];result_path=final/'result.json'
        if (final/'manifest.json').exists():
            verify_files(final,read(final/'manifest.json')['files']);saved=read(result_path)
            if saved['job']!=job or saved['plan_sha256']!=plan_sha:raise ValueError('Existing job does not match plan')
            completed+=1;continue
        if final.exists():
            raise ValueError('Partial worker directory requires explicit recovery: '+str(final))
        attempt_root=output/'attempts'/job['id'];attempt_root.mkdir(parents=True,exist_ok=True)
        finished=sorted((p for p in attempt_root.iterdir() if (p/'manifest.json').exists()),key=lambda p:p.name)
        if finished:
            attempt=finished[0];verify_files(attempt,read(attempt/'manifest.json')['files'])
            prior=read(attempt/'result.json')
            if prior['job']!=job or prior['plan_sha256']!=plan_sha:raise ValueError('Interrupted attempt differs from plan')
            if not attempt.resolve().is_relative_to(output) or not final.resolve().is_relative_to(output):raise ValueError('Promotion escapes output')
            final.parent.mkdir(parents=True,exist_ok=True);attempt.rename(final);completed+=1;continue
        attempt_number=len(list(attempt_root.iterdir()))+1
        while (attempt_root/str(attempt_number)).exists():attempt_number+=1
        attempt=attempt_root/str(attempt_number)
        group=job['case_id']+'|'+job['profile'];entry=inputs[group]
        spec=dict(job=job,plan_sha256=plan_sha,queries_path=str(output/entry['path']),query_sha256=entry['sha256'],
                  expected_model_digest=plan['model_digests'][group],implementation_hashes=plan['implementation_hashes'])
        spec_path=output/'job-specs'/(job['id']+'.json');write(spec_path,spec)
        command=[sys.executable,'-B','-X','utf8',str(code_root/'tools/run_p54_experiment.py'),'--worker','--workspace',str(workspace),'--job',str(spec_path),'--output',str(attempt)]
        started=time.monotonic()
        try:
            p=subprocess.run(command,capture_output=True,timeout=job['seconds']+plan['worker_watchdog_extra_seconds'])
            if not (attempt/'manifest.json').exists():
                attempt.mkdir(parents=True,exist_ok=True)
                write(attempt/'result.json',dict(job=job,plan_sha256=plan_sha,query_sha256=entry['sha256'],status='WORKER_PROCESS_ERROR',
                    returncode=p.returncode,stderr=p.stderr.decode('utf8',errors='replace')[-6000:]))
                seal(attempt,kind='p54-worker-output/0.1')
        except subprocess.TimeoutExpired:
            attempt.mkdir(parents=True,exist_ok=True)
            write(attempt/'result.json',dict(job=job,plan_sha256=plan_sha,query_sha256=entry['sha256'],status='WORKER_TIMEOUT',
                                  watchdog_seconds=job['seconds']+plan['worker_watchdog_extra_seconds']))
            seal(attempt,kind='p54-worker-output/0.1')
        write(output/'wall-times'/(job['id']+'.json'),dict(job_id=job['id'],wall_seconds=time.monotonic()-started))
        if not attempt.resolve().is_relative_to(output) or not final.resolve().is_relative_to(output) or final.exists():
            raise ValueError('Unsafe or conflicting worker promotion')
        final.parent.mkdir(parents=True,exist_ok=True);attempt.rename(final)
        if read(final/'result.json')['status']=='INPUT_OR_SOURCE_DRIFT':
            write(state_path,{**runner,'status':'INTEGRITY_FAILURE','job_id':job['id']})
            raise ValueError('Frozen model/source drift detected; remaining jobs were not run')
        completed+=1
        if completed%40==0 or completed==len(plan['jobs']):
            write(state_path,{**runner,'jobs_done':completed,'total':len(plan['jobs'])})
            print(dict(jobs_done=completed,total=len(plan['jobs']),elapsed_seconds=round(time.monotonic()-begin,1)),flush=True)
    verify_files(code_root,plan['runner_sources'])
    if {p.name:sha(p) for p in (workspace/'src/acverify_v3').iterdir() if p.suffix in ('.py','.json')}!=plan['implementation_hashes']:
        raise ValueError('Implementation changed during experiment')
    for cid,h in plan['input_locks'].items():
        if sha(workspace/'datasets/ac-path-v1/cases'/cid/'dependencies.lock.json')!=h:raise ValueError('Input lock changed')
        if sha(workspace/'datasets/ac-path-v1/cases'/cid/'case.json')!=plan['case_descriptors'][cid]:raise ValueError('Descriptor changed')
    assert_admitted(workspace,review)
    write(output/'completion.json',dict(jobs=len(plan['jobs']),recorded=completed,plan_sha256=plan_sha,source_unchanged=True,
                                       all_jobs_recorded=completed==len(plan['jobs']),predictions_sealed=True))
    write(state_path,{**runner,'status':'COMPLETE','jobs_done':completed,'total':len(plan['jobs'])})
    seal(output,kind='p54-frozen-predictions/0.1',plan_sha256=plan_sha,reference_admission_manifest_sha256=sha(review/'manifest.json'))
    print(dict(completed=completed,output=str(output)),flush=True)
