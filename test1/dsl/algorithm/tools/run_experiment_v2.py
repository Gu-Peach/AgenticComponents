"""Frozen core accuracy plus separate stress coverage; each job has a terminal record."""
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys
import time
import hashlib

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE/'src'))
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def write(p,v):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def worker(a):
    from acverify.pipeline import verify
    result,_,_=verify(a.workspace/'datasets/ac-path-v1/cases'/a.case/'case.json',a.workspace,
        profile=a.profile,bound=3000,states=10000,seconds=a.seconds,memory_mb=512,reduction=a.method,search='complete')
    write(a.output,result)

def outcome(pid,v):
    if pid=='V09':
        if v=='VIOLATED_IN_MODEL':return 'VIOLATED'
        if v in ('PROVED_ON_FINITE_MODEL','NO_VIOLATION_WITHIN_BOUND'):return 'HOLDS'
    if pid=='V10a':
        if v=='GOAL_REACHABLE_WITHIN_BOUND':return 'REACHABLE'
        if v in ('GOAL_NOT_REACHED_ON_FINITE_MODEL','GOAL_NOT_REACHED_WITHIN_BOUND'):return 'UNREACHABLE'
    return None

def main(a):
    from acverify.pipeline import check
    core=read(a.definition/'core.json');pressure=read(a.definition/'pressure.json');static=read(a.definition/'static.json')
    out=a.output;out.mkdir(parents=True,exist_ok=True)
    static_results=[]
    for cid in static['cases']:
        result=check(a.workspace/'datasets/ac-path-v1/cases'/cid/'case.json',a.workspace)
        actual='VALID' if result['status']=='VALID_INPUT' else result.get('details',{}).get('frontend_code',result['status'])
        static_results.append({'case_id':cid,'expected':static['expected_by_case'][cid],'actual':actual,'match':actual==static['expected_by_case'][cid]})
    write(out/'static-results.json',{'records':static_results,'matches':sum(x['match'] for x in static_results),'total':len(static_results)})
    jobs=[];gold={x['case_id']:x for x in core['cases']}
    for i,cid in enumerate(pressure['cases']):
        for method in (['full','auto'] if i%2==0 else ['auto','full']):
            if method=='full' and cid not in gold:continue
            jobs.append({'case_id':cid,'profile':'nominal','method':method,'seconds':1.0,'role':'core' if cid in gold else 'pressure'})
    # Profiles are recorded by their true names; pilot forced-loss is not generic fault.
    for cid in pressure['cases']:
        desc=read(a.workspace/'datasets/ac-path-v1/cases'/cid/'case.json')
        for p in ('delayed','stop_unknown_c1' if desc['schema_type']=='PilotCase' else 'fault'):
            jobs.append({'case_id':cid,'profile':p,'method':'auto','seconds':0.25,'role':'pressure'})
    code={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (BASE/'src/acverify').glob('*.py')}
    write(out/'config.json',{'semantics_hash':core['semantics_hash'],'bound_ticks':3000,'state_budget':10000,'memory_mb':512,
        'nominal_seconds':1,'stress_seconds':0.25,'worker_watchdog_seconds':15,'workers':1,'repeats':1,'algorithm_hashes':code,
        'meaning':'accuracy only against frozen reference core; remaining/other-environment jobs measure support and coverage',
        'gold_definition_sha256':hashlib.sha256((a.definition/'core.json').read_bytes()).hexdigest()})
    rows=[];started=time.monotonic()
    for i,job in enumerate(jobs,1):
        cid=job['case_id'];path=out/'jobs'/cid/(job['profile']+'-'+job['method']+'.json')
        cmd=[sys.executable,'-B','-X','utf8',str(Path(__file__).resolve()),'--worker','--workspace',str(a.workspace),'--output',str(path),
             '--case',cid,'--profile',job['profile'],'--method',job['method'],'--seconds',str(job['seconds'])]
        begin=time.monotonic()
        try:
            p=subprocess.run(cmd,capture_output=True,timeout=15)
            result=read(path) if p.returncode==0 and path.exists() else {'status':'WORKER_ERROR','message':p.stderr.decode('utf-8',errors='replace')[-1500:]}
        except subprocess.TimeoutExpired:result={'status':'WORKER_TIMEOUT'}
        row={**job,'result':result,'wall_seconds':time.monotonic()-begin};rows.append(row)
        with (out/'jobs.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n')
        if i%40==0 or i==len(jobs):print(json.dumps({'done':i,'total':len(jobs),'elapsed_seconds':round(time.monotonic()-started,1)}),flush=True)
    scores={};contradictions=[]
    for method in ('full','auto'):
        for pid in ('V09','V10a'):
            counts=Counter();matrix=Counter()
            for row in rows:
                if row['role']!='core' or row['method']!=method or row['profile']!='nominal':continue
                expected=next(p['expected'] for p in gold[row['case_id']]['properties'] if p['property']==pid)
                result=row['result'];prop=result.get('properties',{}).get(pid,{})
                predicted=outcome(pid,prop.get('verdict'))
                if result.get('semantics_hash')!=core['semantics_hash']:predicted=None;counts['semantic_mismatch']+=1
                counts['total']+=1;matrix[expected+' -> '+str(predicted)]+=1
                if predicted is None:counts['unresolved']+=1
                elif predicted==expected:counts['correct']+=1
                else:counts['wrong']+=1;contradictions.append({'case_id':row['case_id'],'method':method,'property':pid,'expected':expected,'actual':predicted})
            answered=counts['correct']+counts['wrong']
            scores[method+'-'+pid]={'counts':dict(counts),'matrix':dict(matrix),'coverage':answered/counts['total'],
                'accuracy_on_answered':counts['correct']/answered if answered else None,
                'correct_fraction_of_all_core':counts['correct']/counts['total']}
    write(out/'summary.json',{'static_matches':sum(x['match'] for x in static_results),'static_total':len(static_results),
         'jobs':len(rows),'core_cases':len(gold),'core_query_count':core['query_count'],'scores':scores,'contradictions':contradictions,
         'status_counts':dict(Counter(x['result']['status'] for x in rows)),
         'pressure_limit_counts':dict(Counter(str(x['result'].get('limit',x['result']['status'])) for x in rows if x['role']=='pressure')),
         'algorithm_unchanged':all(hashlib.sha256((BASE/'src/acverify'/n).read_bytes()).hexdigest()==h for n,h in code.items()),
         'publication_gold_review':'pending; this is an independently recertified engineering core'} )

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--definition',type=Path,default=BASE/'experiments/method1-v2');p.add_argument('--output',type=Path,required=True)
    p.add_argument('--worker',action='store_true');p.add_argument('--case');p.add_argument('--profile');p.add_argument('--method');p.add_argument('--seconds',type=float,default=1)
    a=p.parse_args();worker(a) if a.worker else main(a)
