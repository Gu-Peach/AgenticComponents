"""Explicit exploration of the restricted S04 timed model; no SMT or physics."""
import argparse
from collections import deque, Counter
import hashlib
import json
from pathlib import Path
import time
import platform
from datetime import datetime, timezone
from importlib.metadata import version
from pilot_frontend import load_case, InputError, read, require
from pilot_model import Model, state_json, state_from_json


def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_lock(dataset,case_id,dsl_root):
    path=Path(dataset)/'cases'/case_id/'dependencies.lock.json'
    require(path.is_file(),'DEPENDENCY_LOCK_MISSING',str(path))
    lock=read(path)
    roots={'dataset':Path(dataset),'dsl':Path(dsl_root),'tool':Path(__file__).parent}
    for item in lock['files']:
        root=roots[item['root']].resolve(); target=(root/item['path']).resolve()
        require(target.is_relative_to(root),'INVALID_INPUT','lock path outside root')
        require(target.is_file() and digest(target)==item['sha256'],'DEPENDENCY_CHANGED',item['path'])


def reconstruct(parents,state):
    reverse=[]
    while parents[state] is not None:
        previous,event=parents[state]
        reverse.append({'event':event,'state':state_json(state)})
        state=previous
    return {'initial':state_json(state),'steps':list(reversed(reverse))}


def replay(model,trace):
    state=state_from_json(trace['initial'])
    require(state==model.initial,'TRACE_INVALID','wrong initial state')
    for step in trace['steps']:
        if 'instruction' in step:
            require(step['instruction']==model.code[state.pc],'TRACE_INVALID','instruction/source mismatch')
        target=state_from_json(step['state'])
        require(any(s==target and event==step['event'] for s,event in model.successors(state)),
                'TRACE_INVALID',f'illegal transition at tick {state.tick}')
        state=target
    return {'replayed':True,'steps':len(trace['steps']),'terminal':state.terminal,
            'goal':model.goal(state),'scope':'same full pilot transition relation; not an independent semantics oracle'}


def explore(inputs,profile):
    model=Model(inputs,profile); bound=inputs['queries']['bound_ticks']; budget=inputs['queries']['state_budget']
    queue=deque([model.initial]); parents={model.initial:None}
    witnesses={}; terminals=Counter(); triggers=Counter(); physical_goal=None; target=None; terminal_examples={}
    horizon=False; limited=False; transitions=0; start=time.perf_counter()
    initial_bad=model.violations(model.initial)
    for prop in initial_bad: witnesses[prop]=model.initial
    while queue:
        state=queue.popleft()
        if model.goal(state) and physical_goal is None: physical_goal=state
        if state.terminal:
            terminals[state.terminal]+=1
            terminal_examples.setdefault(state.terminal,state)
            if state.terminal=='succeeded':
                triggers['V09']+=1
                if model.goal(state) and target is None: target=state
            if state.attention: triggers['V08']+=1
            continue
        if state.tick>=bound:
            horizon=True
            continue
        for new,event in model.successors(state):
            transitions+=1
            if new not in parents:
                if len(parents)>=budget:
                    limited=True; queue.clear(); break
                parents[new]=(state,event); queue.append(new)
            for prop in model.violations(new,state,event): witnesses.setdefault(prop,new)
            if event=='response' and model.code[state.pc].get('phase')=='capture': triggers['V01']+=1
            if event=='control_succeeded': triggers['V07']+=1
            if new.grants: triggers['V04']+=1
            triggers['V05']+=1; triggers['V06']+=1
    complete=not horizon and not limited
    results={}
    for prop in inputs['properties']['properties']:
        pid=prop['id']
        if pid=='V10a':
            verdict='GOAL_REACHABLE_IN_PILOT' if target else ('GOAL_UNREACHABLE_ON_CLOSED_PILOT' if complete else 'UNKNOWN')
        else:
            verdict='VIOLATED_IN_PILOT' if pid in witnesses else ('PROVED_ON_CLOSED_PILOT' if complete else ('UNKNOWN' if limited else 'NO_VIOLATION_WITHIN_BOUND'))
        results[pid]={'verdict':verdict,'trigger_states_or_edges':triggers[pid],
                      'vacuous':pid not in ('V10a',) and not triggers[pid]}
    traces={pid:reconstruct(parents,state) for pid,state in witnesses.items()}
    if target: traces['goal']=reconstruct(parents,target)
    for terminal,state in terminal_examples.items(): traces.setdefault('terminal_'+terminal,reconstruct(parents,state))
    for trace in traces.values():
        previous=trace['initial']
        for step in trace['steps']:
            instruction=model.code[previous['pc']]
            step['instruction']=instruction
            step['source']=inputs['source_map'][instruction['node']]
            if instruction['node'] in inputs['resolved']:
                step['capability_model']=inputs['resolved'][instruction['node']]['model']['id']
            previous=step['state']
    replays={key:replay(model,value) for key,value in traces.items()}
    return {'profile':profile['id'],'model_version':'s04-pilot-timed-microsteps/0.1',
            'bound_ticks':bound,'state_budget':budget,'states':len(parents),'transitions':transitions,
            'closed_pilot_exhausted':complete,'horizon_reached':horizon,'resource_limit':limited,
            'terminal_states':dict(terminals),'physical_goal_seen':physical_goal is not None,
            'properties':results,'replay':replays,'elapsed_seconds':time.perf_counter()-start,
            'not_claimed':inputs['properties']['not_claimed'],
            'assumptions':inputs['queries']['specialization']},traces


def run_case(dataset,case_id,dsl_root,*,check_lock=True):
    try:
        if check_lock: verify_lock(dataset,case_id,dsl_root)
        inputs=load_case(dataset,case_id,dsl_root)
        results=[]; traces={}
        for profile in inputs['queries']['profiles']:
            result,items=explore(inputs,profile); results.append(result); traces[profile['id']]=items
        return {'case_id':case_id,'frontend':'VALID','profiles':results},traces
    except InputError as error:
        return {'case_id':case_id,'frontend':error.code,'diagnostic':str(error),'profiles':[]},{}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset',type=Path,default=Path(__file__).resolve().parents[1]/'datasets/ac-path-v1')
    parser.add_argument('--dsl-root',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--case'); parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args(); ids=[args.case] if args.case else [c for c in read(args.dataset/'manifest.json')['cases'] if read(args.dataset/'cases'/c/'case.json').get('profile_scope')=='s04-pilot-timed-microsteps/0.1']
    args.output.mkdir(parents=True,exist_ok=True)
    experiment={'id':'s04-pilot-v1','started_utc':datetime.now(timezone.utc).isoformat(),
                'python':platform.python_version(),'jsonschema':version('jsonschema'),
                'platform':platform.platform(),'model':'s04-pilot-timed-microsteps/0.1',
                'case_ids':ids,'method':'BFS exhaustive over declared finite timed microstep model',
                'independent_oracle_used_by_solver':False,
                'tools':{name:digest(Path(__file__).parent/name) for name in ('pilot_frontend.py','pilot_model.py','pilot_verify.py')}}
    (args.output/'experiment.json').write_text(json.dumps(experiment,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    summary=[]
    for case_id in ids:
        result,traces=run_case(args.dataset,case_id,args.dsl_root)
        out=args.output/case_id; out.mkdir(parents=True,exist_ok=True)
        (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        if result['frontend']=='VALID':
            inputs=load_case(args.dataset,case_id,args.dsl_root)
            for name,data in [('program.ir.json',inputs['ir']),('program.map.json',inputs['source_map']),
                              ('model-instructions.json',Model(inputs,inputs['queries']['profiles'][0]).code)]:
                (out/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        for profile,items in traces.items():
            for key,value in items.items():
                trace_out=out/profile; trace_out.mkdir(exist_ok=True)
                (trace_out/(key+'.trace.json')).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        summary.append({'case_id':case_id,'frontend':result['frontend'],'profiles':[
            {'id':r['profile'],'states':r['states'],'closed':r['closed_pilot_exhausted'],
             'goal':r['properties']['V10a']['verdict'],'goal_soundness':r['properties']['V09']['verdict'],
             'terminals':r['terminal_states']} for r in result['profiles']]})
        print(json.dumps(summary[-1],ensure_ascii=False),flush=True)
    (args.output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


if __name__=='__main__': main()
