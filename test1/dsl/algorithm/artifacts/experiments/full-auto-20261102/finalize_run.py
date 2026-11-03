"""Rerun predeclared interference pairs, retain originals, validate pairing."""
import json
from pathlib import Path
import subprocess
import sys
import time
import psutil
from run_experiment import read,write,digest

ROOT=Path(__file__).resolve().parent
RUN=ROOT/'run'
WORKSPACE=Path(r'E:\project\AgenticComponents\test1\dsl\algorithm')

assert read(RUN/'completion.json')['jobs']==1152
affected=set(read(RUN/'interference-audit.json')['cases'])
replacement=[]
for job in read(RUN/'jobs.json'):
    if job['case_id'] not in affected:continue
    cid,method=job['case_id'],job['method'];out=RUN/'reruns'/cid/(method+'.json');out.parent.mkdir(parents=True,exist_ok=True)
    command=[sys.executable,'-B','-X','utf8',str(ROOT/'run_experiment.py'),'--worker','--workspace',str(WORKSPACE),
             '--case',cid,'--method',method,'--output',str(out)]
    start=time.perf_counter();p=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE);mon=psutil.Process(p.pid);peak=0;timeout=False
    while p.poll() is None:
        try:peak=max(peak,mon.memory_info().rss)
        except psutil.Error:pass
        if time.perf_counter()-start>20:timeout=True;p.kill();break
        time.sleep(.025)
    _,err=p.communicate(timeout=5)
    if not timeout and p.returncode==0:r=read(out)
    else:r={'case_id':cid,'scene_id':cid[:3],'method':method,'profile':'nominal','repeat':1,'bound':3000,'search_budget_seconds':1,
            'result':{'status':'WORKER_TIMEOUT' if timeout else 'WORKER_ERROR','properties':{},'message':err.decode('utf-8',errors='replace')}}
    r.update(job_order=job['order'],worker_peak_rss_bytes=max(peak,r.get('worker_peak_rss_bytes',0)),
             wall_including_startup_seconds=time.perf_counter()-start,attempt=2,
             rerun_reason='predeclared overlap with synthetic chart QA; both methods rerun')
    write(out,r);replacement.append(r)
    print('Rerun',cid,method,flush=True)
raw=[json.loads(line) for line in (RUN/'results.jsonl').read_text(encoding='utf-8').splitlines()]
selected={(r['case_id'],r['method']):r for r in raw}
for r in replacement:selected[(r['case_id'],r['method'])]=r
ordered=[selected[(j['case_id'],j['method'])] for j in read(RUN/'jobs.json')]
(RUN/'analyzed-results.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in ordered),encoding='utf-8')
config=read(RUN/'config.json');expected={Path(k).name:v for k,v in config['algorithm_hashes'].items()}
issues=[]
for r in ordered:
    if r['result'].get('status')=='CHECKED' and r['result'].get('algorithm_hashes')!=expected:issues.append([r['case_id'],r['method'],'source hash differs'])
assert len(ordered)==1152 and not issues,issues
write(RUN/'selection-audit.json',{'raw_jobs':len(raw),'rerun_jobs':len(replacement),'final_jobs':len(ordered),'affected_pairs':sorted(affected),
    'source_hashes_match_frozen_config':not issues,'selection':'replace both methods only for predeclared overlap; never choose fastest result',
    'final_jsonl_sha256':digest(RUN/'analyzed-results.jsonl')})
