"""A job receives raw-case/query inputs and source pins, never gold labels."""
import json
import sys
import time
import traceback
import os
from pathlib import Path
from .common import setup,read,write,sha,digest,seal


def deny_gold_reads(workspace):
    oracle=(Path(workspace)/'datasets/ac-path-v1/oracle').resolve()
    def audit(event,args):
        if event!='open' or not args or not isinstance(args[0],(str,bytes)):return
        path=Path(os.fsdecode(args[0])).resolve()
        if path.is_relative_to(oracle) or path.name.lower() in ('gold.jsonl','answers.jsonl'):
            raise PermissionError('Experiment worker cannot read reference labels: '+path.name)
    sys.addaudithook(audit)


def execute(workspace,spec_path,output):
    workspace=setup(workspace);deny_gold_reads(workspace);spec=read(spec_path)
    if output.exists():raise ValueError('Worker output exists')
    output.mkdir(parents=True)
    started=time.perf_counter()
    result={'job':spec['job'],'plan_sha256':spec['plan_sha256'],'query_sha256':spec['query_sha256']}
    try:
        for file,expected in spec['implementation_hashes'].items():
            if sha(workspace/'src/acverify_v3'/file)!=expected:raise ValueError('Worker implementation changed')
        if sha(spec['queries_path'])!=spec['query_sha256']:raise ValueError('Worker query input changed')
        queries=read(spec['queries_path'])['records']
        if any('verdict' in q for q in queries):raise ValueError('Worker received labels')
        from acverify_v3.pipeline import verify
        j=spec['job']
        report,traces=verify(workspace/'datasets/ac-path-v1/cases'/j['case_id']/'case.json',workspace,queries,
            profile=j['profile'],seconds=j['seconds'],states=j['state_limit'],memory_mb=j['memory_mb'],optimization=j['method'])
        if report['model_digest']!=spec['expected_model_digest']:raise ValueError('Worker model differs from admitted model')
        if report['implementation_hashes']!=spec['implementation_hashes']:raise ValueError('Worker source fingerprint differs')
        unique={};refs={}
        for qid,payload in traces.items():
            h=digest(payload);relative='witnesses/'+h+'.json.gz'
            if h not in unique:unique[h]=write(output/relative,payload)
            refs[qid]=dict(path=relative,sha256=unique[h],payload_digest=h)
        result.update(status='COMPLETED',report=report,witnesses=refs,distinct_witnesses=len(unique))
    except Exception as e:
        drift=(str(e).startswith(('Worker implementation changed','Worker query input changed','Worker model differs','Worker source fingerprint differs'))
               or getattr(e,'code',None) in ('DEPENDENCY_CHANGED','DEPENDENCY_LOCK_MISSING'))
        result.update(status='INPUT_OR_SOURCE_DRIFT' if drift else 'WORKER_ERROR',error_type=type(e).__name__,message=str(e),traceback=traceback.format_exc()[-6000:])
    result['worker_seconds']=time.perf_counter()-started
    write(output/'result.json',result);seal(output,kind='p54-worker-output/0.1')
    return result['status']
