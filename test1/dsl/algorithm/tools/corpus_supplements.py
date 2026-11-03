"""Construct paired ST candidates, change tasks and indexed pilot evidence.

Compilation is separate from semantic equivalence. No equivalent=true is emitted.
"""
import copy
import json
from pathlib import Path
import re
import shutil
import math
from build_full_dataset import read, write, sha


REQUEST_FB='''(* Generic experimental request protocol; external plant facts are explicit inputs.
   No vendor library and no physical deployment/equivalence claim. *)
FUNCTION_BLOCK AC_Request
VAR_INPUT
  Enable : BOOL; Start : BOOL; Stop : BOOL; Reset : BOOL;
  RunId : DINT; RequestId : DINT;
  Ack : BOOL; AckRun : DINT; AckId : DINT;
  ResultDone : BOOL; ResultRun : DINT; ResultId : DINT;
  ResultFault : BOOL;
  StopAck : BOOL; StopRun : DINT; StopId : DINT; SafeToRelease : BOOL;
  AcceptLimit : TIME; ExecuteLimit : TIME; StopLimit : TIME;
END_VAR
VAR_OUTPUT
  CommandRun : DINT; CommandId : DINT;
  Execute : BOOL; Cancel : BOOL; Busy : BOOL;
  Done : BOOL; Failed : BOOL; NeedsAttention : BOOL;
END_VAR
VAR
  State : DINT; AcceptTimer : TON; ExecuteTimer : TON; StopTimer : TON;
  MatchAck : BOOL; MatchResult : BOOL; MatchStop : BOOL;
END_VAR
IF Reset AND ((State = 0) OR (State = 90)) THEN
  State := 0; Done := FALSE; Failed := FALSE; NeedsAttention := FALSE;
END_IF;
MatchAck := Ack AND (AckRun = CommandRun) AND (AckId = CommandId);
MatchResult := (ResultRun = CommandRun) AND (ResultId = CommandId);
MatchStop := StopAck AND (StopRun = CommandRun) AND (StopId = CommandId);
AcceptTimer(IN := State = 10, PT := AcceptLimit);
ExecuteTimer(IN := State = 20, PT := ExecuteLimit);
StopTimer(IN := State = 30, PT := StopLimit);
CASE State OF
  0:
    Execute := FALSE; Cancel := FALSE; Busy := FALSE;
    IF Enable AND Start AND (RequestId > 0) AND (RunId > 0) THEN
      CommandRun := RunId; CommandId := RequestId;
      Done := FALSE; Failed := FALSE; Busy := TRUE; Execute := TRUE; State := 10;
    END_IF;
  10:
    IF Stop OR NOT Enable OR (ResultFault AND MatchResult) THEN
      Execute := FALSE; Cancel := TRUE; State := 30;
    ELSIF MatchAck THEN
      Execute := FALSE;
      IF ResultDone AND MatchResult THEN Done := TRUE; Busy := FALSE; State := 90;
      ELSE State := 20; END_IF;
    ELSIF AcceptTimer.Q THEN Execute := FALSE; Cancel := TRUE; State := 30;
    END_IF;
  20:
    IF Stop OR NOT Enable OR (ResultFault AND MatchResult) THEN Cancel := TRUE; State := 30;
    ELSIF ResultDone AND MatchResult THEN Done := TRUE; Busy := FALSE; State := 90;
    ELSIF ExecuteTimer.Q THEN Cancel := TRUE; State := 30;
    END_IF;
  30:
    Execute := FALSE; Cancel := TRUE;
    IF MatchStop AND SafeToRelease THEN
      Cancel := FALSE; Busy := FALSE; Failed := TRUE; NeedsAttention := FALSE; State := 90;
    ELSIF StopTimer.Q THEN NeedsAttention := TRUE;
    END_IF;
  90: Execute := FALSE; Busy := FALSE;
END_CASE;
END_FUNCTION_BLOCK
'''


def flatten(ir):
    nodes={n['node_id']:n for n in ir['nodes']}; result=[]
    def visit(key,path='',enclosing=None):
        n=nodes[key]; kind=n['kind']; origin=path+key
        if kind=='seq':
            for child in n['children']:visit(child,path,enclosing)
        elif kind=='repeat':
            for i in range(n['count']):visit(n['child'],path+key+f'[{i}]/',enclosing)
        elif kind=='with-control':
            result.append({'kind':'control_enter','node':origin,'control':n['control_ref'],'scope_instance':origin})
            visit(n['child'],path,(n['control_ref'],origin))
            result.append({'kind':'control_exit','node':origin,'control':n['control_ref'],'scope_instance':origin})
        elif kind=='invoke':result.append({'kind':'invoke','node':origin,'target':n['target_ref'],'behavior':n['behavior_id'],'arguments':n['arguments'],
            'enclosing_control':enclosing[0] if enclosing else None,'scope_instance':enclosing[1] if enclosing else 'none'})
        elif kind=='await':result.append({'kind':'await','node':origin,'condition':n['condition'],'timeout':n['timeout']})
        else:raise ValueError('ST common subset excludes '+kind)
    visit(ir['entry']); return result


def st_pair(root,cid,pair_id,parser):
    folder=root/'cases'/cid; case=read(folder/'case.json')
    env=read((folder/case['inputs']['environment']).resolve())
    ir,_=parser.lower((folder/'process.acp').read_text(encoding='utf-8'))
    steps=flatten(ir); symbols={};next_symbol=1
    def symbol(value):
        nonlocal next_symbol
        if value not in symbols:symbols[value]=next_symbol;next_symbol+=1
        return symbols[value]
    def resolve(expr):
        if expr['kind']=='binding':return env['bindings'][expr['binding_ref']]['id']
        if expr['kind']=='index':return env['bindings'][expr['binding_ref']]['id']
        return expr['value']
    conditions=[];readiness=[];lines=[]; action_codes={};mappings=[]
    policy=next(iter(env['policies'].values()))
    budget_ms={k:math.ceil(v*1000/60) for k,v in policy.items()}
    for i,step in enumerate(steps):
        if step['kind']=='await':
            name=f'Condition_{i}';conditions.append(name)
            lines += [f'  {i}:',f'    IF {name} THEN StepNo := {i+1}; Phase := 0;',
                      '    ELSIF WaitTimer.Q THEN AbortRequested := TRUE; END_IF;']
            mappings.append(dict(step,step=i,condition_port=name,provider_status='must bind to the same typed facts as DSL'))
        else:
            ready=f'Ready_{i}';readiness.append(ready)
            if step['kind']=='invoke':
                dev=env['bindings'][step['target']]['id'];behavior=step['behavior'];args={k:resolve(v) for k,v in step['arguments'].items()}
                scope=step['scope_instance']
            else:
                control=env['controls'][step['control']];dev=control.split('.')[0];scope=step['scope_instance']
                behavior=step['kind'];args={}
            if behavior not in action_codes:action_codes[behavior]=len(action_codes)+1
            assignments=[f'CommandDevice := {symbol(dev)}',f'CommandAction := {action_codes[behavior]}',
                         f'CommandSubject := {symbol(args.get("material",args.get("subject_id","none")))}',
                         f'CommandSource := {symbol(args.get("source","none"))}',f'CommandTarget := {symbol(args.get("target","none"))}',
                         f'CommandScope := {symbol(scope)}',f'CommandIndex := {args.get("target_index",args.get("target_level",0))}']
            lines += [f'  {i}:','    '+'; '.join(assignments)+';',
                      '    CASE Phase OF','      0: ResetRequest := TRUE; Phase := 1;',
                      f'      1: IF {ready} THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;',
                      '    END_CASE;']
            mappings.append(dict(step,step=i,device=dev,behavior=behavior,resolved_arguments=args,scope=scope,gate_port=ready))
    # Each wait has a generated timeout; one timer is reset between wait steps.
    wait_conditions=' OR '.join(f'(StepNo = {i})' for i,s in enumerate(steps) if s['kind']=='await') or 'FALSE'
    limits=[]
    for i,s in enumerate(steps):
        if s['kind']=='await':limits.append(f'  {i}: WaitLimit := T#{s["timeout"]["value"]}{s["timeout"]["unit"]};')
    source='''PROGRAM Main
VAR
  Enable : BOOL; Stop : BOOL; RunId : DINT := 1;
  StepNo : DINT; Phase : DINT;
  PreviousStep : DINT := -1; WaitArmed : BOOL;
  StartRequest : BOOL; ResetRequest : BOOL; AbortRequested : BOOL;
  Ack : BOOL; AckRun : DINT; AckId : DINT;
  ResultDone : BOOL; ResultFault : BOOL; ResultRun : DINT; ResultId : DINT;
  StopAck : BOOL; StopRun : DINT; StopId : DINT; SafeToRelease : BOOL;
  AllScopesStopped : BOOL; IndependentGoal : BOOL;
  Completed : BOOL; Failed : BOOL; AbortAllScopes : BOOL; NeedsAttention : BOOL;
  CommandDevice : DINT; CommandAction : DINT; CommandSubject : DINT;
  CommandSource : DINT; CommandTarget : DINT; CommandScope : DINT; CommandIndex : DINT;
  WaitLimit : TIME := T#30s; WaitTimer : TON; GateTimer : TON; Req : AC_Request;
'''
    source+=''.join(f'  {c} : BOOL;\n' for c in conditions+readiness)+'END_VAR\n'
    source+='StartRequest := FALSE; ResetRequest := FALSE;\n'
    source+='IF (Stop OR (NOT Enable AND ((StepNo > 0) OR Req.Busy))) AND NOT Completed THEN AbortRequested := TRUE; END_IF;\n'
    source+='CASE StepNo OF\n'+'\n'.join(limits)+'\nEND_CASE;\n' if limits else ''
    source+='WaitArmed := StepNo = PreviousStep; PreviousStep := StepNo;\n'
    source+=f'GateTimer(IN := Enable AND NOT AbortRequested AND (Phase = 1), PT := T#{budget_ms["gate_ticks"]}ms);\n'
    source+=f'WaitTimer(IN := Enable AND NOT AbortRequested AND WaitArmed AND ({wait_conditions}), PT := WaitLimit);\n'
    source+='IF Enable AND NOT AbortRequested THEN\nCASE StepNo OF\n'+'\n'.join(lines)+f'\n  {len(steps)}: Completed := TRUE;\nEND_CASE;\nEND_IF;\n'
    source+='''Req(Enable := Enable, Start := StartRequest, Stop := AbortRequested, Reset := ResetRequest,
    RunId := RunId, RequestId := StepNo + 1,
    Ack := Ack, AckRun := AckRun, AckId := AckId,
    ResultDone := ResultDone, ResultRun := ResultRun, ResultId := ResultId, ResultFault := ResultFault,
    StopAck := StopAck, StopRun := StopRun, StopId := StopId, SafeToRelease := SafeToRelease,
    AcceptLimit := __ACCEPT_LIMIT__, ExecuteLimit := __EXECUTE_LIMIT__, StopLimit := __STOP_LIMIT__);
IF (Phase = 2) AND Req.Done AND NOT AbortRequested THEN StepNo := StepNo + 1; Phase := 0; END_IF;
IF Req.Failed OR Req.NeedsAttention THEN AbortRequested := TRUE; END_IF;
AbortAllScopes := AbortRequested;
NeedsAttention := Req.NeedsAttention OR (AbortRequested AND NOT AllScopesStopped);
IF AbortRequested AND AllScopesStopped AND NOT Req.Busy THEN Failed := TRUE; Completed := FALSE; END_IF;
(* IndependentGoal is monitored separately; it is not used to repair candidate logic. *)
END_PROGRAM
'''
    for marker,key in [('__ACCEPT_LIMIT__','accept_ticks'),('__EXECUTE_LIMIT__','execute_ticks'),('__STOP_LIMIT__','stop_ticks')]:
        source=source.replace(marker,f'T#{budget_ms[key]}ms')
    dest=root/'equivalents'/pair_id
    write(dest/'program.st',source);write(dest/'function-blocks.st',REQUEST_FB)
    write(dest/'pair.json',{'pair_id':pair_id,'case_id':cid,'status':'constructed_common_subset_candidate',
        'equivalence_proven':False,'plc_compile_status':'pending_check','plc_verifier_status':'not_run',
        'inputs':{'program':'program.st','function_blocks':'function-blocks.st','mapping':'model-mapping.json'},
        'task_ref':str(Path('../../cases')/cid/'case.json'),
        'limitations':['external plant/provider bindings required','stop/scope cleanup is an explicit environment service',
                       'scan timing and DSL microsteps not yet proved equivalent','no physics or vendor-specific instructions']})
    write(dest/'model-mapping.json',{'case_id':cid,'steps':mappings,'symbol_table':symbols,'action_codes':action_codes,
       'initial_program_state':{'Enable':False,'StepNo':0,'Phase':0},
       'environment_obligation':'Set Enable and all plant/provider inputs according to the same case model; inputs do not default to success.',
       'scope_protocol':'control_enter done requires writer+enter acknowledgement; control_exit done requires exit acknowledgement+actual stop; failures request AbortAllScopes and retain isolation until AllScopesStopped.',
       'request_identity':['RunId','StepNo+1'],'task_goal':'IndependentGoal must be derived from the unchanged TaskSpec',
       'scope_identity':'scope_instance is the expanded control node activation; enter, child transport and exit share it. Configuration IDs are not used as concurrent owners.',
       'timeout_mapping':{'source_ticks':policy,'st_rounded_up_milliseconds':budget_ms,'equivalence_requires_accounting_for_rounding':True},
       'readiness':'Ready_i must reflect the operation preconditions and availability; acceptance rechecks/reserves atomically in the external plant model.',
       'evidence_freshness':'plant adapter must enforce subject, epoch, age and phase validity; not implemented by ST booleans alone'})
    write(dest/'equivalence-review.md',f'''# {pair_id} / {cid}

已构造 DSL 对应的顺序/有限重复/驱动作用域/等待 ST 候选和通用请求功能块。映射列出每步设备、能力、实参、条件与身份。

待审核：统一时钟、阶段、环境、实际停稳、事务、条件提供者和资源清理。PLC 编译通过只证明语法/类型可接受，不证明行为等价。当前不纳入“等价已成立”的对比统计。
''')


def build_supplements(root,algorithm_root,dsl_root):
    import sys
    sys.path.insert(0,str(algorithm_root/'tools'))
    from pilot_frontend import parser_at
    parser=parser_at(dsl_root)
    selected=['S04-P01','S04-P02','S04-P04','S01-P01','S01-P04','S02-P01','S02-P02','S03-P01','S05-P01','S08-P01','S09-P01','S10-P01']
    for i,cid in enumerate(selected,1):st_pair(root,cid,f'E{i:02}',parser)
    changes=[]
    for scene in range(1,13):
        parent=f'S{scene:02}-P01';desc=read(root/'cases'/parent/'case.json');base=root/'cases'/parent
        env=read((base/desc['inputs']['environment']).resolve());task=read((base/desc['inputs']['task']).resolve())
        query=read((base/desc['inputs']['queries']).resolve());program=(base/'process.acp').read_text(encoding='utf-8')
        for change in range(1,4):
            rid=f'R{scene:02}-{change}';dest=root/'changes'/rid
            modified={}; impacted=[]
            if change==1:
                old=next(k for k,v in env['bindings'].items() if v['type']=='device');new=old+'_renamed'
                nextenv=copy.deepcopy(env);nextenv['bindings'][new]=nextenv['bindings'].pop(old)
                if old in nextenv.get('observations',{}):nextenv['observations'][new]=nextenv['observations'].pop(old)
                modified={'environment.json':nextenv,'process.acp':re.sub(r'\b'+re.escape(old)+r'\b',new,program)}
                category='compatible_alias_rename';impacted=['binding/source map/dependency lock; intended semantic equivalence must be checked']
            elif change==2:
                nextenv=copy.deepcopy(env)
                for policy in nextenv['policies'].values():policy['execute_ticks']*=2
                nextquery=copy.deepcopy(query)
                if 'bounds_ticks' in nextquery:nextquery['bounds_ticks']=[v*2 for v in nextquery['bounds_ticks']]
                else:nextquery['bound_ticks']*=2
                modified={'environment.json':nextenv,'query-plan.json':nextquery};category='execution_budget_change'
                impacted=['timeout branches','bounded response','query coverage','possible additional accepted paths']
            else:
                nexttask=copy.deepcopy(task);locations=read(root/f'scenes/S{scene:02}/instances.json')['locations']
                if 'op' in nexttask['goal']:
                    terms=nexttask['goal']['args']; at=next(g for g in terms if g['op']=='at')
                    old=at['location'];new=next(l for l in locations if l['id']!=old and not l['id'].endswith('.tool'))
                    for goal in terms:
                        if goal.get('material')==at['material']:
                            if goal['op'] in ('at','supported'):goal['location']=new['id']
                            elif goal['op']=='holder':goal['device']=new['owner']
                else:
                    old=nexttask['goal']['region'];new=next(l for l in locations if l['id']!=old and not l['id'].endswith('.tool'))
                    nexttask['goal'].update(region=new['id'],support=new['id'],holder=new['owner'])
                modified={'task-spec.json':nexttask};category='independent_goal_change'
                impacted=['V09','V10a','candidate may require redesign; no automatic repair']
            write(dest/'change.json',{'change_id':rid,'parent_id':parent,'category':category,'status':'constructed_not_executed',
                'overrides':{n:'after/'+n for n in modified},'inheritance':'other files resolved from before.case_ref; replacement input paths resolved from this folder'})
            write(dest/'before.json',{'case_ref':f'../../cases/{parent}/case.json','case_sha256':sha(base/'case.json')})
            for name,value in modified.items():write(dest/'after'/name,value)
            write(dest/'expected-impact.json',{'affected':impacted,'truth_status':'prediction_pending_regression','measure':['changed_files','changed_fields','review_time','affected_properties','reverification_time']})
            changes.append(rid)
    diagnostic=[]
    candidates=[('S04-P01-DV04','nominal','V09','violation'),('S04-P01-DV04','delayed','V09','violation'),
                ('S04-P01-DV01','nominal','terminal_failed','gate_failure'),('S04-P01-DV02','nominal','terminal_failed','evidence_timeout'),
                ('S04-P01-DV03','nominal','goal','protected_negative'),('S04-P01','stop_unknown_c1','terminal_attention_required','legal_isolation'),
                ('S04-P01','nominal','goal','positive_control')]
    for i,(cid,profile,trace,label) in enumerate(candidates,1):
        src=algorithm_root/'artifacts/s04-pilot-v1'/cid/profile/(trace+'.trace.json')
        if not src.is_file():raise FileNotFoundError(src)
        dest=root/'oracle/pilot-evidence'/f'X{i:02}.trace.json';dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dest)
        diagnostic.append({'id':f'X{i:02}','case_id':cid,'profile':profile,'trace_ref':dest.relative_to(root).as_posix(),
            'trace_sha256':sha(dest),'reference_label':label,'independent_truth_status':'pending','scope':'restricted S04 pilot model',
            'defect_group':'S04-P01-DV04' if cid.endswith('DV04') else cid})
    write(root/'subsets/D-X.json',{'records':diagnostic,'independent_defect_count_is_not_trace_count':True})
    write(root/'subsets/D-E.json',{'pair_ids':[f'E{i:02}' for i in range(1,13)],'equivalence_proven_count':0})
    write(root/'subsets/D-R.json',{'change_ids':changes,'executed_count':0})
    manifest=read(root/'manifest.json');manifest['subsets'].update({'D-X':[d['id'] for d in diagnostic],
          'D-E':[f'E{i:02}' for i in range(1,13)],'D-R':changes});write(root/'manifest.json',manifest)
    for name in ('D-S','D-V'):write(root/f'subsets/{name}.json',{'case_ids':manifest['subsets'][name],'path_truth':'see per-case oracle status'})
