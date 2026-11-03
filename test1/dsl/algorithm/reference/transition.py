"""Six-phase reference transition relation with explicit event-date choices."""
from .common import clone,TERMINAL,digest
from .state import initial,retire
from .environment import external,faults
from .channel import emit,deliver,sample
from .control import scan,schedule
from .plant import predicates,effect
from .monitors import state_checks,capture_check,bounded_response
from pathlib import Path
import hashlib


class ReferenceModel:
    version='reference-event-agenda/0.1'
    def __init__(self,definition):
        self.d=clone(definition)
        from .frontend import validate
        validate(self.d)
        self.d.input_digest=digest({k:v for k,v in self.d.__dict__.items() if k!='input_digest'})
        self.initial=initial(self.d);log=[];state_checks(self.d,self.initial,log)
        if self.initial['violations'] or self.initial['uncovered_properties']:
            raise ValueError('Initial state not admitted: '+str(log or self.initial['uncovered_properties']))
        self.model_digest=digest({'version':self.version,'definition':self.d.__dict__,'initial':self.initial,
            'sources':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*.py')},
            'specs':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (Path(__file__).parent/'specs').glob('*.json')}})

    def plant(self,s,log,keys,index=0):
        if index==len(keys):yield s,log;return
        k=keys[index];t=s['tokens'][k];event=t.get('hardware')
        if event is None:yield from self.plant(s,log,keys,index+1);return
        if t['status'] in TERMINAL and event!='stop':yield from self.plant(s,log,keys,index+1);return
        interval=self.d.profile['accept' if event=='accept' else 'stop' if event=='stop' else 'phase']
        dates=[t['hardware_due']] if t['hardware_due'] is not None else range(t['hardware_start']+interval[0]-1,t['hardware_start']+interval[1])
        for due in dates:
            nxt=clone(s);events=list(log);token=nxt['tokens'][k];token['hardware_due']=due
            if due>nxt['tick']:
                yield from self.plant(nxt,events,keys,index+1);continue
            token['hardware']=None;token['hardware_due']=None
            if event=='accept':
                if predicates(self.d,nxt,k,'preconditions') is True:
                    emit(self.d,nxt,k,'accepted');token['stage']=0;schedule(token,'action_phase',nxt['tick']+1)
                else:emit(self.d,nxt,k,'rejected')
            elif event=='action_phase':
                if predicates(self.d,nxt,k,'sustaining_conditions') is not True:
                    # Device-side Hold applies before every physical phase,
                    # including while its acceptance packet is still in flight.
                    emit(self.d,nxt,k,'fault');schedule(token,'stop',nxt['tick']+1)
                    events.append({'kind':'device_hold_failed','request':k})
                    yield from self.plant(nxt,events,keys,index+1)
                    continue
                definition=self.d.actions[token['node']]['model'];phase=definition['phases'][token['stage']]
                if any(e['effect']=='capture' for e in phase['effects']):capture_check(self.d,nxt,k,events)
                for call in phase['effects']:
                    effect(self.d,nxt,k,call);state_checks(self.d,nxt,events)
                events.append({'kind':'physical_phase','request':k,'phase':phase['id']})
                token['stage']+=1
                if token['stage']==len(definition['phases']):token['plant_finished']=True;emit(self.d,nxt,k,'result')
                else:schedule(token,'action_phase',nxt['tick']+1)
            elif event=='enter':
                nxt['plant']['devices'][token['actor']]['drive']='moving';emit(self.d,nxt,k,'enter')
            elif event=='stop':
                nxt['plant']['devices'][token['actor']]['drive']='stopped'
                if self.d.profile['forced_stop_loss']==token['actor'] and k not in nxt['lost_stop']:nxt['lost_stop'].append(k)
                if k not in nxt['lost_stop']:emit(self.d,nxt,k,'stop')
                events.append({'kind':'physical_stop','request':k,'confirmation_lost':k in nxt['lost_stop']})
            state_checks(self.d,nxt,events)
            yield from self.plant(nxt,events,keys,index+1)

    def successors(self,state):
        if state['outcome']!='running':return
        s=clone(state);s['tick']+=1;log=[]
        external(self.d,s,log);state_checks(self.d,s,log)
        for variant,notes in faults(self.d,s,log):
            deliver(self.d,variant,notes)
            scan(self.d,variant,notes)
            for physical,events in self.plant(variant,notes,sorted(variant['tokens'])):
                bounded_response(self.d,physical,events)
                state_checks(self.d,physical,events)
                for final,tape in sample(self.d,physical,events):
                    retire(final)
                    yield final,tape
