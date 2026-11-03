"""Composable tick transition system for the contract-backed DSL node types."""
import copy
import math
from pathlib import Path
from .core import read_json
from .core import activation, ticks, require, VerificationError, all3, fingerprint
from .expressions import process_condition, predicate, goal, owner, capacity_available
from .plant import claims, can_claim, reserve, effect, safe_release, release

TERMINAL={'succeeded','failed','cancelled','attention'}
PREDICATES={'source_contains','source_unclamped','target_compatible','target_capacity','tool_empty','source_stationary','target_stationary',
 'interlock_valid','all_grants_valid','drive_stopped','subject_on_device','drive_authorized','subject_at_exit','result_matches',
 'transfer_committed','supported_at','at_location','location_owned_by','clamped','unclamped','access_closed','no_processing',
 'operation_recorded','tools_clear','target_index_valid','axis_target_valid','index_reached','level_reached','material_unspawned'}
EFFECTS={'reserve_target','capture','clear_source','place_supported','release_tool','commit_transfer','emit_registered','advance_to_exit',
 'wrap_to_entry','increment_cycle','record_operation','clamp_workpiece','unclamp_workpiece','begin_index','begin_lift','finish_index','finish_lift','publish_success'}


class TransitionModel:
    version='acverify-tick/0.2'
    def __init__(self,data,environment,fast_copy=False):
        from .state_store import clone_state
        self.clone = clone_state if fast_copy else copy.deepcopy
        self.data=self.clone(data);data=self.data;self.profile=self.clone(environment);self.ir=data['ir'];self.nodes={n['node_id']:n for n in self.ir['nodes']}
        self.spec=read_json(Path(__file__).resolve().parents[2]/'specs/method1-semantics-v2.json')
        self.spec_hash=fingerprint(self.spec)
        self.devices=data['devices'];self.locations=data['locations'];self.models=data['models'];self.actions=data['resolved']
        self.controls={x['id']:x for x in data['relations']['control_scopes']}
        self.conflicts={frozenset(x) for x in data['relations']['resource_conflicts']}
        registered={r['id'] for r in data['relations']['resources']+data['environment'].get('auxiliary_resources',[])}
        registered|={m['id']+'.claim' for m in data['initial']['materials']}
        for d in self.devices.values():require(type(d['parameters']['capacity']) is int and d['parameters']['capacity']>=1,'INVALID_INPUT','Capacity must be a positive integer')
        for action in self.actions.values():
            m=self.models[action['model_ref']]
            ids=[p['id'] for p in m['phases']]
            require(bool(ids) and len(ids)==len(set(ids)),'INVALID_INPUT','Action phases must be nonempty and unique')
            require(all(p['successor']==(ids[i+1] if i+1<len(ids) else 'completed') and p['fault_successor']=='stopping' for i,p in enumerate(m['phases'])),
                    'UNSUPPORTED_MODEL','Non-sequential capability phases need a transition adapter')
            require(all(o.get('preserve_effects') is True for o in m['failure_outcomes']),
                    'UNSUPPORTED_MODEL','Rollback outcomes need an explicit model; effects are preserved')
            for field in ('preconditions','sustaining_conditions','completion_conditions'):
                require(all(p['predicate'] in PREDICATES for p in m[field]),'UNSUPPORTED_MODEL','Unimplemented predicate')
            require(all(e['effect'] in EFFECTS for p in m['phases'] for e in p['effects']),'UNSUPPORTED_MODEL','Unimplemented effect')
            wanted=claims(self,{'device':action['device'],'args':action['arguments'],'model':action['model_ref']})
            require(set(wanted)<=registered,'INVALID_INPUT','Action claims undeclared resources',resources=sorted(set(wanted)-registered))
        for ref,c in self.controls.items():
            require(c['writer'] in registered,'INVALID_INPUT','Control writer is not registered')
            contract=self.models[c['contract_ref']];speed=contract['parameters']['speed'];value=c['speed_m_s']
            require(type(value) in (int,float) and math.isfinite(value) and speed['min']<=value<=speed['max'],
                    'INVALID_INPUT','Drive speed outside contract range',control=ref)
            require(contract['enter']['writes']['run'] is True and contract['exit']['writes']['run'] is False,
                    'UNSUPPORTED_MODEL','Control template must enter run and exit stopped')
        def permissions(node,scope=None):
            n=self.nodes[node]
            if n['kind']=='with-control':
                scope=data['environment']['controls'][n['control_ref']]
            if n['kind']=='invoke' and any(r.startswith('delegate:') for r in self.models[self.actions[node]['model_ref']]['resource_claims']):
                require(scope is not None,'INVALID_INPUT','Delegation needs a parent control scope')
                provider=self.models[self.controls[scope]['contract_ref']]['delegation']
                allowed=provider.get('allowed_behaviors',[provider.get('allowed_behavior')])
                require(n['behavior_id'] in allowed and provider.get('inherit_only') is True,
                        'UNSUPPORTED_MODEL','Control contract does not authorize this delegated capability',behavior=n['behavior_id'],control=scope)
            children=n.get('children',[])+([n['child']] if 'child' in n else [])
            if n['kind']=='branch':children+=[c['child'] for c in n['cases']]+[n['otherwise']]
            for child in children:permissions(child,scope)
        permissions(self.ir['entry'])
        for policy in data['environment']['policies'].values():
            require(all(type(policy[k]) is int and policy[k]>0 for k in ('gate_ticks','accept_ticks','execute_ticks','stop_ticks')),
                    'INVALID_INPUT','Policy budgets must be positive integer ticks')
        for n in self.nodes.values():require(n['kind'] in ('seq','par','branch','repeat','await','delay','invoke','with-control','fail'),'UNSUPPORTED_MODEL','Node kind')
        for field in ('accept','phase','stop','feedback'):
            a,b=environment[field];require(type(a) is int and type(b) is int and (0 if field=='feedback' else 1)<=a<=b,'INVALID_INPUT','Timing interval')
        self.initial=self.initial_state()
        from .properties import invariant_violations
        bad=invariant_violations(self,self.initial)
        require(not bad,'INCONSISTENT_ASSUMPTIONS','Initial state violates accounting/resource constraints',properties=bad)
        self.model_digest=fingerprint(self.export())

    def initial_state(self):
        raw=self.data['initial'];pilot=self.data['descriptor']['schema_type']=='PilotCase'
        if pilot:
            require(raw['accepted_request'] is None and not raw['grants'] and not raw['completed_requests'] and raw['reservation'] is None and not raw['attention_required'],
                    'UNSUPPORTED_MODEL','Initial active protocols need an explicit recovery model')
        else:
            protocol=raw['protocol']
            require(not raw['reservations'] and not protocol['active_requests'] and not protocol['grants'] and not protocol['completed_requests'] and not protocol['attention_required'],
                    'UNSUPPORTED_MODEL','Initial active protocols need an explicit recovery model')
        materials={m['id']:self.clone(m) for m in raw['materials']}
        if pilot:
            m=materials[raw['material']];m.update(region=raw['region'],support=raw['support'],holder=raw['holder'],held_by=raw['held_by'])
            occupancy={loc:([raw['material']] if loc in raw['occupancy'] else []) for loc in self.locations}
        else:occupancy=self.clone(raw['occupancy'])
        states={}
        for dev in self.devices:
            value={'drive':'stopped','run_command':False,'held_material':None,'clamped_material':None,'access_closed':True,'permit':True,
                   'actual_index':0,'actual_level':0,'operation_history':[],'cycle_counts':{},'epoch':0}
            if pilot:
                value.update(drive=raw['drives'].get(dev,'stopped'),run_command=raw['run_commands'].get(dev,False),permit=raw['permits'].get(dev,True))
            else:
                require(dev in raw['device_states'],'INVALID_INPUT','Missing initial device state')
                required=set(value)-{'epoch'}
                require(required<=set(raw['device_states'][dev]),'INVALID_INPUT','Missing initial fields; no success defaults',device=dev)
                value.update(self.clone(raw['device_states'][dev]))
            for field in ('run_command','access_closed','permit'):
                require(value[field] is None or type(value[field]) is bool,'INVALID_INPUT','Initial signal must be boolean or unknown',device=dev,field=field)
            require(value['drive']=='stopped','UNSUPPORTED_MODEL','Initial moving/unknown drive requires a recovery model',device=dev)
            states[dev]=value
        state={'tick':0,'world':{'materials':materials,'devices':states,'occupancy':occupancy,'reservations':{},'grants':{},'committed':[],
                               'external':self.clone(raw.get('external',{}))},
               'tasks':{},'completed':{},'inbox':[],'levels':{},'applied_events':[],'fault_count':0,'lost_stop':[],
               'abort':False,'reason':'','outcome':'running','violations':[]}
        self.activate(state,self.ir['entry'],[],None,None)
        return state

    def activate(self,state,node,path,parent,scope):
        key=activation(node,path);require(key not in state['tasks'],'MODEL_ERROR','Activation ID reused')
        n=self.nodes[node]
        t={'key':key,'node':node,'path':list(path),'parent':parent,'scope':scope,'kind':n['kind'],'phase':'new',
           'created':state['tick'],'eligible':state['tick']+1,'children':[],'cancel':False,'claims':[]}
        if n['kind']=='invoke':
            a=self.actions[node];t.update(device=a['device'],args=self.clone(a['arguments']),model=a['model_ref'],accepted=False,
                                         result_valid=False,stage=0,plant_active=False,plant_done=False,pending_result=None,
                                         epoch=state['world']['devices'][a['device']]['epoch'])
        elif n['kind']=='with-control':
            ref=self.data['environment']['controls'][n['control_ref']]
            t.update(control=ref,device=self.controls[ref]['owner'],ack=False,epoch=state['world']['devices'][self.controls[ref]['owner']]['epoch'])
        state['tasks'][key]=t
        if parent:state['tasks'][parent]['children'].append(key)
        return key

    def policy(self,task):
        n=self.nodes[task['node']];name=n.get('policy_ref')
        return self.data['environment']['policies'][name] if name else {'gate_ticks':1800,'accept_ticks':120,'execute_ticks':1800,'stop_ticks':300}

    def emit(self,state,task,kind):
        # A phase changes a held source state. Sampling, rather than receiving,
        # creates a new timestamp; an old result never gets a new epoch.
        state['levels'][task['key']+'|'+kind]={'request':task['key'],'kind':kind,'device':task['device'],
          'subject':task.get('args',{}).get('material'),'epoch':state['world']['devices'][task['device']]['epoch'],
          'value':True}

    def sample_levels(self,state):
        delay=self.profile['feedback'];remove=[]
        for stream,level in sorted(state['levels'].items()):
            task=state['tasks'].get(level['request']);kind=level['kind']
            if task is None or task['phase'] in TERMINAL:
                remove.append(stream);continue
            if level['epoch']!=state['world']['devices'][level['device']]['epoch']:continue
            interested=(kind=='accepted' and task['phase']=='requesting' and not task.get('accepted') or
                        kind=='result' and task['phase'] in ('requesting','running','result_wait') and not task.get('result_valid') or
                        kind=='enter' and task['phase']=='enter_wait' and not task.get('ack') or
                        kind=='stop' and task['phase'] in ('stopping','exit_wait') and not task.get('stop_ack') and task['key'] not in state['lost_stop'] or
                        kind=='rejected' and task['phase']=='requesting' and not task.get('rejected'))
            if interested:
                state['inbox'].append({**level,'sample_tick':state['tick'],
                    'min_due':state['tick']+1+delay[0],'max_due':state['tick']+1+delay[1]})
        for stream in remove:del state['levels'][stream]

    def consume(self,state,event,log):
        t=state['tasks'].get(event['request'])
        valid=t is not None and event['device']==t.get('device') and event['epoch']==t.get('epoch')==state['world']['devices'][event['device']]['epoch']
        valid=valid and 0<=state['tick']-event['sample_tick']<=self.profile['max_age']
        if valid and event.get('subject')!=t.get('args',{}).get('material'):valid=False
        if not valid or t['phase'] in TERMINAL:
            log.append({'kind':'ignored_feedback','request':event['request']});return
        kind=event['kind']
        if kind=='accepted' and t['phase']=='requesting':
            if not t['accepted']:t['accepted_tick']=state['tick']
            t['accepted']=True
            pending=t.get('pending_result')
            if pending and 0<=state['tick']-pending['sample_tick']<=self.profile['max_age']:t['result_valid']=True
        elif kind=='result' and t['phase'] in ('requesting','running','result_wait'):
            t['pending_result']=event
            if t['accepted']:t['result_valid']=True
        elif kind=='rejected':t['rejected']=True
        elif kind=='enter' and t['phase']=='enter_wait':t['ack']=True
        elif kind=='stop' and t['phase'] in ('stopping','exit_wait') and t['key'] not in state['lost_stop']:
            t['stop_ack']=True
        log.append({'kind':'feedback','node':t['node'],'activation':t['key'],'event':kind,'valid':True})

    def delivered(self,state,log,index=0,blocked=frozenset()):
        if index>=len(state['inbox']):yield state,log;return
        event=state['inbox'][index];now=state['tick']
        stream=(event['request'],event['kind'])
        if stream in blocked:
            yield from self.delivered(state,log,index+1,blocked);return
        if now<event['min_due']:
            yield from self.delivered(state,log,index+1,blocked);return
        if now<event['max_due']:
            yield from self.delivered(self.clone(state),list(log),index+1,blocked|{stream})
        ready=self.clone(state);event=ready['inbox'].pop(index);events=list(log);self.consume(ready,event,events)
        yield from self.delivered(ready,events,index,blocked)

    def apply_events(self,state,log):
        for i,event in enumerate(self.profile['events']):
            if i in state['applied_events'] or event['tick']>state['tick']:continue
            w=state['world']
            if event['kind']=='set_external':
                w['external'][event['fact']].update(value=event['value'],valid=event['valid'],provider_epoch=event['provider_epoch'])
            elif event['kind']=='replace_carrier':
                dev=event['carrier'];zone=dev+'.zone';dest=event['destination']
                if any(r==zone for r in w['grants']) or any(owner(self,r['target'])==dev for r in w['reservations'].values()):continue
                if any(w['materials'][m]['held_by'] is not None or w['materials'][m]['holder']!=dev for m in event['materials']):continue
                if len(w['occupancy'][dest])+len(event['materials'])>self.locations[dest]['capacity']:continue
                from .plant import remove_occupancy
                for mid in event['materials']:
                    remove_occupancy(w,mid);w['occupancy'][dest].append(mid);w['materials'][mid].update(region=dest,support=dest,holder=owner(self,dest))
                w['devices'][dev]['epoch']=event['new_epoch'];w['external'][event['set_fact']].update(value=True,valid=True)
            else:raise VerificationError('UNSUPPORTED_MODEL','External event kind')
            state['applied_events'].append(i);log.append({'kind':'external_event','event':i})

    def fault_variants(self,state,log):
        yield self.clone(state),list(log)
        if state['fault_count']>=self.profile['max_faults']:return
        active=[t for t in state['tasks'].values() if t['kind'] in ('invoke','with-control') and t['phase'] not in TERMINAL|{'new','gate'}]
        for fault in self.profile['faults']:
            if fault=='delayed_feedback':continue # Already covered by every packet's delivery interval.
            if fault in ('duplicate_same_request','old_request_feedback'):
                if not state['inbox']:continue
                s=self.clone(state);event=self.clone(s['inbox'][0]);event['min_due']=s['tick'];event['max_due']=s['tick']
                if fault=='old_request_feedback':event['request']='prior:'+event['request']
                s['inbox'].append(event);s['fault_count']+=1;yield s,log+[{'kind':'fault','fault':fault}]
            else:
                for t in active:
                    if fault=='missing_stop_confirmation' and t['phase'] not in ('stopping','exit_wait'):continue
                    s=self.clone(state);s['fault_count']+=1;dev=t['device']
                    if fault=='missing_stop_confirmation':s['lost_stop'].append(t['key'])
                    elif fault=='hold_permission_loss':s['world']['devices'][dev]['permit']=False
                    elif fault=='provider_restart':
                        s['world']['devices'][dev]['epoch']+=1;s['abort']=True;s['reason']='provider_restart'
                        s['levels']={k:v for k,v in s['levels'].items() if v['device']!=dev}
                        for affected in s['tasks'].values():
                            if affected.get('device')==dev and affected['phase'] not in TERMINAL:
                                affected.update(stop_ack=False,ack=False,result_valid=False)
                    else:continue
                    yield s,log+[{'kind':'fault','fault':fault,'node':t['node'],'activation':t['key']}]

    def stop(self,state,t,reason):
        if t['phase'] in TERMINAL:return
        if t['kind']=='invoke':
            if t['phase'] in ('new','gate'):
                release(state,t['key']);t['phase']='cancelled';return
            if t['phase']!='stopping':t.update(phase='stopping',stop_start=state['tick'],stop_ack=False,stop_sent=False)
        elif t['kind']=='with-control':
            if t['phase'] in ('new','gate'):
                release(state,t['key']);t['phase']='cancelled';return
            if t['phase']!='exit_wait':
                t.update(phase='exit_wait',stop_start=state['tick'],stop_ack=False,stop_sent=False,abort_exit=True)
                state['world']['devices'][t['device']].update(run_command=False,drive='decelerating')
        else:
            if not t['children']:t['phase']='cancelled'
            else:t['phase']='cancelling'
        t['reason']=reason

    def fail(self,state,t,reason):
        state['abort']=True;state['reason']=reason;t['reason']=reason
        self.stop(state,t,reason)

    def controller(self,state,log):
        now=state['tick'];snapshot=self.clone(state)
        keys=sorted(state['tasks'],key=lambda k:(state['tasks'][k].get('eligible',-1),state['tasks'][k]['node'],state['tasks'][k]['path']))
        for key in keys:
            t=state['tasks'][key];n=self.nodes[t['node']];kind=t['kind'];phase=t['phase']
            if phase in TERMINAL or now<t['eligible']:continue
            if state['abort'] or t['cancel']:self.stop(state,t,state['reason'] or 'cancelled')
            phase=t['phase']
            if phase in TERMINAL:continue
            policy=self.policy(t)
            if kind=='invoke':
                m=self.models[t['model']]
                if phase in ('new','gate'):
                    t['phase']='gate'
                    pre=all3(predicate(self,snapshot,t,p) for p in m['preconditions'])
                    log.append({'kind':'gate_read','node':t['node'],'activation':key,'value':pre})
                    wanted=claims(self,t)
                    # Recheck capacity and mutable authorization during atomic arbitration.
                    capacity=('target' not in t['args'] or capacity_available(self,state['world'],t['args']['target'],key))
                    if pre is True and capacity and can_claim(self,state['world'],wanted,key):
                        t.update(phase='requesting',submit=now,claims=wanted,accept_sent=False)
                        for r in wanted:state['world']['grants'][r]=key
                        reserve(state['world'],key,t['args']);log.append({'kind':'submit','node':t['node'],'activation':key})
                    elif now>=t['created']+policy['gate_ticks']:self.fail(state,t,'gate_timeout:'+t['node'])
                elif phase=='requesting':
                    if t.get('rejected'):self.fail(state,t,'device_rejected:'+t['node'])
                    elif t['accepted']:
                        if all3(predicate(self,snapshot,t,p) for p in m['sustaining_conditions']) is not True:
                            self.fail(state,t,'hold_failed:'+t['node'])
                        else:t.update(phase='result_wait' if t['plant_done'] else 'running',execute_start=now)
                    elif now>=t['submit']+policy['accept_ticks']:self.fail(state,t,'accept_timeout:'+t['node'])
                elif phase in ('running','result_wait'):
                    hold=all3(predicate(self,snapshot,t,p) for p in m['sustaining_conditions'])
                    if hold is not True:self.fail(state,t,'hold_failed:'+t['node'])
                    elif t['result_valid'] and all3(predicate(self,state,t,p) for p in m['completion_conditions']) is True:
                        target=t['args'].get('target',t['device']+'.exit' if t['model'] in ('transport@0.1','circulate@0.1') else t['args'].get('location'))
                        state['completed'][key]={'request':key,'node':t['node'],'material':t['args'].get('material'),'target':target,'epoch':t['epoch']}
                        release(state,key);t['phase']='succeeded';log.append({'kind':'action_succeeded','node':t['node'],'activation':key})
                    elif now>=t['execute_start']+policy['execute_ticks']:self.fail(state,t,'execute_timeout:'+t['node'])
                elif phase=='stopping':
                    if t.get('stop_ack'):
                        if safe_release(self,state,t):release(state,key);t['phase']='failed'
                        else:t['phase']='attention'
                    elif now>=t['stop_start']+policy['stop_ticks']:t['phase']='attention'
            elif kind=='with-control':
                if phase in ('enter_wait','body') and snapshot['world']['devices'][t['device']]['permit'] is not True:
                    self.fail(state,t,'control_hold_failed:'+t['node']);continue
                if phase in ('new','gate'):
                    t['phase']='gate';writer=self.controls[t['control']]['writer']
                    if snapshot['world']['devices'][t['device']]['permit'] is True and can_claim(self,state['world'],[writer],key):
                        state['world']['grants'][writer]=key;t.update(claims=[writer],phase='enter_wait',start=now,enter_sent=False)
                        state['world']['devices'][t['device']]['run_command']=True
                    elif now>=t['created']+policy['gate_ticks']:self.fail(state,t,'control_gate_timeout:'+t['node'])
                elif phase=='enter_wait':
                    if t['ack'] and snapshot['world']['devices'][t['device']]['drive']=='moving':
                        t['phase']='body';self.activate(state,n['child'],t['path'],key,key)
                    elif now>=t['start']+policy['accept_ticks']:self.fail(state,t,'control_enter_timeout:'+t['node'])
                elif phase=='body':
                    child=state['tasks'][t['children'][0]]
                    if child['phase']=='succeeded':
                        t.update(phase='exit_wait',stop_start=now,stop_ack=False,stop_sent=False,abort_exit=False)
                        state['world']['devices'][t['device']].update(run_command=False,drive='decelerating')
                    elif child['phase'] in TERMINAL:self.fail(state,t,'control_child_failed:'+t['node'])
                elif phase=='exit_wait':
                    children_stable=all(state['tasks'][c]['phase'] in TERMINAL for c in t['children'])
                    if t.get('stop_ack') and snapshot['world']['devices'][t['device']]['drive']=='stopped' and children_stable:
                        release(state,key);t['phase']='failed' if t.get('abort_exit') else 'succeeded'
                        if t['phase']=='succeeded':log.append({'kind':'control_succeeded','node':t['node'],'activation':key,'device':t['device'],'ack':True,'actual_stopped':True})
                    elif now>=t['stop_start']+policy['stop_ticks']:t['phase']='attention';state['abort']=True
            elif phase=='cancelling':
                if all(state['tasks'][c]['phase'] in TERMINAL for c in t['children']):t['phase']='failed'
            elif kind in ('await','delay','fail'):
                if kind=='fail':self.fail(state,t,'explicit_fail:'+n['code'])
                elif kind=='delay':
                    if now>=t['created']+max(1,ticks(n['duration'])):t['phase']='succeeded'
                else:
                    value=process_condition(self,snapshot,n['condition'],t['path'])
                    log.append({'kind':'condition_read','node':t['node'],'activation':key,'value':value,'sample_tick':now})
                    if value is True:t['phase']='succeeded'
                    elif now>=t['created']+ticks(n['timeout']):self.fail(state,t,'await_timeout:'+t['node'])
            elif kind in ('seq','par','repeat','branch'):
                self.composite(state,snapshot,t,n,log)
        changes=len(set(state['tasks'])-set(snapshot['tasks']))+sum(
            t['phase']!=snapshot['tasks'][key]['phase'] for key,t in state['tasks'].items() if key in snapshot['tasks'])
        if changes>self.data['execution_profile'].get('max_transitions_per_tick',1024):
            state['abort']=True;state['reason']='E_STEP_BUDGET'
        # A late failure cancels every already activated branch; no new requests next tick.
        if state['abort']:
            for t in state['tasks'].values():self.stop(state,t,state['reason'] or 'run_abort')
        root=state['tasks'][activation(self.ir['entry'],[])]
        if root['phase']=='succeeded' and not state['abort']:
            state['outcome']='succeeded';log.append({'kind':'root_succeeded','node':root['node']})
        elif state['abort'] and all(t['phase'] in TERMINAL for t in state['tasks'].values()):
            state['outcome']='attention_required' if any(t['phase']=='attention' for t in state['tasks'].values()) else 'failed'

    def composite(self,state,snapshot,t,n,log):
        kind=t['kind'];now=state['tick'];key=t['key'];phase=t['phase']
        if phase=='new':
            t['phase']='body';t['position']=0
            if kind=='seq':self.activate(state,n['children'][0],t['path'],key,t['scope'])
            elif kind=='par':
                for child in n['children']:self.activate(state,child,t['path'],key,t['scope'])
            elif kind=='repeat':
                if n['count']==0:t['phase']='succeeded'
                else:self.activate(state,n['child'],t['path']+[0],key,t['scope'])
            else:t['phase']='choosing'
            return
        if kind=='branch' and phase=='choosing':
            values=[process_condition(self,snapshot,c['condition'],t['path']) for c in n['cases']];choice=None
            if n['mode']=='exclusive':
                if values.count(True)>1:self.fail(state,t,'branch_conflict:'+t['node']);return
                if None not in values:choice=values.index(True) if True in values else len(values)
            else:
                for i,value in enumerate(values):
                    if value is None:break
                    if value is True:choice=i;break
                else:choice=len(values)
            if choice is not None:
                child=n['otherwise'] if choice==len(values) else n['cases'][choice]['child'];t['phase']='body';t['choice']=choice
                self.activate(state,child,t['path'],key,t['scope'])
            elif now>=t['created']+ticks(n['timeout']):self.fail(state,t,'branch_timeout:'+t['node'])
            return
        children=[state['tasks'][x] for x in t['children']]
        if any(c['phase'] in ('failed','cancelled','attention') for c in children):self.fail(state,t,'child_failed:'+t['node']);return
        if not children or not all(c['phase']=='succeeded' for c in children):return
        if kind=='seq' and t['position']+1<len(n['children']):
            t['position']+=1;self.activate(state,n['children'][t['position']],t['path'],key,t['scope'])
        elif kind=='repeat' and t['position']+1<n['count']:
            t['position']+=1;self.activate(state,n['child'],t['path']+[t['position']],key,t['scope'])
        else:t['phase']='succeeded'

    def plant_variants(self,state,log,keys,index=0):
        if index>=len(keys):yield state,log;return
        key=keys[index];t=state['tasks'][key];phase=t['phase'];interval=None;kind=None
        if t['kind']=='invoke' and phase=='requesting' and not t.get('accept_sent'):
            interval=self.profile['accept'];start=t['submit'];kind='accepted'
        elif t['kind']=='invoke' and phase in ('requesting','running','result_wait') and t.get('plant_active'):
            interval=self.profile['phase'];start=t['stage_start'];kind='phase'
        elif t['kind']=='with-control' and phase=='enter_wait' and not t.get('enter_sent'):
            interval=self.profile['phase'];start=t['start'];kind='enter'
        elif phase in ('stopping','exit_wait') and not t.get('stop_sent'):
            interval=self.profile['stop'];start=t['stop_start'];kind='stop'
        if interval is None:yield from self.plant_variants(state,log,keys,index+1);return
        age=state['tick']-start+1
        if age<interval[1]:yield from self.plant_variants(self.clone(state),list(log),keys,index+1)
        if age<interval[0]:return
        s=self.clone(state);events=list(log);t=s['tasks'][key]
        if kind=='phase':
            phase_def=self.models[t['model']]['phases'][t['stage']]
            if phase_def['id']=='capture':
                src=t['args']['source'];good=(s['world']['materials'][t['args']['material']]['region']==src and s['world']['devices'][owner(self,src)]['drive']=='stopped' and all(s['world']['grants'].get(r)==key for r in t['claims']))
                if not good:s['violations'].append('V01')
                events.append({'kind':'capture','node':t['node'],'activation':key,'valid':good})
            for call in phase_def['effects']:effect(self,s,t,call)
            events.append({'kind':'plant_phase','node':t['node'],'activation':key,'phase':phase_def['id'],'model':t['model']})
            if t['stage']+1==len(self.models[t['model']]['phases']):
                t['plant_active']=False;t['plant_done']=True
                if t['phase']=='running':t['phase']='result_wait'
                self.emit(s,t,'result')
            else:t['stage']+=1;t['stage_start']=s['tick']+1
        elif kind=='accepted':
            t['accept_sent']=True
            if all3(predicate(self,s,t,p) for p in self.models[t['model']]['preconditions']) is True:
                t.update(plant_active=True,stage=0,stage_start=s['tick']+1);self.emit(s,t,kind)
            else:self.emit(s,t,'rejected')
        elif kind=='enter':
            t['enter_sent']=True;s['world']['devices'][t['device']]['drive']='moving';self.emit(s,t,kind)
        else:
            t['stop_sent']=True;t['plant_active']=False;s['world']['devices'][t['device']]['drive']='stopped'
            if self.profile['forced_stop_loss']==t['device'] and key not in s['lost_stop']:s['lost_stop'].append(key)
            if key not in s['lost_stop']:self.emit(s,t,'stop')
            events.append({'kind':'physical_stop','node':t['node'],'activation':key,'confirmation_lost':key in s['lost_stop']})
        yield from self.plant_variants(s,events,keys,index+1)

    def successors(self,state):
        if state['outcome']!='running':return
        base=self.clone(state);base['tick']+=1;log=[];self.apply_events(base,log)
        for faulted,events in self.fault_variants(base,log):
            for delivered,notes in self.delivered(faulted,events):
                self.controller(delivered,notes)
                keys=sorted(delivered['tasks'])
                for nxt,trace in self.plant_variants(delivered,notes,keys):
                    self.sample_levels(nxt)
                    nxt['violations']=sorted(set(nxt['violations']))
                    yield nxt,trace

    def export(self):
        return {'schema_type':'TransitionIR','version':self.version,'language':self.ir['language'],'process':self.ir,
          'semantics_id':self.spec['id'],'semantics_hash':self.spec_hash,
          'bindings':self.data['resolved'],'device_instances':self.devices,'locations':self.locations,
          'contracts':{a['model_ref']:self.models[a['model_ref']] for a in self.actions.values()},
          'environment':self.profile,'initial':self.initial,
          'task_specification':self.data['task'],'property_requests':self.data['properties'],
          'controls':self.controls,'resource_conflicts':sorted(sorted(x) for x in self.conflicts),
          'policies':self.data['environment']['policies'],
          'observations':self.data['environment'].get('observation_definitions',self.data['environment'].get('observations',{})),
          'input_digest':self.data['input_digest'],
          'observation_semantics':'latched source status, periodic resampling, FIFO bounded delay, source-timestamp freshness; no geometry',
          'execution_semantics':'integer ticks; immutable condition snapshot; atomic ordered arbitration; plant publication after controller',
          'note':'Controller protocol is trusted generated semantics; properties of its guards are construction checks, not arbitrary implementation verification.'}
