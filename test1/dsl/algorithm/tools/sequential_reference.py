"""Independent constructive trace for sequential, healthy executions only.

It uses neither acverify transitions nor its results. PAR and unknown facts are
rejected rather than sequentialized. A trace is a positive bounded witness, not
proof that every execution succeeds. The timing convention is frozen in spec.
"""
import copy
from decimal import Decimal,ROUND_CEILING
from build_standard_answers import RefError,require,read

def ticks(form):
    value=Decimal(str(form[-2]));unit=form[-1]
    require(unit in ('s','ms'),'REFERENCE_UNSUPPORTED','Time unit')
    return int((value*(60 if unit=='s' else Decimal('0.06'))).to_integral_value(rounding=ROUND_CEILING))

class SequentialReference:
    def __init__(self,case,profile):
        self.case=case;self.profile=profile;self.tick=0;self.log=[];self.scope=[];self.active=False;self.pending=[];self.executed=[];self.failure=None
        initial=case.initial;self.mats={m['id']:copy.deepcopy(m) for m in initial['materials']}
        if 'material' in initial:self.mats[initial['material']].update({k:initial[k] for k in ('region','holder','support','held_by')})
        self.drive={d:'stopped' for d in case.devices};self.held={d:None for d in case.devices};self.clamp={d:None for d in case.devices}
        self.index={d:0 for d in case.devices};self.level={d:0 for d in case.devices};self.operations={};self.cycles={};self.reservations={};self.external=copy.deepcopy(initial.get('external',{}));self.applied=set()
        for d,s in initial.get('device_states',{}).items():
            require(s['drive']=='stopped','REFERENCE_UNSUPPORTED','Recovery initial state')
            self.clamp[d]=s['clamped_material'];self.index[d]=s['actual_index'];self.level[d]=s['actual_level']
        self.occupancy={l:[] for l in case.locations}
        for m in self.mats.values():self.occupancy[m['region']].append(m['id'])
        self.goal=case.goal_expr()
        self.call_counts={}

    def owner(self,loc):return self.case.locations[loc]['owner']
    def expr(self,e):
        op=e['op'];m=e.get('material');d=e.get('device');loc=e.get('location')
        if op=='all':return all(self.expr(x) for x in e['args'])
        if op=='any':return any(self.expr(x) for x in e['args'])
        if op=='not':return not self.expr(e['arg'])
        if op=='false':return False
        if op=='at':return self.mats[m]['region']==loc
        if op=='holder':return self.mats[m]['holder']==d
        if op=='supported':return self.mats[m]['support']==loc
        if op=='tools_empty':return all(v is None for v in self.held.values())
        if op=='drive_stopped':return self.drive[d]=='stopped'
        if op=='drives_stopped':return all(v=='stopped' for v in self.drive.values())
        if op=='no_active_requests':return not self.active
        if op=='no_grants':return not self.active and not self.scope
        if op=='unclamped':return self.clamp[d] is None
        if op=='index_is':return self.index[d]==e['value']
        if op=='operation_count':return self.operations.get((m,d),0)>=e['count']
        if op=='cycle_count':return self.cycles.get((m,d),0)>=e['count']
        if op=='external':
            value=self.external[e['key']];require(value.get('valid') is True and type(value['value']) is bool,'REFERENCE_UNSUPPORTED','Unknown external fact')
            return value['value']
        raise RefError('REFERENCE_UNSUPPORTED','Unknown state predicate '+op)

    def event(self,kind,**values):self.log.append({'tick':self.tick,'kind':kind,**values})
    def move_ledger(self,m,loc):
        for items in self.occupancy.values():
            if m in items:items.remove(m)
        self.occupancy[loc].append(m);self.mats[m]['holder']=self.owner(loc)
    def advance(self,n=1):
        require(n>=0,'REFERENCE_UNSUPPORTED','Negative duration')
        for _ in range(n):
            self.tick+=1
            require(self.tick<=20000,'REFERENCE_BOUND','Reference construction budget')
            for i,event in enumerate(self.case.env.get('events',[])):
                if i in self.applied or event['tick']>self.tick:continue
                if event['kind']=='set_external':self.external[event['fact']].update(value=event['value'],valid=event['valid'])
                elif event['kind']=='replace_carrier':
                    # Conservative scheduling: do not let an external replacement
                    # interleave with any active invocation/control in this witness.
                    if self.active or self.scope:continue
                    dest=event['destination'];items=event['materials']
                    require(all(self.mats[m]['holder']==event['carrier'] for m in items),'REFERENCE_UNSUPPORTED','Carrier event source')
                    # This first reference subset does not invent an undeclared external location.
                    require(dest in self.case.locations,'REFERENCE_UNSUPPORTED','External destination not normalized')
                    for m in items:self.move_ledger(m,dest);self.mats[m].update(region=dest,support=dest)
                    self.external[event['set_fact']].update(value=True,valid=True)
                else:raise RefError('REFERENCE_UNSUPPORTED','External event')
                self.applied.add(i);self.event('external',event=i)

    def free(self,target):
        owner=self.owner(target);over=self.case.env.get('scene_parameter_overrides',{}).get(owner,{})
        cap=over.get('capacity',self.case.devices[owner]['parameters']['capacity'])
        localcap=self.case.locations[target]['capacity']
        if not self.case.locations[target].get('slot'):localcap=max(localcap,cap)
        group=sum(len(v) for l,v in self.occupancy.items() if self.owner(l)==owner)
        return len(self.occupancy[target])<localcap and group<cap

    def pre(self,a):
        args=a['args'];dev=a['device'];mid=args.get('material');kind=a['model']['id']
        if kind=='transfer@0.1':
            src,tgt=args['source'],args['target']
            return (self.mats[mid]['region']==src and self.held[dev] is None and self.clamp[self.owner(src)]!=mid
                    and self.drive[self.owner(src)]=='stopped' and self.drive[self.owner(tgt)]=='stopped' and self.free(tgt))
        if kind in ('transport@0.1','circulate@0.1'):
            return dev in self.scope and self.drive[dev]=='moving' and self.mats[mid]['holder']==dev and (kind!='circulate@0.1' or self.mats[mid]['region']==dev+'.exit')
        if kind=='clamp@0.1':return self.mats[mid]['region']==args['location'] and self.owner(args['location'])==dev
        if kind=='unclamp@0.1':return self.clamp[dev]==mid
        if kind=='process@0.1':return self.clamp[dev]==mid and self.mats[mid]['region']==args['location']
        if kind in ('index@0.1','lift@0.1'):return self.drive[dev]=='stopped'
        raise RefError('REFERENCE_UNSUPPORTED','Capability '+kind)

    def effect(self,a,name):
        args=a['args'];dev=a['device'];m=args.get('material')
        if name=='reserve_target':self.reservations[m]=args['target']
        elif name=='capture':self.held[dev]=m;self.mats[m]['held_by']=dev
        elif name=='clear_source':
            loc=dev+'.tool';self.move_ledger(m,loc);self.mats[m].update(region=loc,support=loc)
        elif name=='place_supported':self.mats[m].update(region=args['target'],support=args['target'])
        elif name=='release_tool':self.held[dev]=None;self.mats[m]['held_by']=None
        elif name=='commit_transfer':self.move_ledger(m,args['target']);self.reservations.pop(m,None)
        elif name in ('advance_to_exit','wrap_to_entry'):
            loc=dev+('.exit' if name=='advance_to_exit' else '.entry');self.move_ledger(m,loc);self.mats[m].update(region=loc,support=loc)
        elif name=='increment_cycle':self.cycles[(m,dev)]=self.cycles.get((m,dev),0)+1
        elif name=='clamp_workpiece':self.clamp[dev]=m
        elif name=='unclamp_workpiece':self.clamp[dev]=None
        elif name=='record_operation':self.operations[(m,dev)]=self.operations.get((m,dev),0)+1
        elif name in ('begin_index','begin_lift'):self.drive[dev]='moving'
        elif name=='finish_index':self.index[dev]=args['target_index'];self.drive[dev]='stopped'
        elif name=='finish_lift':self.level[dev]=args['target_level'];self.drive[dev]='stopped'
        elif name=='publish_success':pass
        else:raise RefError('REFERENCE_UNSUPPORTED','Effect '+name)

    def execute(self,n):
        self.advance();kind=n[0];node=n[1];self.event('activate',node=node)
        if kind=='seq':
            for child in n[2:]:self.execute(child);self.advance()
        elif kind=='par':raise RefError('REFERENCE_UNSUPPORTED','Parallel timing requires an independent concurrent checker')
        elif kind=='repeat':
            for i in range(int(n[2])):self.event('iteration',node=node,iteration=i);self.execute(n[3]);self.advance()
        elif kind=='branch':
            choices=[]
            for item in n[4:-1]:choices.append(self.expr(self.case.condition_expr(item[1])))
            if n[2]=='exclusive':require(sum(choices)<=1,'REFERENCE_BLOCKED','Exclusive conflict')
            choice=choices.index(True) if True in choices else len(choices)
            self.event('branch',node=node,choice=choice);self.execute(n[4+choice][-1])
        elif kind=='await':
            expression=self.case.condition_expr(n[2]);deadline=self.tick+ticks(n[3])
            while not self.expr(expression) and self.tick<deadline:self.advance()
            require(self.expr(expression),'REFERENCE_BLOCKED','Await cannot succeed: '+node)
            self.event('await_true',node=node)
        elif kind=='delay':self.advance(ticks(n[2:]))
        elif kind=='fail':raise RefError('REFERENCE_BLOCKED','Explicit failure')
        elif kind=='with-control':
            ref=self.case.env['controls'][n[2]];dev=self.case.controls[ref]['owner']
            require(dev not in self.scope,'REFERENCE_UNSUPPORTED','Nested same-device writer')
            self.scope.append(dev);self.event('writer_acquired',node=node,device=dev)
            self.advance(self.profile['phase'][0]);self.drive[dev]='moving';self.event('drive_started',node=node,device=dev);self.advance();self.execute(n[4])
            self.advance();self.event('stop_command',node=node,device=dev);self.drive[dev]='decelerating';self.advance(self.profile['stop'][0]);self.drive[dev]='stopped';self.event('drive_stopped',node=node,device=dev)
            require(self.profile.get('stop_loss_device')!=dev,'REFERENCE_BLOCKED','Mandatory stop acknowledgement loss')
            self.advance();self.scope.remove(dev);self.event('writer_released',node=node,device=dev)
        elif kind=='invoke':
            a=self.case.actions[node]
            ds=self.case.initial.get('device_states',{}).get(a['device'],{})
            if ds:
                require(ds['permit'] is True,'REFERENCE_UNSUPPORTED','Initial permit is not established')
                if a['model']['id']=='process@0.1':require(ds['access_closed'] is True,'REFERENCE_UNSUPPORTED','Access interlock')
            require(self.pre(a),'REFERENCE_BLOCKED','Invocation precondition false: '+node)
            policy=self.case.env['policies'][n[5][1]];self.active=True
            self.call_counts[node]=self.call_counts.get(node,0)+1
            request=node+'#'+str(self.call_counts[node]);self.event('submitted',node=node,request=request,device=a['device'],args=a['args'])
            acceptance=self.tick+self.profile['accept'][0]
            self.advance(self.profile['accept'][0]);self.event('device_accepted',node=node,request=request)
            execution_begin=acceptance+1
            for phase in a['model']['phases']:
                self.advance(self.profile['phase'][0])
                for e in phase['effects']:self.effect(a,e['effect'])
                self.event('phase',node=node,request=request,phase=phase['id'],effects=[e['effect'] for e in phase['effects']])
            self.advance();require(self.tick-execution_begin<=policy['execute_ticks'],'REFERENCE_UNSUPPORTED','Execution budget')
            require(self.profile['accept'][0]+1<=policy['accept_ticks'],'REFERENCE_UNSUPPORTED','Acceptance budget')
            self.active=False;self.executed.append(node);self.event('completed',node=node,request=request)
        else:raise RefError('REFERENCE_UNSUPPORTED','Node '+kind)
        self.event('node_succeeded',node=node)

    def run(self):
        self.execute(self.case.body)
        value=self.expr(self.goal)
        return {'kind':'sequential_healthy_constructive_trace','reference_semantics':'oracle-sequential/0.1',
                'case_id':self.case.id,'completion_tick':self.tick,'root_succeeded':True,'independent_goal':value,
                'profile':self.profile,'selected_fault_events':[],'events':self.log,'final_materials':self.mats,
                'assumptions':['fresh sound observations','same declared device phase effects','sequential control only',
                               'no physical geometry claim','zero optional faults is permitted'],
                'qualification':'must pass the separate timing/identity certificate check'}

def certify(case,witness):
    """Check a concrete refinement, independently of the searched algorithm.

    A response published after a physical step is observed one tick later. The
    selected acknowledgement delays must still fit the original profile ranges.
    """
    p=witness['profile'];requests={};clock=-1;stops={};starts={}
    age=read(case.root/'shared/execution-profiles/fixed-60hz.json')['default_fact_max_age_ticks']
    require(age>=1,'REFERENCE_UNSUPPORTED','One-tick visibility is not permitted by freshness bound')
    for event in witness['events']:
        t=event['tick'];require(t>=clock,'BAD_CERTIFICATE','Nonmonotone trace');clock=t
        kind=event['kind'];key=event.get('request')
        if kind=='submitted':
            require(key not in requests,'BAD_CERTIFICATE','Reused request identity')
            requests[key]={'submit':t,'node':event['node'],'phases':[]}
        elif kind=='device_accepted':
            r=requests[key];observed=t+1
            require(p['accept'][0]<=observed-r['submit']<=p['accept'][1],'REFERENCE_UNSUPPORTED','Acceptance visibility outside input delay range')
            r.update(accepted=observed,previous=t)
        elif kind=='phase':
            r=requests[key];require(p['phase'][0]<=t-r['previous']<=p['phase'][1],'BAD_CERTIFICATE','Phase duration')
            r['phases'].append(event['phase']);r['previous']=t
        elif kind=='completed':
            r=requests[key];require(t==r['previous']+1 and t>=r['accepted'],'BAD_CERTIFICATE','Completion visibility/identity')
            expected=[x['id'] for x in case.actions[r['node']]['model']['phases']]
            require(r['phases']==expected,'BAD_CERTIFICATE','Capability phase coverage')
            r['completed']=t
        elif kind=='writer_acquired':starts[event['node']]=t
        elif kind=='drive_started':
            require(p['phase'][0]<=t+1-starts[event['node']]<=p['phase'][1],'REFERENCE_UNSUPPORTED','Enter acknowledgement delay')
        elif kind=='stop_command':stops[event['node']]=t
        elif kind=='writer_released':
            require(p['stop'][0]<=t-stops[event['node']]<=p['stop'][1],'REFERENCE_UNSUPPORTED','Stop acknowledgement delay')
    require(all('completed' in r for r in requests.values()),'BAD_CERTIFICATE','Unconfirmed invocation at root success')
    return {'verified':True,'method':'independent sequential interpreter plus separate timing/identity certificate',
            'reference_semantics':'oracle-sequential/0.1','requests':len(requests),'human_review':'pending',
            'scope':'one healthy sequential execution; not every execution, parallel schedule, real equipment, or timed liveness'}

def profile_for(case,name):
    if 'profiles' in case.queries:return next(p for p in case.queries['profiles'] if p['id']==name)
    obj=read(case.root/'shared/environments'/f'{name.split("@")[0]}.json')
    return {'id':name,'accept':obj['accept_delay_ticks'],'phase':obj['phase_duration_ticks'],'stop':obj['stop_delay_ticks'],
            'stop_loss_device':None,'feedback_delay_chosen':0,'max_optional_faults':obj['max_fault_events_per_case']}
