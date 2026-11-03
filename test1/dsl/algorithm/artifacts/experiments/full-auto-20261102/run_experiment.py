"""Serial, isolated, paired method-one experiment. Never reads oracle labels."""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import subprocess
import sys
import time
from datetime import datetime,timezone

def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def write(p,d):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def worker(args):
    sys.path.insert(0,str(args.workspace/'src'))
    from acverify.pipeline import verify
    from acverify.budgets import resident_bytes
    start=time.perf_counter()
    result,traces,_=verify(args.workspace/'datasets/ac-path-v1/cases'/args.case/'case.json',args.workspace,
        profile='nominal',bound=3000,states=20000,seconds=1,memory_mb=512,reduction=args.method,search='complete',backend='explicit')
    elapsed=time.perf_counter()-start
    # Trace replay happens inside verify. Preserve compact witness endpoints and
    # hashes instead of duplicating large snapshots for every experiment job.
    witness_summary={k:{'ticks':v['steps'][-1]['state']['tick'] if v['steps'] else v['initial']['tick'],
        'model_digest':v['model_digest'],'replay':result.get('replays',{}).get(k)} for k,v in traces.items()}
    write(args.output,{'case_id':args.case,'scene_id':args.case[:3],'profile':'nominal','method':args.method,'repeat':1,
        'bound':3000,'search_budget_seconds':1,'result':result,'elapsed_total_seconds':elapsed,
        'worker_peak_rss_bytes':max(resident_bytes() or 0,result.get('peak_sampled_rss_bytes',0)),
        'witness_summary':witness_summary})

def main(args):
    import psutil
    root=args.output;root.mkdir(parents=True,exist_ok=True)
    manifest=args.workspace/'datasets/ac-path-v1/manifest.json'
    ids=read(manifest)['cases'];rng=random.Random(20261102);rng.shuffle(ids)
    if args.limit:ids=ids[:args.limit]
    jobs=[]
    for i,cid in enumerate(ids):
        methods=['full','auto'] if i%2==0 else ['auto','full']
        for method in methods:jobs.append({'case_id':cid,'method':method,'order':len(jobs)})
    code={str(p.relative_to(args.workspace)):digest(p) for p in (args.workspace/'src/acverify').glob('*.py')}
    config={'experiment_id':'method1-full-auto-20261102','local_date':'2026-11-02','started_utc':datetime.now(timezone.utc).isoformat(),
        'profile':'nominal','bound_ticks':3000,'search_budget_seconds':1,'state_budget':20000,'memory_mb':512,
        'worker_watchdog_seconds':20,'workers_in_parallel':1,'repeats':1,'seed':20261102,
        'order':'shuffled cases, balanced alternating AB/BA per case','expected_jobs':len(jobs),'cases':len(ids),
        'manifest_sha256':digest(manifest),'algorithm_hashes':code,'python':platform.python_version(),
        'platform':platform.platform(),'processor':platform.processor(),'logical_cpus':os.cpu_count(),
        'physical_memory_bytes':psutil.virtual_memory().total,
        'scope':'all 576 core cases, nominal only, not every query-plan combination; no PLC comparison or accuracy claims',
        'timing':'search timer from solver; worker total includes binding/build/search/replay, excludes process startup and JSON serialization'}
    write(root/'config.json',config);write(root/'jobs.json',jobs)
    done={}
    log=root/'results.jsonl'
    if log.exists():
        for line in log.read_text(encoding='utf-8').splitlines():
            row=json.loads(line);done[(row['case_id'],row['method'])]=row
    start=time.perf_counter()
    for job in jobs:
        cid,method=job['case_id'],job['method']
        if (cid,method) in done:continue
        target=root/'jobs'/cid/(method+'.json');target.parent.mkdir(parents=True,exist_ok=True)
        command=[sys.executable,'-B','-X','utf8',str(Path(__file__).resolve()),'--worker','--workspace',str(args.workspace),
                 '--case',cid,'--method',method,'--output',str(target)]
        launched=time.perf_counter();process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        peak=0;watchdog=False
        monitored=psutil.Process(process.pid)
        while process.poll() is None:
            try:peak=max(peak,monitored.memory_info().rss)
            except psutil.Error:pass
            if time.perf_counter()-launched>20:
                watchdog=True;process.kill();break
            time.sleep(0.025)
        stdout,stderr=process.communicate(timeout=5)
        if not watchdog and process.returncode==0 and target.exists():row=read(target)
        else:
            row={'case_id':cid,'scene_id':cid[:3],'profile':'nominal','method':method,'repeat':1,'bound':3000,
                 'search_budget_seconds':1,'elapsed_total_seconds':None,
                 'result':{'status':'WORKER_TIMEOUT' if watchdog else 'WORKER_ERROR','properties':{},
                           'message':stderr.decode('utf-8',errors='replace')[-4000:]}}
        row.update(job_order=job['order'],worker_peak_rss_bytes=max(peak,row.get('worker_peak_rss_bytes',0)),
                   wall_including_startup_seconds=time.perf_counter()-launched)
        write(target,row)
        with log.open('a',encoding='utf-8') as stream:stream.write(json.dumps(row,ensure_ascii=False)+'\n');stream.flush()
        done[(cid,method)]=row
        if len(done)%24==0 or len(done)==len(jobs):
            progress={'done':len(done),'total':len(jobs),'elapsed_seconds':round(time.perf_counter()-start,1),
                      'worker_failures':sum(r['result']['status'] in ('WORKER_ERROR','WORKER_TIMEOUT') for r in done.values())}
            write(root/'progress.json',progress);print(json.dumps(progress),flush=True)
    changed=[p for p,h in code.items() if digest(args.workspace/p)!=h]
    finish={'jobs':len(done),'expected':len(jobs),'algorithm_unchanged':not changed,'changed_files':changed,
            'manifest_unchanged':digest(manifest)==config['manifest_sha256'],
            'status_counts':dict(collections.Counter(r['result']['status'] for r in done.values()))}
    write(root/'completion.json',finish);print(json.dumps(finish),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--worker',action='store_true');p.add_argument('--case');p.add_argument('--method');p.add_argument('--limit',type=int,default=0)
    a=p.parse_args()
    worker(a) if a.worker else main(a)
