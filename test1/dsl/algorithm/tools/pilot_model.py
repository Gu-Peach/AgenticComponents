"""Finite timed S04 microstep model. No physics, general PLC or runtime claims."""
from dataclasses import dataclass, replace, asdict
from decimal import Decimal, ROUND_CEILING
from pilot_frontend import require, InputError


@dataclass(frozen=True)
class State:
    pc:int=0
    tick:int=0
    elapsed:int=0
    region:str='S.work'
    support:str='S.work'
    holder:str='S'
    held:str=''
    occupied:tuple=('S.work',)
    reserved:str=''
    drives:tuple=('stopped','stopped')
    commands:tuple=(False,False)
    grants:tuple=()
    active:str=''
    accepted:bool=False
    completed:tuple=()
    terminal:str=''
    reason:str=''
    attention:bool=False
    exit_ack:tuple=()


def state_json(state):
    return asdict(state)


def state_from_json(value):
    copy=dict(value)
    for key in ('occupied','drives','commands','exit_ack'): copy[key]=tuple(copy[key])
    for key in ('grants','completed'): copy[key]=tuple(tuple(x) for x in copy[key])
    return State(**copy)


class Model:
    def __init__(self,inputs,profile):
        self.data=inputs; self.profile=profile; self.ir=inputs['ir']
        self.nodes={n['node_id']:n for n in self.ir['nodes']}
        self.bindings=inputs['environment']['bindings']; self.actions=inputs['resolved']
        self.locations={x['id']:x for x in inputs['scene']['locations']}
        self.devices={d['id']:d for d in inputs['scene']['devices']}
        self.conflicts={frozenset(c) for c in inputs['relations']['resource_conflicts']}
        self.controls={c['id']:c for c in inputs['relations']['control_scopes']}
        self.code=[]
        self.compile(self.ir['entry'],None)
        self.code.append({'op':'root_success','node':self.ir['entry']})
        for key in ('accept','phase','stop'):
            interval=profile[key]
            require(len(interval)==2 and all(type(v) is int for v in interval) and 1<=interval[0]<=interval[1],
                    'INVALID_INPUT','invalid timed interval')
        require(profile['stop_loss_device'] in (None,'C1'),'UNSUPPORTED_MODEL','pilot only injects C1 stop evidence loss')
        for node_id,action in self.actions.items():
            policy=inputs['environment']['policies'][self.nodes[node_id]['policy_ref']]
            require(all(type(v) is int and v>0 for v in policy.values()),'INVALID_INPUT','positive tick budgets required')
            require(profile['accept'][1]<=policy['accept_ticks'],'UNSUPPORTED_MODEL','accept timeout path not implemented')
            require(len(action['model']['phases'])*profile['phase'][1]+1<=policy['execute_ticks'],
                    'UNSUPPORTED_MODEL','execution timeout path not implemented')
        for n in self.nodes.values():
            if n['kind']=='with-control':
                policy=inputs['environment']['policies'][n['policy_ref']]
                require(profile['stop'][1]<policy['stop_ticks'],'UNSUPPORTED_MODEL','physical stop must precede confirmation deadline in this pilot')
        init=inputs['initial']
        require(init['permits']=={'R1':True,'R2':True,'C1':True,'C2':True} and init['clamps']=={},
                'UNSUPPORTED_MODEL','pilot requires fixed true permits and no source clamps')
        require(not init['grants'] and not init['completed_requests'] and init['accepted_request'] is None and not init['attention_required'],
                'UNSUPPORTED_MODEL','pilot starts with no protocol activity')
        self.initial=State(region=init['region'],support=init['support'],holder=init['holder'],held=init['held_by'] or '',
            occupied=tuple(init['occupancy']),reserved=init['reservation'] or '',
            drives=tuple(init['drives'][d] for d in ('C1','C2')),commands=tuple(init['run_commands'][d] for d in ('C1','C2')))
        require(self.initial.region in self.locations and self.initial.support in self.locations,
                'INVALID_INPUT','unknown initial location')

    def compile(self,key,parent):
        n=self.nodes[key]; kind=n['kind']
        if kind=='seq':
            self.code.append({'op':'boundary','node':key})
            for child in n['children']: self.compile(child,parent)
        elif kind=='invoke':
            action=self.actions[key]
            if action['model']['id']=='transport@0.1':
                require(parent is not None and self.controls[parent]['owner']==action['device'],'INVALID_BINDING','transport requires its enclosing drive')
            self.code.append({'op':'gate','node':key,'control':parent})
            self.code.append({'op':'accept','node':key,'control':parent})
            for phase in action['model']['phases']:
                self.code.append({'op':'phase','node':key,'phase':phase['id'],'effects':phase['effects'],'control':parent})
            self.code.append({'op':'complete','node':key,'control':parent})
        elif kind=='with-control':
            require(parent is None,'UNSUPPORTED_MODEL','nested control unsupported')
            control=self.data['environment']['controls'][n['control_ref']]
            for op in ('control_gate','write_start','start_response'):
                self.code.append({'op':op,'node':key,'control':control})
            self.compile(n['child'],control)
            for op in ('write_stop','stop_response','control_release'):
                self.code.append({'op':op,'node':key,'control':control})
        elif kind=='await':
            require(parent is None,'UNSUPPORTED_MODEL','await within control unsupported in pilot')
            self.code.append({'op':'await','node':key,'condition':n['condition']})
        else: raise InputError('UNSUPPORTED_MODEL',kind)

    def owner(self,location): return self.locations[location]['owner']
    def drive(self,s,dev): return s.drives[('C1','C2').index(dev)] if dev in ('C1','C2') else 'stopped'
    def command(self,s,dev): return s.commands[('C1','C2').index(dev)]
    def resolve(self,node,value):
        if not isinstance(value,str) or not value.startswith('$'): return value
        if value=='$device': return self.actions[node]['device']
        if value=='$request': return node
        return self.actions[node]['args'][value[1:]]
    def claims(self,node):
        a=self.actions[node]; dev=a['device']; args=a['args']
        if a['model']['id']=='transport@0.1': return ('M1.claim',)
        return tuple(sorted({dev+'.motion','M1.claim',self.locations[args['source']]['zone_ref'],self.locations[args['target']]['zone_ref']}))
    def can_claim(self,s,claims,owner):
        return all(existing_owner==owner or (r!=existing and frozenset((r,existing)) not in self.conflicts)
                   for r in claims for existing,existing_owner in s.grants)
    def grant(self,s,claims,owner): return tuple(sorted(set(s.grants)|{(r,owner) for r in claims}))
    def holds_claims(self,s,node): return all((r,node) in s.grants for r in self.claims(node))
    def predicate(self,s,node,call,control=None):
        p=call['predicate']; a=[self.resolve(node,x) for x in call['args']]
        subject=self.data['initial']['material']
        if p=='source_contains': return a[0]==subject and s.region==a[1] and a[1] in s.occupied
        if p=='source_unclamped': return True  # Fixed, explicit pilot environment.
        if p=='target_compatible': return a[0]==subject and 'workpiece' in self.locations[a[1]]['accepts']
        if p=='target_capacity':
            owner=self.owner(a[0]); capacity=self.devices[owner]['parameters']['capacity']
            return sum(self.owner(x)==owner for x in s.occupied)+int(bool(s.reserved) and self.owner(s.reserved)==owner)<capacity
        if p=='tool_empty': return s.held!=a[0]
        if p in ('source_stationary','target_stationary'): return self.drive(s,self.owner(a[0]))=='stopped'
        if p=='interlock_valid': return self.data['initial']['permits'].get(a[0],False)
        if p=='all_grants_valid': return self.holds_claims(s,node)
        if p=='subject_on_device': return a[0]==subject and self.owner(s.region)==a[1] and s.holder==a[1]
        if p=='drive_authorized':
            return control is not None and (a[0]+'.writer',control) in s.grants and self.command(s,a[0]) and self.drive(s,a[0])=='moving'
        if p=='result_matches': return s.active==node and s.accepted
        if p=='transfer_committed': return a[0]==subject and s.holder==self.owner(a[1]) and a[1] in s.occupied and not s.reserved
        if p=='supported_at': return a[0]==subject and s.region==a[1] and s.support==a[1]
        if p=='subject_at_exit': return a[0]==subject and s.region==a[1]+'.exit'
        raise InputError('UNSUPPORTED_MODEL',f'unimplemented predicate {p}')

    def effect(self,s,node,call):
        name=call['effect']; a=[self.resolve(node,x) for x in call['args']]
        if name=='reserve_target': return replace(s,reserved=a[1])
        if name=='capture': return replace(s,held=a[1])
        if name=='clear_source': return replace(s,region=a[2]+'.tool',support=a[2]+'.tool',holder=a[2],occupied=(a[2]+'.tool',))
        if name=='place_supported': return replace(s,region=a[1],support=a[1])
        if name=='release_tool': return replace(s,held='')
        if name=='commit_transfer': return replace(s,holder=self.owner(a[1]),occupied=(a[1],),reserved='')
        if name=='advance_to_exit': return replace(s,region=a[1]+'.exit',support=a[1]+'.exit',occupied=(a[1]+'.exit',))
        if name=='publish_success': return s
        raise InputError('UNSUPPORTED_MODEL',f'unimplemented effect {name}')

    def observation(self,s,read):
        owner=self.bindings[read['owner_ref']]['id']; key=read['key']
        if 'subject_ref' in read and self.bindings[read['subject_ref']]['id']!=self.data['initial']['material']: return None
        request=read.get('request_node_ref'); completed={row[0]:row for row in s.completed}
        if request and request not in completed: return None
        if key=='surface_stopped': return self.drive(s,owner)=='stopped'
        if key=='both_tools_empty': return not s.held
        if key=='subject_at_exit':
            if request and completed[request][1]!=owner+'.exit': return None
            return s.region==owner+'.exit'
        if key=='holder_matches_target':
            if not request: return None
            return s.holder==self.owner(completed[request][1])
        if key=='supported_at_target':
            if not request: return None
            target=completed[request][1]; return s.region==target and s.support==target
        raise InputError('UNSUPPORTED_MODEL',f'observation {key}')

    def condition(self,s,p):
        kind=p['kind']
        if kind=='ref': return self.condition(s,self.ir['conditions'][p['condition_ref']])
        if kind=='is':
            val=self.observation(s,p['read']); return None if val is None else val==p['equals']['value']
        if kind=='not':
            val=self.condition(s,p['operand']); return None if val is None else not val
        values=[self.condition(s,v) for v in p['operands']]
        if kind=='all': return False if False in values else (None if None in values else True)
        if kind=='any': return True if True in values else (None if None in values else False)
        raise InputError('UNSUPPORTED_MODEL',kind)

    def goal(self,s):
        g=self.data['task']['goal']
        return (g['material']==self.data['initial']['material'] and s.region==g['region'] and s.holder==g['holder']
                and s.support==g['support'] and (s.held or None)==g['held_by']
                and all(self.drive(s,d)==v for d,v in g['drives'].items())
                and (not g['no_grants'] or not s.grants) and (not g['no_active_request'] or not s.active))

    def advance(self,s,**kw): return replace(s,pc=s.pc+1,tick=s.tick+1,elapsed=0,**kw)
    def wait(self,s): return replace(s,tick=s.tick+1,elapsed=s.elapsed+1)
    def fail(self,s,reason):
        # Supported pilot failure sites are outside control scopes and before submission.
        require(not s.grants and not s.active,'UNSUPPORTED_MODEL','failure cleanup for active requests not implemented')
        return replace(s,tick=s.tick+1,terminal='failed',reason=reason,elapsed=0)
    def timed(self,s,interval,complete):
        age=s.elapsed+1; lo,hi=interval; result=[]
        if age>=lo: result.append((complete(), 'response'))
        if age<hi: result.append((self.wait(s),'wait'))
        return result
    def set_drive(self,s,dev,value):
        drives=list(s.drives); drives[('C1','C2').index(dev)]=value
        return tuple(drives)

    def successors(self,s):
        if s.terminal: return []
        ins=self.code[s.pc]; op=ins['op']; node=ins['node']; control=ins.get('control')
        policy=self.data['environment']['policies'].get(self.nodes[node].get('policy_ref','pilot'))
        if op=='boundary': return [(self.advance(s),'activate_seq')]
        if op=='gate':
            action=self.actions[node]
            if all(self.predicate(s,node,p,control) for p in action['model']['preconditions']) and self.can_claim(s,self.claims(node),node):
                return [(self.advance(s,grants=self.grant(s,self.claims(node),node),active=node,accepted=False),'submit_request')]
            if s.elapsed+1>=policy['gate_ticks']: return [(self.fail(s,'gate_timeout:'+node),'gate_timeout')]
            return [(self.wait(s),'gate_wait')]
        if op=='accept':
            return self.timed(s,self.profile['accept'],lambda:self.advance(s,accepted=True))
        if op=='phase':
            action=self.actions[node]
            require(all(self.predicate(s,node,p,control) for p in action['model']['sustaining_conditions']),
                    'UNSUPPORTED_MODEL','hold failure outside pilot environment')
            def complete():
                updated=s
                for call in ins['effects']: updated=self.effect(updated,node,call)
                return self.advance(updated)
            return self.timed(s,self.profile['phase'],complete)
        if op=='complete':
            a=self.actions[node]
            require(all(self.predicate(s,node,p,control) for p in a['model']['completion_conditions']),
                    'MODEL_ERROR','completion evidence missing')
            target=a['args'].get('target',a['device']+'.exit')
            return [(self.advance(s,active='',accepted=False,completed=tuple(sorted(s.completed+((node,target),))),
                                   grants=tuple(g for g in s.grants if g[1]!=node)),'complete_request')]
        if op=='control_gate':
            dev=self.controls[control]['owner']; writer=dev+'.writer'
            if self.can_claim(s,(writer,),control): return [(self.advance(s,grants=self.grant(s,(writer,),control)),'acquire_writer')]
            if s.elapsed+1>=policy['gate_ticks']: return [(self.fail(s,'control_gate_timeout:'+node),'gate_timeout')]
            return [(self.wait(s),'gate_wait')]
        if op in ('write_start','write_stop'):
            dev=self.controls[control]['owner']; cmds=list(s.commands); cmds[('C1','C2').index(dev)]=op=='write_start'
            kw={'commands':tuple(cmds)}
            if op=='write_stop': kw.update(drives=self.set_drive(s,dev,'decelerating'),exit_ack=tuple(sorted(set(s.exit_ack)|{control})))
            return [(self.advance(s,**kw),op)]
        if op=='start_response':
            dev=self.controls[control]['owner']
            return self.timed(s,self.profile['phase'],lambda:self.advance(s,drives=self.set_drive(s,dev,'moving')))
        if op=='stop_response':
            dev=self.controls[control]['owner']
            if self.profile['stop_loss_device']==dev:
                if s.elapsed+1>=policy['stop_ticks']:
                    return [(replace(s,tick=s.tick+1,terminal='attention_required',attention=True,reason='stop_unknown:'+dev),'retain_isolation')]
                if self.drive(s,dev)=='stopped': return [(self.wait(s),'missing_stop_evidence')]
                result=[]; age=s.elapsed+1
                if age>=self.profile['stop'][0]:
                    result.append((replace(self.wait(s),drives=self.set_drive(s,dev,'stopped')),'physical_stop_without_evidence'))
                if age<self.profile['stop'][1]: result.append((self.wait(s),'stop_wait'))
                return result
            return self.timed(s,self.profile['stop'],lambda:self.advance(s,drives=self.set_drive(s,dev,'stopped')))
        if op=='control_release':
            dev=self.controls[control]['owner']
            require(self.drive(s,dev)=='stopped' and control in s.exit_ack,'MODEL_ERROR','control release before stop')
            return [(self.advance(s,grants=tuple(g for g in s.grants if g[1]!=control)),'control_succeeded')]
        if op=='await':
            if self.condition(s,ins['condition']) is True: return [(self.advance(s),'condition_true')]
            timeout=self.nodes[node]['timeout']; seconds=Decimal(timeout['value'])/(1000 if timeout['unit']=='ms' else 1)
            ticks=int((seconds*60).to_integral_value(rounding=ROUND_CEILING))
            if s.elapsed+1>=ticks: return [(self.fail(s,'await_timeout:'+node),'await_timeout')]
            return [(self.wait(s),'condition_wait')]
        if op=='root_success': return [(replace(s,tick=s.tick+1,terminal='succeeded'),'root_succeeded')]
        raise InputError('UNSUPPORTED_MODEL',op)

    def violations(self,s,previous=None,event=None):
        found=[]
        for i,(res,owner) in enumerate(s.grants):
            for res2,owner2 in s.grants[i+1:]:
                if owner!=owner2 and (res==res2 or frozenset((res,res2)) in self.conflicts): found.append('V04')
        if len(s.occupied)!=1 or self.owner(s.occupied[0])!=s.holder: found.append('V05')
        for dev,item in self.devices.items():
            count=sum(self.owner(loc)==dev for loc in s.occupied)+int(bool(s.reserved) and self.owner(s.reserved)==dev)
            if count>item['parameters']['capacity']: found.append('V06')
        if s.attention:
            dev=self.profile['stop_loss_device']
            if not any(r==dev+'.writer' for r,_ in s.grants) or s.terminal!='attention_required': found.append('V08')
        if s.terminal=='succeeded' and not self.goal(s): found.append('V09')
        if previous is not None:
            ins=self.code[previous.pc]
            if ins['op']=='phase' and ins.get('phase')=='capture' and event=='response':
                a=self.actions[ins['node']]; src=a['args']['source']
                if previous.region!=src or self.drive(previous,self.owner(src))!='stopped' or not self.holds_claims(previous,ins['node']): found.append('V01')
            if event=='control_succeeded':
                control=ins['control']; dev=self.controls[control]['owner']
                if self.drive(previous,dev)!='stopped' or control not in previous.exit_ack: found.append('V07')
        return sorted(set(found))
