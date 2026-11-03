"""Independent, conservative answer construction. No acverify/tool-result imports.

Complete query coverage is distinct from complete truth coverage. Unsupported
parallel/timing proof obligations remain unresolved, never guessed from suffixes.
"""
import argparse
import copy
import hashlib
import itertools
import json
from pathlib import Path
import re

def read(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

class RefError(ValueError):
    def __init__(self,code,message):self.code=code;super().__init__(message)

def require(value,code,message):
    if not value:raise RefError(code,message)

def parse(text):
    """Separate recursive-descent S-expression reader, not the tested front end."""
    tokens=[];i=0;text=text.lstrip('\ufeff')
    while i<len(text):
        c=text[i]
        if c.isspace():i+=1;continue
        if c==';':
            end=text.find('\n',i);i=len(text) if end<0 else end+1;continue
        if c in '()':tokens.append(c);i+=1;continue
        if c=='"':
            try:value,length=json.JSONDecoder().raw_decode(text[i:])
            except ValueError as error:raise RefError('INVALID_SYNTAX','Invalid quoted string') from error
            tokens.append(('string',value));i+=length;continue
        j=i
        while j<len(text) and not text[j].isspace() and text[j] not in '();':j+=1
        require(j>i,'INVALID_SYNTAX','Empty token');tokens.append(text[i:j]);i=j
    cursor=0
    def form():
        nonlocal cursor
        require(cursor<len(tokens),'INVALID_SYNTAX','Unexpected end of input')
        token=tokens[cursor];cursor+=1
        if token=='(':
            values=[]
            while cursor<len(tokens) and tokens[cursor]!=')':values.append(form())
            require(cursor<len(tokens),'INVALID_SYNTAX','Missing closing parenthesis');cursor+=1
            return values
        require(token!=')','INVALID_SYNTAX','Unexpected closing parenthesis');return token
    result=form();require(cursor==len(tokens),'INVALID_SYNTAX','Trailing input');return result

def head(x,name=None):
    require(isinstance(x,list) and x,'INVALID_SYNTAX','Expected nonempty form')
    if name:require(x[0]==name,'INVALID_SYNTAX','Expected '+name)
    return x

def expr_children(node):
    k=node[0]
    if k in ('seq','par'):return node[2:]
    if k=='with-control':return [node[4]]
    if k=='repeat':return [node[3]]
    if k=='branch':return [c[-1] for c in node[4:]]
    return []

class Case:
    def __init__(self,root,cid):
        self.root=Path(root);self.folder=self.root/'cases'/cid;self.id=cid
        self.descriptor=read(self.folder/'case.json')
        self.paths={k:(self.folder/v).resolve() for k,v in self.descriptor['inputs'].items()}
        require(all(p.is_relative_to(self.root.resolve()) for p in self.paths.values()),'INVALID_BINDING','Escaping input')
        self.env=read(self.paths['environment']);self.initial=read(self.paths['initial']);self.task=read(self.paths['task'])
        self.properties=read(self.paths['properties']);self.queries=read(self.paths['queries'])
        self.ast=head(parse(self.paths['process'].read_text(encoding='utf-8-sig')),'process')
        require(len(self.ast)==7,'INVALID_SYNTAX','Invalid process form')
        self.conditions={x[1]:x[2] for x in head(self.ast[5],'conditions')[1:]}
        self.body=head(self.ast[6],'body')[1];self.nodes={};self.actions={};self.used_models={}
        sid=self.descriptor['scene_id'];self.instances=read(self.root/f'scenes/{sid}/instances.json')
        self.relations=read(self.root/f'scenes/{sid}/relations.json')
        self.devices={d['id']:copy.deepcopy(d) for d in self.instances['devices']+self.env.get('auxiliary_devices',[])}
        self.locations={l['id']:copy.deepcopy(l) for l in self.instances['locations']+self.env.get('auxiliary_locations',[])}
        for dev,values in self.env.get('scene_parameter_overrides',{}).items():
            self.devices[dev]['parameters'].update(values)
            for l in self.locations.values():
                if l['owner']==dev and not l.get('slot'):l['capacity']=self.devices[dev]['parameters']['capacity']
        self.controls={c['id']:c for c in self.relations['control_scopes']}
        self.models={m['id']:m for m in (read(p) for p in (self.root/'shared/verification-contracts').glob('*.json'))}
        self.bind(self.body,None)
        self.check_request_scope(self.body,set())
        self.hashes={k:sha(p) for k,p in self.paths.items()}
        self.hashes.update({p.relative_to(self.root).as_posix():sha(p) for p in (self.root/'shared').rglob('*.json')})
        self.hashes.update({p.relative_to(self.root).as_posix():sha(p) for p in (self.root/f'scenes/{sid}').glob('*.json')})

    def value(self,value):
        if isinstance(value,list):
            require(value[0]=='binding' and len(value)==2,'UNSUPPORTED_REFERENCE','Only nominal binding is implemented')
            require(value[1] in self.env['bindings'],'INVALID_BINDING','Missing binding')
            b=self.env['bindings'][value[1]];return b['type'],b['id']
        require(isinstance(value,str) and re.fullmatch(r'-?(0|[1-9][0-9]*)',value),'INVALID_TYPE','Expected integer')
        return 'integer',int(value)

    def bind(self,n,scope):
        head(n);kind=n[0];identity=n[1]
        require(identity not in self.nodes,'INVALID_SYNTAX','Duplicate node ID');self.nodes[identity]=n
        require(kind in ('seq','par','branch','repeat','invoke','await','with-control','delay','fail'),'INVALID_SYNTAX','Unknown node kind')
        lengths={'invoke':6,'await':4,'with-control':5,'repeat':4,'delay':4,'fail':3}
        if kind in lengths:require(len(n)==lengths[kind],'INVALID_SYNTAX','Node arity')
        if kind in ('seq','par'):require(len(n)>=(3 if kind=='seq' else 4),'INVALID_SYNTAX','Empty/undersized composition')
        if kind=='repeat':require(isinstance(n[2],str) and n[2].isdigit() and 0<=int(n[2])<=10000,'INVALID_TYPE','Repeat bound')
        if kind in ('invoke','with-control'):
            policy=n[-1] if kind=='invoke' else n[3]
            require(head(policy,'policy')[1] in self.env['policies'],'INVALID_BINDING','Unknown policy')
        if kind=='invoke':
            require(len(n)==6,'INVALID_SYNTAX','Invalid invoke shape')
            b=self.env['bindings'].get(n[2]);require(b and b['type']=='device','INVALID_BINDING','Invocation target')
            dev=b['id'];contract=read(self.root/'shared/device-contracts'/f'{self.devices[dev]["device_type"]}.json')
            require(n[3] in contract['capabilities'],'UNKNOWN_CAPABILITY','Missing capability '+n[3])
            model=self.models[contract['capabilities'][n[3]]['verification_ref']];args={}
            for pair in head(n[4],'args')[1:]:
                require(len(pair)==2 and pair[0] not in args,'INVALID_TYPE','Malformed/duplicate argument')
                typ,val=self.value(pair[1]);require(typ==model['parameters'].get(pair[0]),'INVALID_TYPE','Nominal/literal type mismatch: '+pair[0]);args[pair[0]]=val
            require(set(args)==set(model['parameters']),'INVALID_TYPE','Missing arguments')
            if model['id']=='transfer@0.1':
                require(any(e['device']==dev and e['source']==args['source'] and e['target']==args['target'] for e in self.relations['transfer_edges']),
                        'INVALID_BINDING','Undeclared transfer')
            if any(x.startswith('delegate:') for x in model['resource_claims']):
                require(scope is not None and self.controls[scope]['owner']==dev,'INVALID_BINDING','Drive delegation owner')
                provider=self.models[self.controls[scope]['contract_ref']]['delegation']
                require(n[3] in provider.get('allowed_behaviors',[provider.get('allowed_behavior')]),'INVALID_BINDING','Undeclared delegation')
            self.actions[identity]={'device':dev,'behavior':n[3],'model':model,'args':args,'scope':scope};self.used_models[model['id']]=model
        if kind=='with-control':
            require(n[2] in self.env['controls'],'INVALID_BINDING','Unknown control');scope=self.env['controls'][n[2]]
        for child in expr_children(n):self.bind(child,scope)

    def check_request_scope(self,n,available):
        def reads(p,seen=()):
            head(p)
            if p[0]=='condition':
                require(p[1] in self.conditions and p[1] not in seen,'INVALID_BINDING','Undefined/cyclic condition')
                return reads(self.conditions[p[1]],seen+(p[1],))
            if p[0] in ('all','any','not'):
                return set().union(*(reads(x,seen) for x in p[1:]))
            require(p[0]=='is','INVALID_SYNTAX','Condition operator')
            r=head(p[1]);require(r[1] in self.env['bindings'],'INVALID_BINDING','Condition owner')
            if r[1]=='world':require(r[2][1] in self.env['observation_definitions'],'INVALID_BINDING','World observation key')
            else:require(r[2][1] in self.env.get('observations',{}).get(r[1],[]),'INVALID_BINDING','Observation key')
            return {x[1] for x in r[3:] if x[0]=='request'}
        if n[0]=='await':require(reads(n[2])<=available,'INVALID_BINDING','Request not dominated')
        if n[0]=='branch':
            for c in n[4:-1]:require(reads(c[1])<=available,'INVALID_BINDING','Branch request not dominated')
        if n[0]=='seq':
            value=set(available)
            for c in n[2:]:value=self.check_request_scope(c,value)
            return value
        if n[0]=='par':return set().union(available,*(self.check_request_scope(c,set(available)) for c in n[2:]))
        if n[0]=='branch':return set.intersection(*(self.check_request_scope(c[-1],set(available)) for c in n[4:]))
        if n[0]=='repeat':self.check_request_scope(n[3],set(available));return set(available)
        if n[0]=='with-control':return self.check_request_scope(n[4],set(available))
        return available|{n[1]} if n[0]=='invoke' else available

    def goal_expr(self):
        g=self.task['goal']
        if 'op' in g:return g
        m=g['material'];return {'op':'all','args':[
            {'op':'at','material':m,'location':g['region']},{'op':'holder','material':m,'device':g['holder']},
            {'op':'supported','material':m,'location':g['support']},{'op':'tools_empty'},
            *[{'op':'drive_stopped','device':d} for d in g['drives']],{'op':'no_active_requests'},{'op':'no_grants'}]}

    def condition_expr(self,p):
        if p[0]=='condition':return self.condition_expr(self.conditions[p[1]])
        if p[0] in ('all','any'):return {'op':p[0],'args':[self.condition_expr(x) for x in p[1:]]}
        if p[0]=='not':return {'op':'not','arg':self.condition_expr(p[1])}
        require(p[0]=='is' and p[-1] in ('true','false'),'UNSUPPORTED_REFERENCE','Unsupported observation comparison')
        r=p[1];alias=r[1];key=r[2][1];qual={x[0]:x[1] for x in r[3:]};bind=self.env['bindings']
        if alias=='world':result=self.env['observation_definitions'][key]
        else:
            dev=bind[alias]['id'];m=bind[qual.get('subject','material')]['id'] if 'material' in bind or 'subject' in qual else None
            if key=='surface_stopped':result={'op':'drive_stopped','device':dev}
            elif key=='both_tools_empty':result={'op':'tools_empty'}
            else:
                action=self.actions.get(qual.get('request'))
                require(action is not None,'UNSUPPORTED_REFERENCE','Missing associated request')
                target=action['args'].get('target',action['device']+'.exit')
                if key=='subject_at_exit':
                    result={'op':'false'} if action['device']!=dev else {'op':'at','material':m,'location':dev+'.exit'}
                elif key=='holder_matches_target':result={'op':'holder','material':m,'device':self.locations[target]['owner']}
                elif key=='supported_at_target':result={'op':'all','args':[{'op':'at','material':m,'location':target},{'op':'supported','material':m,'location':target}]}
                else:raise RefError('UNSUPPORTED_REFERENCE','Unknown observation '+key)
        return result if p[-1]=='true' else {'op':'not','arg':result}

def conjunction(e):
    if e['op']=='all':return [v for x in e['args'] for v in conjunction(x)]
    return [e]

def expr_key(e):return json.dumps(e,sort_keys=True,ensure_ascii=False)

def terminal_await(case):
    n=case.body
    while n[0]=='seq':n=n[-1]
    return case.condition_expr(n[2]) if n[0]=='await' else None

def stable_after_final(case):
    # Root seq completes all prior siblings; no pending requests/scopes can
    # mutate the world. External material replacement must not touch the goal.
    relevant={a['material'] for a in conjunction(case.goal_expr()) if 'material' in a}
    external_keys={a['key'] for a in conjunction(case.goal_expr()) if a['op']=='external'}
    return all(e['kind']=='set_external' and e['fact'] not in external_keys or e['kind']=='replace_carrier' and not relevant.intersection(e['materials']) for e in case.env.get('events',[]))

def logical_proofs(case):
    proofs={};end=terminal_await(case)
    goal=conjunction(case.goal_expr());implicit=[{'op':'no_active_requests'},{'op':'no_grants'}]
    if end and stable_after_final(case):
        available={expr_key(x) for x in conjunction(end)+implicit}
        if all(expr_key(x) in available for x in goal):
            proofs['V09']={'verdict':'HOLDS','rule':'terminal_guard_entails_goal_with_stability',
                 'guard':end,'goal':case.goal_expr(),'implicit_success_obligations':implicit,
                 'scope':'all successful executions under the frozen DSL/service semantics; not a runtime implementation proof'}
    if end:
        parts=conjunction(end);places={};contradiction=any(x['op']=='false' for x in parts)
        for p in parts:
            if p['op']=='at':
                if p['material'] in places and places[p['material']]!=p['location']:contradiction=True
                places[p['material']]=p['location']
        if contradiction:
            proofs['V10a']={'verdict':'UNREACHABLE','root_success_unreachable':True,'rule':'mandatory_final_guard_is_contradictory','guard':end,
                            'axiom':'a material has one current symbolic region; mismatched request-scoped evidence cannot evaluate true'}
    first=case.body
    while first[0]=='seq':first=first[2]
    if first[0]=='await':
        cond=case.condition_expr(first[2]);init=case.initial
        mats={m['id']:m for m in init['materials']}
        if 'material' in init:mats[init['material']]={**mats[init['material']],**{k:init[k] for k in ('region','holder','support')}}
        mutable={m for event in case.env.get('events',[]) for m in event.get('materials',[])}
        for atom in conjunction(cond):
            frozen_false=False
            if atom['op']=='at':frozen_false=atom['material'] not in mutable and mats[atom['material']]['region']!=atom['location']
            if atom['op'] in ('operation_count','cycle_count') and atom['count']>0:
                # No invoked action before this guard; environmental events do
                # not manufacture operation/cycle history in the supplied model.
                ds=init.get('device_states',{}).get(atom['device'],{})
                frozen_false=not ds.get('operation_history',[]) and not ds.get('cycle_counts',{})
            if frozen_false:
                proofs['V10a']={'verdict':'UNREACHABLE','root_success_unreachable':True,'rule':'initial_gate_false_with_no_enabled_producer','blocking_atom':atom,
                               'environment_writes':case.env.get('events',[]),'node':first[1]}
                proofs['V10b']={'verdict':'HOLDS','vacuous':True,'rule':'no_accepted_request_before_immutable_initial_gate','node':first[1]}
                break
    # Successful-prefix reasoning. Failed earlier invocations cannot cause root
    # success; successful transfer postconditions fix the material's region.
    def prefix(n):
        if n[0]=='seq':
            for child in n[2:]:yield from prefix(child)
        else:yield n
    mats={m['id']:m for m in case.initial['materials']}
    if 'material' in case.initial:mats[case.initial['material']]={**mats[case.initial['material']],'region':case.initial['region']}
    positions={m:v['region'] for m,v in mats.items()};moved_by_env={m for e in case.env.get('events',[]) for m in e.get('materials',[])}
    stopped=all(d.get('drive')=='stopped' for d in case.initial.get('device_states',{}).values())
    for node in prefix(case.body):
        if node[0]!='invoke':break
        action=case.actions[node[1]]
        if action['model']['id']!='transfer@0.1':break
        args=action['args'];m=args['material']
        if stopped and m not in moved_by_env and positions.get(m)!=args['source']:
            proofs['V10a']={'verdict':'UNREACHABLE','root_success_unreachable':True,'rule':'successful_prefix_contradicts_next_source',
                            'node':node[1],'material':m,'known_region':positions[m],'required_region':args['source']}
            break
        positions[m]=args['target']
    if proofs.get('V10a',{}).get('root_success_unreachable'):
        proofs.setdefault('V09',{'verdict':'HOLDS','rule':'root_success_unreachable'})
        proofs['V09']['vacuous']=True
    return proofs


def queries(case):
    q=case.queries
    if 'profiles' in q:
        envs=[p['id'] for p in q['profiles']];bounds=[q['bound_ticks']]
    else:envs=q['environments'];bounds=q['bounds_ticks']
    for env,bound,p in itertools.product(envs,bounds,case.properties['properties']):yield env,bound,p
    # The completed full/auto experiment used a separate, explicitly reported K.
    for env in envs:
        if env.split('@')[0]=='nominal' and 3000 not in bounds:
            for p in case.properties['properties']:yield env,3000,p


def build(root,out):
    root=Path(root).resolve();out=Path(out).resolve();require(not out.exists(),'OUTPUT_EXISTS','Choose a new output directory')
    from sequential_reference import SequentialReference,profile_for,certify,RefError as TraceError
    manifest=read(root/'manifest.json');records=[];static=[];certificates=[];candidate_count=0
    for cid in manifest['cases']:
        try:
            case=Case(root,cid);static.append({'case_id':cid,'verdict':'WELL_FORMED_FOR_REFERENCE_SUBSET','accuracy_eligible':True,
                'scope':'syntax, nominal binding, declared edges/delegation and request dominance; not dynamic feasibility',
                'independence':'separate parser/binder; no tested-verifier imports','source_sha256':sha(case.paths['process'])})
        except RefError as error:
            code=error.code;accepted=code in ('INVALID_SYNTAX','INVALID_TYPE','UNKNOWN_CAPABILITY','INVALID_BINDING')
            item={'case_id':cid,'verdict':code,'message':str(error),'accuracy_eligible':accepted,
                  'basis':'independent grammar/nominal-binding rule','source_sha256':sha(root/'cases'/cid/'process.acp')}
            static.append(item);write(out/'cases'/cid/'answers.json',{'static':item,'queries':[],'path_status':'INVALID_INPUT' if accepted else 'REFERENCE_UNSUPPORTED'});continue
        proofs=logical_proofs(case);answers=[];candidate_by_profile={}
        env_names=sorted({env for env,_,_ in queries(case)})
        for env in env_names:
            try:
                candidate=SequentialReference(case,profile_for(case,env)).run()
                candidate['certificate']=certify(case,candidate)
                target=f'witness-candidates/{cid}/{env.replace("@","-")}.json'
                write(out/target,candidate);candidate_by_profile[env]=(target,candidate);candidate_count+=1
            except (RefError,TraceError) as error:
                candidate_by_profile[env]=(None,{'status':error.code,'reason':str(error)})
        for env,bound,p in queries(case):
            pid=p['id'];answer={'case_id':cid,'property_id':pid,'environment':env,'bound_ticks':bound,
                'verdict':'UNRESOLVED','accuracy_eligible':False,'reference_scope':'declared symbolic model, no geometry',
                'evidence':None,'reason':'independent timed/parallel transition proof not yet available'}
            profile=profile_for(case,env)
            def mandatory_stop(n):
                if n[0]=='seq':return any(mandatory_stop(x) for x in n[2:])
                if n[0]=='with-control':return case.controls[case.env['controls'][n[2]]]['owner']==profile.get('stop_loss_device')
                return False
            if not p.get('applicable',True):answer.update(verdict='NOT_APPLICABLE',reason='property not applicable in frozen property set')
            elif profile.get('stop_loss_device') and mandatory_stop(case.body) and pid in ('V09','V10a'):
                ident=cid+'-'+pid+'-'+env
                certificate={'case_id':cid,'property_id':pid,'rule':'mandatory_control_has_no_stop_ack',
                             'device':profile['stop_loss_device'],'environment':profile,'input_hashes':case.hashes,
                             'root_success_unreachable':True,'assumption':'scope success requires actual stop AND matching stop confirmation; no recovery bypass'}
                write(out/'proofs'/f'{ident}.json',certificate)
                answer.update(verdict='HOLDS' if pid=='V09' else 'UNREACHABLE',accuracy_eligible=True,evidence=f'proofs/{ident}.json',
                              reason=certificate['rule'],vacuous=pid=='V09')
            elif pid in proofs:
                certificate=proofs[pid];ident=cid+'-'+pid
                if env.startswith('fault') and certificate['rule'] not in ('mandatory_final_guard_is_contradictory',):
                    answer.update(reason='fault profile names interventions but does not fully specify their state effects; universal frame proof withheld')
                else:answer.update(verdict=certificate['verdict'],accuracy_eligible=True,evidence=f'proofs/{ident}.json',reason=certificate['rule'],vacuous=certificate.get('vacuous',False))
            elif pid in ('V01','V02','V03','V04','V05','V06','V07','V08'):
                answer.update(reason='contract obligation is not automatically a proved invariant; independent preservation proof required',expected_obligation='must_hold')
            elif pid=='V10b':
                window=qwindow=case.queries.get('response_window_ticks')
                answer.update(reason='accepted request must reach confirmed terminal or explicit isolated attention state by inclusive deadline; independent timed proof required',response_window_ticks=window)
                if window is not None and bound<window:answer.update(verdict='INCOMPLETE_WINDOW',reason='bound shorter than response window; no complete trigger window')
            target,candidate=candidate_by_profile[env]
            if target and pid in ('V09','V10a'):
                answer['witness_candidate']=target;answer['candidate_completion_tick']=candidate['completion_tick']
                answer['candidate_goal']=candidate['independent_goal'];answer['candidate_within_bound']=candidate['completion_tick']<=bound
                if candidate['completion_tick']<=bound:
                    if pid=='V10a' and candidate['independent_goal']:
                        answer.update(verdict='REACHABLE',accuracy_eligible=True,evidence=target,reason='independent_sequential_timed_witness')
                    elif pid=='V09' and not candidate['independent_goal']:
                        answer.update(verdict='VIOLATED',accuracy_eligible=True,evidence=target,reason='independent_sequential_false_success_witness')
                # For successful sequential executions without time-driven external
                # events, phases have deterministic successful effects. Failures
                # abort the run; delayed/duplicate feedback cannot add operations.
                def contains_par(n):return n[0]=='par' or any(contains_par(x) for x in expr_children(n))
                if not env.startswith('fault') and not case.env.get('events') and not contains_par(case.body):
                    if pid=='V09' and candidate['independent_goal'] and answer['verdict']=='UNRESOLVED':
                        answer.update(verdict='HOLDS',accuracy_eligible=True,evidence=target,reason='unique_successful_sequential_goal_projection')
                    if pid=='V10a' and not candidate['independent_goal'] and answer['verdict']=='UNRESOLVED':
                        answer.update(verdict='UNREACHABLE',accuracy_eligible=True,evidence=target,reason='unique_successful_sequential_goal_projection')
            answers.append(answer);records.append(answer)
        for pid,proof in proofs.items():
            proof.update(case_id=cid,property_id=pid,input_hashes=case.hashes,
                         human_review='pending',independence='derived from parsed source/specification; no acverify result or transition code read')
            write(out/'proofs'/f'{cid}-{pid}.json',proof);certificates.append(f'{cid}-{pid}')
        write(out/'cases'/cid/'answers.json',{'case_id':cid,'static':static[-1],'input_hashes':case.hashes,'queries':answers})
    from collections import Counter
    summary={'cases':len(static),'static_counts':dict(Counter(x['verdict'] for x in static)),
             'query_records':len(records),'query_verdicts':dict(Counter(x['verdict'] for x in records)),
             'eligible_query_records':sum(x['accuracy_eligible'] for x in records),'proof_certificates':len(list((out/'proofs').glob('*.json'))),
             'sequential_witness_candidates':candidate_count,
             'complete_truth':all(r['verdict'] not in ('UNRESOLVED','INCOMPLETE_WINDOW') for r in records),
             'note':'Complete index coverage is not complete independently validated truth.'}
    write(out/'summary.json',summary);write(out/'static-answers.json',{'records':static,'scope':'syntax and nominal binding; no dynamic truth inferred'})
    (out/'answers.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in records),encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--dataset',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();build(a.dataset,a.output)
