"""Frozen v3 versus opt-in storage/portfolio. Workers never read reference labels."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import random
import subprocess
import sys
import time

BASE=Path(__file__).resolve().parents[1]
def read(p):return json.loads(Path(p).read_text(encoding='utf8'))
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(p,v):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True)
    temporary=p.with_suffix('.tmp');temporary.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf8');temporary.replace(p)
def sources(root):return {p.name:sha(p) for p in (root/'src/acverify').glob('*.py')}


def worker(a):
    job=read(a.job);impl=a.baseline if job['method']=='baseline' else BASE
    sys.path.insert(0,str(impl/'src'))
    from acverify.pipeline import verify
    options={} if job['method']=='baseline' else {'optimization':job['method']}
    begin=time.perf_counter()
    result,traces,_=verify(a.workspace/'datasets/ac-path-v1/cases'/job['case_id']/'case.json',a.workspace,
        profile=job['profile'],bound=3000,states=20000,seconds=job['seconds'],memory_mb=512,reduction='auto',**options)
    trace_files={}
    for name,w in traces.items():
        p=a.output.parent/'traces'/job['id']/(name+'.json');write(p,w)
        trace_files[name]={'path':p.relative_to(a.output.parent).as_posix(),'sha256':sha(p)}
    write(a.output,{'job':job,'result':result,'worker_seconds':time.perf_counter()-begin,'trace_files':trace_files})


def make_plan(a):
    root=a.workspace/'datasets/ac-path-v1'
    ids=[c for c in read(root/'manifest.json')['cases'] if '-DS' not in c]
    selected=read(a.workspace/'artifacts/method1-v3/plan.json')['selected_cases']
    jobs=[]
    def add(cid,profile,method,seconds,repeat,role):
        j=dict(case_id=cid,profile=profile,method=method,seconds=seconds,repeat=repeat,role=role)
        j['id']=hashlib.sha256(json.dumps(j,sort_keys=True).encode()).hexdigest()[:20];jobs.append(j)
    for cid in ids:
        for method in ('baseline','storage'):add(cid,'nominal',method,.5,0,'full_nominal')
    for cid in selected:
        for seconds in (.5,2.):
            for repeat in range(3):
                for method in ('baseline','storage','portfolio'):add(cid,'nominal',method,seconds,repeat,'ablation')
        pilot=read(root/'cases'/cid/'case.json')['schema_type']=='PilotCase'
        for profile in ('delayed','stop_unknown_c1' if pilot else 'fault'):
            for method in ('baseline','storage'):add(cid,profile,method,.5,0,'stress')
    # Measured order is fixed before looking at answers, keeping each stage serial.
    random.Random(20261103).shuffle(jobs)
    return {'id':'solver-optimization/0.4','jobs':jobs,'selected_cases':selected,'workers':1,
            'repeats':3,'bound':3000,'state_limit':20000,'memory_mb':512,
            'baseline_sources':sources(a.baseline),'optimized_sources':sources(BASE),
            'runner_sha256':sha(__file__),'core_sha256':sha(a.workspace/'experiments/method1-v3/core.json'),
            'core_freeze_sha256':sha(a.workspace/'experiments/method1-v3/freeze.json'),
            'input_locks':{c:sha(root/'cases'/c/'dependencies.lock.json') for c in ids},
            'python':sys.version,'platform':platform.platform(),
            'budget_scope':'search phase; portfolio shares this cap between its phases; report model construction and replay separately',
            'portfolio_split':{'witness_max_fraction':.15,'exhaustive':'remaining total search budget'},
            'scope':'O0 profiling; O1 copy and edge storage; O2 targeted witness portfolio; no new semantic reduction or oracle labels'}


def main(a):
    a.output.mkdir(parents=True,exist_ok=True);plan=make_plan(a);path=a.output/'plan.json'
    if path.exists():
        if read(path)!=plan:raise ValueError('Plan/code/input changed; choose a new output')
    else:write(path,plan)
    plan_sha=sha(path);begin=time.monotonic()
    for i,j in enumerate(plan['jobs'],1):
        final=a.output/'jobs'/(j['id']+'.json')
        if final.exists():
            saved=read(final)
            if saved['job']!=j or saved['plan_sha256']!=plan_sha:raise ValueError('Checkpoint does not match plan')
            continue
        spec=a.output/'job-specs'/(j['id']+'.json');write(spec,j)
        target=a.output/'worker-output'/(j['id']+'.json')
        command=[sys.executable,'-B','-X','utf8',str(Path(__file__).resolve()),'--worker','--workspace',str(a.workspace),
                 '--baseline',str(a.baseline),'--job',str(spec),'--output',str(target)]
        started=time.monotonic()
        try:
            p=subprocess.run(command,capture_output=True,timeout=j['seconds']+20)
            row=read(target) if p.returncode==0 and target.exists() else {'job':j,'result':{'status':'WORKER_ERROR','message':p.stderr.decode('utf8',errors='replace')[-2000:]}}
        except subprocess.TimeoutExpired:row={'job':j,'result':{'status':'WORKER_TIMEOUT'}}
        row.update(wall_seconds=time.monotonic()-started,plan_sha256=plan_sha);write(final,row)
        if i%40==0 or i==len(plan['jobs']):print(json.dumps({'done':i,'total':len(plan['jobs']),'elapsed':round(time.monotonic()-begin,1)}),flush=True)
    write(a.output/'completion.json',{'jobs':len(plan['jobs']),'recorded':sum((a.output/'jobs'/(j['id']+'.json')).exists() for j in plan['jobs']),
          'source_unchanged':sources(a.baseline)==plan['baseline_sources'] and sources(BASE)==plan['optimized_sources'] and sha(__file__)==plan['runner_sha256']})


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True)
    p.add_argument('--baseline',type=Path,default=BASE/'baselines/solver-v3');p.add_argument('--output',type=Path,required=True)
    p.add_argument('--worker',action='store_true');p.add_argument('--job',type=Path)
    a=p.parse_args();worker(a) if a.worker else main(a)
