"""Validate P2 models and export small graphs without issuing dataset truth labels."""
import argparse
import ast
from collections import Counter
import gc
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
from reference.frontend import load
from reference.transition import ReferenceModel
from reference.enumerate import enumerate_model,trace,replay
from reference.fixtures import small
from reference.common import canonical,digest
from reference.monitors import goal


def read(p):return json.loads(Path(p).read_text(encoding='utf8'))
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(p,v):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
def sources():return {p.relative_to(BASE).as_posix():sha(p) for p in (BASE/'reference').rglob('*') if p.suffix in ('.py','.json','.md')}


def greedy(model,bound=3000,retain=False):
    s=model.initial;steps=[];stream=hashlib.sha256();begin=time.perf_counter()
    while s['outcome']=='running' and s['tick']<bound:
        generator=model.successors(s)
        try:nxt,events=next(generator)
        finally:generator.close()
        stream.update(canonical([nxt,events]).encode())
        if retain:steps.append({'state':nxt,'events':events})
        s=nxt
    result={'case_id':model.d.case_id,'model_digest':model.model_digest,'profile':model.d.profile,'bound':bound,
        'selection':'first legal successor; chooses no optional fault and minimum scheduled durations/delays',
        'tick':s['tick'],'outcome':s['outcome'],'goal_at_end':goal(model.d,s),'violations':s['violations'],
        'uncovered_obligations':s['uncovered_properties'],'elapsed_seconds':time.perf_counter()-begin,
        'trace_digest':stream.hexdigest(),'whole_model_conclusion':False,'truth_admitted':False}
    witness={'version':model.version,'model_digest':model.model_digest,'initial':model.initial,'steps':steps}
    return result,witness


def worker(a):
    model=ReferenceModel(load(a.workspace,a.case,a.profile))
    g=enumerate_model(model,bound=256,max_states=30000,seconds=a.seconds,memory_mb=512)
    witnesses={}
    indexes={pid:i for pid,i in g['bad'].items()}
    if g['goals']:indexes['goal']=g['goals'][0]
    for i,state in enumerate(g['states']):
        if state['outcome']!='running':indexes.setdefault('terminal_'+state['outcome'],i)
    for name,index in indexes.items():
        w=trace(model,g,index);path=a.output.parent/'native-traces'/(a.case+'-'+a.profile)/(name+'.json')
        write(path,w);witnesses[name]={'path':path.relative_to(a.output.parent).as_posix(),'sha256':sha(path),'replay':replay(model,w)}
    write(a.output,{'summary':g['summary'],'witnesses':witnesses})


def main(a):
    a.output.mkdir(parents=True,exist_ok=True)
    if (a.output/'summary.json').exists():raise ValueError('Choose a new validation output')
    frozen=sources();write(a.output/'source-freeze.json',{'reference_sources':frozen,'runner_sha256':sha(__file__),
        'P1_manifest_sha256':sha(a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1/manifest.json'),
        'reference_parser_sha256':sha(a.workspace/'tools/build_standard_answers.py')})
    data=a.workspace/'datasets/ac-path-v1';ids=read(data/'manifest.json')['subsets']['D-V']
    inputs=read(data/'oracle/whole-line-v1/case-inputs.json');admission=[];walks=[];errors=[]
    selected={'S04-P01','S04-P01-DV04','S10-P04','S12-P03'}
    for i,cid in enumerate(ids,1):
        try:
            d=load(a.workspace,cid)
            if any(inputs[cid]['input_hashes'].get(k)!=v for k,v in d.input_hashes.items()):raise ValueError('P1 inputs changed')
            model=ReferenceModel(d)
            admission.append({'case_id':cid,'status':'MODEL_CONSTRUCTED','model_digest':model.model_digest,
              'constructs':dict(Counter(n[0] for n in d.nodes.values())),
              'capabilities':sorted({x['model']['id'] for x in d.actions.values()}),'profile':model.d.profile})
            result,witness=greedy(model,retain=cid in selected)
            if cid in selected:
                path=a.output/'greedy-traces'/(cid+'.json');write(path,witness)
                result['trace']={'path':path.relative_to(a.output).as_posix(),'sha256':sha(path),'replay':replay(model,witness)}
            walks.append(result)
        except Exception as e:errors.append({'case_id':cid,'stage':'construction_or_greedy','error':type(e).__name__+': '+str(e)})
        if i%60==0:print(json.dumps({'corpus_walks':i,'total':len(ids)}),flush=True)
    write(a.output/'admission.json',admission);write(a.output/'corpus-greedy.json',walks)
    fixtures=[('single','single',True,[]),('disjoint','disjoint',False,[]),('shared-material','shared_material',False,[]),
              ('capacity','capacity',False,[]),('parallel-failure','parallel_failure',False,[])]
    fixtures += [(f,'single',False,[f]) for f in ('provider_restart','hold_permission_loss','duplicate_same_request','old_request_feedback')]
    fixtures += [('lost-stop','single',False,['missing_stop_confirmation']),('late-stop','single',False,['provider_restart']),('deadline-negative','single',False,[])]
    small_results=[]
    for name,kind,nondet,faults in fixtures:
        d=small(a.workspace,kind,nondeterministic=nondet,faults=faults);d.case_id='diagnostic:'+name
        if name=='lost-stop':
            d.profile['accept']=[2,2]
            for p in d.env['policies'].values():p['accept_ticks']=1
        elif name=='late-stop':
            d.profile['stop']=[4,4]
            for p in d.env['policies'].values():p['stop_ticks']=1
        elif name=='deadline-negative':d.profile['response_window']=2
        model=ReferenceModel(d);g=enumerate_model(model,bound=128,max_states=40000,seconds=20,retain_edges=True)
        path=a.output/'graphs'/(name+'.json')
        write(path,{'schema':'reference-small-graph/0.1','definition':model.d.__dict__,'model_digest':model.model_digest,
                    'summary':g['summary'],'states':g['states'],'edges':g['edges']})
        want=['V10b'] if name=='deadline-negative' else []
        checked=g['summary']['finite_model_closed'] and g['summary']['violations_seen']==want and not g['summary']['uncovered_obligations']
        row={'fixture':name,'summary':g['summary'],'expected_violations':want,'passed':checked,
             'graph':{'path':path.relative_to(a.output).as_posix(),'sha256':sha(path)}}
        ends=sorted(set(g['bad'].values())|set(g['goals'][:1])|({len(g['states'])-1} if g['states'] else set()))
        row['replays']=[replay(model,trace(model,g,end)) for end in ends]
        small_results.append(row);del g;gc.collect()
    write(a.output/'small-models.json',small_results)
    native=[]
    for cid in ('S04-P01','S04-P01-DV01','S04-P01-DV02','S04-P01-DV03','S04-P01-DV04'):
        for profile in ('nominal','delayed','stop_unknown_c1'):
            path=a.output/'native'/(cid+'-'+profile+'.json')
            cmd=[sys.executable,'-B','-X','utf8',str(Path(__file__).resolve()),'--worker','--workspace',str(a.workspace),
                 '--case',cid,'--profile',profile,'--seconds',str(a.seconds),'--output',str(path)]
            try:
                p=subprocess.run(cmd,capture_output=True,timeout=a.seconds+25)
                if p.returncode:raise ValueError(p.stderr.decode('utf8',errors='replace')[-2000:])
                result=read(path);native.append(result)
            except Exception as e:errors.append({'case_id':cid,'profile':profile,'stage':'native_enumeration','error':str(e)})
            print(json.dumps({'native_done':len(native),'case':cid,'profile':profile}),flush=True)
    write(a.output/'native-results.json',native)
    forbidden=[]
    for p in (BASE/'reference').glob('*.py'):
        for node in ast.walk(ast.parse(p.read_text(encoding='utf8'))):
            modules=[x.name for x in node.names] if isinstance(node,ast.Import) else [node.module or ''] if isinstance(node,ast.ImportFrom) else []
            if any(m=='acverify' or m.startswith('acverify.') or m in ('pilot_model','pilot_verify') for m in modules):forbidden.append(p.name)
    summary={'stage':'P2','model_admitted':len(admission),'corpus_cases':len(ids),'greedy_walks':len(walks),
      'greedy_outcomes':dict(Counter(x['outcome'] for x in walks)),
      'greedy_violation_counts':dict(Counter(pid for x in walks for pid in x['violations'])),
      'greedy_unknown_monitor_cases':[x['case_id'] for x in walks if x['uncovered_obligations']],
      'small_models':len(small_results),'small_closed':sum(x['summary']['finite_model_closed'] for x in small_results),
      'small_checks_pass':all(x['passed'] for x in small_results),'small_states':sum(x['summary']['states'] for x in small_results),
      'native_runs':len(native),'native_closed':sum(x['summary']['finite_model_closed'] for x in native),
      'native_limits':dict(Counter(str(x['summary']['limit']) for x in native)),
      'errors':errors,'forbidden_imports':forbidden,'source_unchanged':frozen==sources(),
      'truth_labels_created':0,'whole_line_truth_complete':False,
      'scope':'Model construction and diagnostic coverage; no universal conclusion from greedy walks or incomplete graphs.'}
    write(a.output/'summary.json',summary);print(json.dumps(summary,ensure_ascii=False),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--worker',action='store_true');p.add_argument('--case');p.add_argument('--profile');p.add_argument('--seconds',type=float,default=6)
    a=p.parse_args();worker(a) if a.worker else main(a)
