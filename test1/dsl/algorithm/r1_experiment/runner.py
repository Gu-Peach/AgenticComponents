"""Pinned plans, independent workers and resumable serial execution."""
import argparse
from collections import Counter,defaultdict
from itertools import permutations
from pathlib import Path
import ctypes
import json
import os
import platform
import random
import shutil
import subprocess
import sys
import time
from final_p5.common import setup,read,write,sha,digest,seal,verify_files
from final_p5.experiment import assert_admitted

METHODS=('none','storage','portfolio')
SEED=20261103

def memory_info():
    class Memory(ctypes.Structure):
        _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(k,ctypes.c_ulonglong) for k in ('total_physical','available_physical','total_page','available_page','total_virtual','available_virtual','extended')]
    if os.name!='nt':return dict(status='not_windows')
    m=Memory();m.length=ctypes.sizeof(m)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):return dict(status='unavailable')
    return {k:getattr(m,k) for k in ('load','total_physical','available_physical')}

def source_pins(root):
    paths=[]
    for folder in ('src/acverify_v3','r1_experiment','final_p5'):
        paths.extend(p for p in (root/folder).rglob('*') if p.suffix in ('.py','.json') and '__pycache__' not in p.parts)
    paths.append(root/'tools/run_r1.py')
    return {p.relative_to(root).as_posix():sha(p) for p in paths}

def prepare(root,output):
    root=setup(root);output=Path(output).resolve()
    if output.exists():raise ValueError('Plan output exists; use run to resume, never replace it')
    review=root/'datasets/ac-path-v1/experiments/p5-final-v1/admission'
    gate=assert_admitted(root,review)
    prior_path=root/'datasets/ac-path-v1/experiments/p5-final-v1/run/plan.json'
    previous=read(prior_path);qs=read(review/'queries.json')['records'];groups=defaultdict(list)
    for q in qs:groups[q['case_id'],q['profile']].append(q)
    chosen=previous['selected_repeated_cases']
    selected={x['case_id'] for x in chosen}
    from acverify_v3.frontend import load_case
    inventory=[]
    for cid in sorted({q['case_id'] for q in qs}):
        data=load_case(root/'datasets/ac-path-v1/cases'/cid/'case.json',root)
        ns=data['ir']['nodes']
        inventory.append(dict(case_id=cid,parent=data['descriptor'].get('parent_id') or cid,scene=data['descriptor']['scene_id'],
            split=data['descriptor'].get('split'),nodes=len(ns),kinds=dict(Counter(n['kind'] for n in ns)),
            max_par_width=max((len(n['children']) for n in ns if n['kind']=='par'),default=0),
            materials=len(data['initial']['materials']),resources=len(data['relations']['resources']),
            devices=len(data['devices']),external_events=len(data['environment'].get('events',[])),
            source_inputs=data['input_hashes']))
    byid={x['case_id']:x for x in inventory}
    supplemental=['S04-P01']
    covered=set().union(*(set(byid[c]['kinds']) for c in selected))
    for d in inventory:
        if d['split']=='development' and set(d['kinds'])-covered:
            supplemental.append(d['case_id']);covered.update(d['kinds'])
    output.mkdir(parents=True)
    source=source_pins(root)
    inputs={}
    for (cid,profile),records in groups.items():
        if cid in selected or cid in supplemental:
            key=cid+'|'+profile;name=digest(key)[:20]+'.json'
            write(output/'inputs'/name,dict(records=records));inputs[key]=name
    jobs=[]
    def add(cid,profile,method,seconds,repeat,role,state_limit=20000,memory_mb=512,group_file=None,**meta):
        d=byid[cid]
        j=dict(case_id=cid,profile=profile,method=method,seconds=seconds,repeat=repeat,role=role,
               state_limit=state_limit,memory_mb=memory_mb,scene=d['scene'],parent=d['parent'],
               group_file=group_file or inputs[cid+'|'+profile],**meta)
        j['id']=digest(j)[:24];jobs.append(j)
    # Whole paired blocks are shuffled, then methods rotate within each block.
    blocks=[]
    for cid,profile in sorted(groups):
        if cid not in selected:continue
        for seconds in (.5,2.,10.,30.):
            for repeat in range(3):blocks.append((cid,profile,seconds,repeat))
    random.Random(SEED).shuffle(blocks);orders=list(permutations(METHODS))
    for i,(cid,profile,seconds,repeat) in enumerate(blocks):
        for method in orders[i%len(orders)]:add(cid,profile,method,seconds,repeat,'budget')
    for cid in sorted(selected|set(supplemental)):
        for c,profile in sorted(groups):
            if c==cid:add(cid,profile,'storage',2.,0,'profiling')
    development=sorted((x['case_id'] for x in inventory if x['split']=='development' and x['case_id'] in selected))
    resource_cases=['S04-P01']+development[:2]
    for cid in resource_cases:
        for c,profile in sorted(groups):
            if c!=cid:continue
            for states in (20000,80000,320000):add(cid,profile,'storage',10.,0,'state_sensitivity',state_limit=states)
            for memory in (512,1024,2048):add(cid,profile,'storage',10.,0,'memory_sensitivity',memory_mb=memory)
    # Existing admitted K identities, searched separately; this is a boundary diagnostic.
    scale_cases=[next(x['case_id'] for x in chosen if x['scene']==scene) for scene in sorted({x['scene'] for x in chosen})]
    for cid in scale_cases:
        for bound in sorted({q['bound_ticks'] for q in groups[cid,'nominal']}):
            records=[q for q in groups[cid,'nominal'] if q['bound_ticks']==bound]
            name=digest([cid,'nominal',bound])[:20]+'.json';write(output/'inputs'/name,dict(records=records))
            add(cid,'nominal','storage',2.,0,'bound_diagnostic',group_file=name,bound_subset=bound)
    jobs.sort(key=lambda j:({'profiling':0,'state_sensitivity':1,'memory_sensitivity':2,'bound_diagnostic':3,'budget':4}[j['role']]))
    if len({j['id'] for j in jobs})!=len(jobs):raise ValueError('Duplicate job ID')
    plan=dict(id='method1-r1/0.1',seed=SEED,workspace=str(root),review=str(review),jobs=jobs,
        selected_repeated_cases=chosen,supplemental_structure_cases=supplemental,inventory=inventory,
        source_pins=source,implementation_hashes=previous['implementation_hashes'],model_digests=previous['model_digests'],
        p5_plan_sha256=sha(prior_path),admission_manifest_sha256=sha(review/'manifest.json'),
        gold_sha256=gate['gold_sha256'],queries_sha256=sha(review/'queries.json'),
        input_hashes={p.name:sha(p) for p in (output/'inputs').iterdir()},
        artifacts=str(root/'artifacts/next-round-v1'),workers=1,watchdog_extra_seconds=45,
        roles=dict(Counter(j['role'] for j in jobs)),search_seconds_ceiling=sum(j['seconds'] for j in jobs),
        timing_policy='Original uninstrumented engine for timed jobs; profiler isolated. Group budget shared across queries and portfolio stages.',
        scale_policy='Existing-case observational inventory and admitted K subsets. New controlled node/material families remain a separate obligation.',
        resource_policy='Fixed before prediction; all state/memory candidates run on fixed development cases; one axis changes at a time.',
        error_policy='Source/input drift stops batch; other errors preserved, not rerun by outcome; no outcome-dependent stopping.',
        python=sys.version,platform=platform.platform(),hardware=memory_info())
    write(output/'plan.json',plan)
    for relative in source:
        dest=output/'source-snapshot'/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/relative,dest)
    seal(output/'source-snapshot',kind='r1-source-snapshot/0.1')
    seal(output/'inputs',kind='r1-unlabeled-inputs/0.1')
    write(output/'freeze.json',dict(plan_sha256=sha(output/'plan.json'),source_snapshot=sha(output/'source-snapshot/manifest.json'),inputs_manifest=sha(output/'inputs/manifest.json')))
    from .plc import prepare_pilot
    prepare_pilot(root,output)
    return plan

def validate(root,output,plan):
    freeze=read(output/'freeze.json')
    if sha(output/'plan.json')!=freeze['plan_sha256']:raise ValueError('Plan drift')
    verify_files(root,plan['source_pins'])
    if sha(output/'inputs/manifest.json')!=freeze['inputs_manifest']:raise ValueError('Input manifest drift')
    verify_files(output/'inputs',read(output/'inputs/manifest.json')['files'])
    if sha(output/'source-snapshot/manifest.json')!=freeze['source_snapshot']:raise ValueError('Snapshot manifest drift')
    verify_files(output/'source-snapshot',read(output/'source-snapshot/manifest.json')['files'])
    review=Path(plan['review'])
    if sha(review/'manifest.json')!=plan['admission_manifest_sha256'] or sha(review/'queries.json')!=plan['queries_sha256']:raise ValueError('Admission drift')

def alive(pid):
    if os.name!='nt':
        try:os.kill(pid,0);return True
        except ProcessLookupError:return False
    kernel=ctypes.windll.kernel32
    kernel.OpenProcess.restype=ctypes.c_void_p
    handle=kernel.OpenProcess(0x1000,False,pid)
    if not handle:return False
    value=ctypes.c_ulong()
    try:
        if not kernel.GetExitCodeProcess(ctypes.c_void_p(handle),ctypes.byref(value)):raise OSError('Cannot inspect runner PID')
        return value.value==259
    finally:kernel.CloseHandle(ctypes.c_void_p(handle))

def worker(root,spec,output,profiling=False):
    from final_p5.worker import execute
    from .instrument import observe
    if profiling:
        output.parent.mkdir(parents=True,exist_ok=True)
        profile_path=output.parent/(output.name+'.prof')
        with observe(profile_path) as telemetry:status=execute(root,spec,output)
        write(output/'profiling.json',telemetry)
        shutil.move(str(profile_path),str(output/'worker.prof'))
        seal(output,kind='r1-profile-worker/0.1')
        return status
    return execute(root,spec,output)

def run(root,output,smoke=False):
    root=setup(root);output=Path(output).resolve();plan=read(output/'plan.json')
    validate(root,output,plan)
    if smoke:
        candidate=next(j for j in plan['jobs'] if j['role']=='budget' and j['seconds']==.5 and j['profile']=='nominal')
        jobs=[candidate]
        work=output/'smoke'
    else:
        jobs=plan['jobs'];work=output
    lock=output/('smoke.lock' if smoke else 'runner.lock')
    if lock.exists():
        old=read(lock)
        if alive(old['pid']):raise ValueError('Another runner is alive')
        lock.unlink()
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
    with os.fdopen(fd,'w') as f:json.dump(dict(pid=os.getpid(),started=time.time()),f)
    try:
        from .report import progress,score
        for index,j in enumerate(jobs):
            dest=work/'jobs'/j['id']
            if dest.exists():
                verify_files(dest,read(dest/'manifest.json')['files'])
                existing=read(dest/'result.json')
                if existing['job']!=j or existing['plan_sha256']!=sha(output/'plan.json'):raise ValueError('Resume mismatch')
                continue
            verify_files(root,plan['source_pins'])
            query_path=output/'inputs'/j['group_file']
            if sha(query_path)!=plan['input_hashes'][j['group_file']]:raise ValueError('Input drift')
            spec=dict(job=j,plan_sha256=sha(output/'plan.json'),queries_path=str(query_path),
                      query_sha256=sha(query_path),implementation_hashes=plan['implementation_hashes'],
                      expected_model_digest=plan['model_digests'][j['case_id']+'|'+j['profile']])
            spec_path=work/'job-specs'/(j['id']+'.json');write(spec_path,spec)
            attempt=work/'attempts'/(j['id']+'-'+str(time.time_ns()))
            command=[sys.executable,'-B','-X','utf8',str(root/'tools/run_r1.py'),'worker','--workspace',str(root),
                     '--output',str(attempt),'--spec',str(spec_path)]
            if j['role']=='profiling':command.append('--profiling')
            begin=time.perf_counter()
            try:
                result=subprocess.run(command,capture_output=True,timeout=j['seconds']+plan['watchdog_extra_seconds'])
                if not (attempt/'result.json').exists():
                    attempt.mkdir(parents=True,exist_ok=True)
                    write(attempt/'result.json',dict(job=j,plan_sha256=sha(output/'plan.json'),query_sha256=sha(query_path),
                          status='WORKER_CRASH',stdout=result.stdout.decode('utf8','replace')[-2000:],stderr=result.stderr.decode('utf8','replace')[-4000:]))
                    seal(attempt,kind='r1-worker-crash/0.1')
            except subprocess.TimeoutExpired as e:
                # Preserve partial output outside the promoted immutable result.
                write(attempt/'result.json',dict(job=j,plan_sha256=sha(output/'plan.json'),query_sha256=sha(query_path),
                      status='WORKER_TIMEOUT',watchdog_seconds=j['seconds']+45))
                seal(attempt,kind='r1-worker-timeout/0.1')
            verify_files(root,plan['source_pins'])
            validate_result=read(attempt/'result.json')
            if validate_result['status']=='INPUT_OR_SOURCE_DRIFT':raise ValueError(validate_result)
            verify_files(attempt,read(attempt/'manifest.json')['files'])
            dest.parent.mkdir(parents=True,exist_ok=True);attempt.rename(dest)
            write(work/'wall-times'/(j['id']+'.json'),dict(wall_seconds=time.perf_counter()-begin))
            if not smoke:
                summary=progress(output,plan)
                if index%12==0:print(summary,flush=True)
        if smoke:
            write(work/'completion.json',dict(jobs=1,status=read(work/'jobs'/jobs[0]['id']/'result.json')['status']))
            return
        validate(root,output,plan)
        for j in jobs:verify_files(output/'jobs'/j['id'],read(output/'jobs'/j['id']/'manifest.json')['files'])
        write(output/'completion.json',dict(jobs=len(jobs),all_jobs_recorded=True,predictions_sealed=True,source_unchanged=True))
        write(output/'prediction-manifest.json',dict(files={p.relative_to(output).as_posix():sha(p) for p in (output/'jobs').rglob('*') if p.is_file()}))
        score(output,root)
        print(dict(status='PREDICTIONS_SCORED',jobs=len(jobs),human_review_pending=True),flush=True)
    except BaseException as e:
        write(output/'runner-error.json',dict(type=type(e).__name__,message=str(e),time=time.time()))
        raise
    finally:lock.unlink(missing_ok=True)
