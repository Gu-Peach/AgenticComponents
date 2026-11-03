"""Executable property obligations over explicit observation frames.

Frames describe actual state and events, not self-reported property verdicts.
P2 must produce these frames from independently defined transitions. A frame
check or one trace never proves all possible executions safe.
"""
import copy
from collections import Counter
from pathlib import Path
import json
import math

SPEC_PATH = Path(__file__).parent/'specs/property-spec.json'
IDENTITY = ('activation', 'request', 'device', 'subject', 'epoch')


class InvalidFrame(ValueError): pass


def number(value):
    if type(value) is not int or value < 0: raise InvalidFrame('Expected nonnegative integer')
    return value


def sequence(value):
    if type(value) is not list: raise InvalidFrame('Expected list')
    return value


def flag(value):
    if value is not None and type(value) is not bool: raise InvalidFrame('Expected boolean or unknown')
    return value


def all3(values):
    values = list(values)
    return False if any(v is False for v in values) else None if any(v is None for v in values) else True


def any3(values):
    values = list(values)
    return True if any(v is True for v in values) else None if any(v is None for v in values) else False


def identity(request):
    values = tuple(request[k] for k in IDENTITY)
    for k in ('activation', 'request', 'device'):
        if type(request[k]) is not str or not request[k]: raise InvalidFrame('Request identity must be nonempty')
    if request['subject'] is not None and type(request['subject']) is not str: raise InvalidFrame('Subject identity')
    number(request['epoch'])
    return values


def owner_ref(request):
    return list(identity(request))


def request_evidence_valid(event,tick):
    request=event['request'];expected=event['expected']
    if any(expected[k]!=request[k] for k in ('activation','request','subject','epoch')):
        return False
    if expected['provider']!=request['device'] or expected['request_scoped'] is not True:return False
    return evidence_valid(event['evidence'],expected,tick,event['max_age'])


def grant_valid(required, grants, owner):
    required = sequence(required); grants = sequence(grants)
    return all(any(g['resource'] == r and g['owner'] == owner for g in grants) for r in required)


def evidence_valid(evidence, expected, tick, max_age):
    number(tick); number(max_age); sampled = number(evidence['sample_tick'])
    if flag(evidence['valid']) is not True: return False
    if evidence['provider'] != expected['provider'] or evidence['epoch'] != expected['epoch']: return False
    number(evidence['epoch']); number(expected['epoch'])
    if evidence['subject'] != expected['subject']: return False
    typ=expected['value_type'];value=evidence['value']
    if typ=='bool':typed=type(value) is bool
    elif typ=='real':typed=type(value) in (int,float) and math.isfinite(value)
    elif typ=='dint':typed=type(value) is int and -(2**31)<=value<2**31
    elif typ=='reference':typed=type(value) is str and bool(value)
    else:raise InvalidFrame('Unsupported evidence type')
    if not typed:return False
    if flag(expected['request_scoped']) is True:
        if evidence['activation'] != expected['activation'] or evidence['request'] != expected['request']: return False
    elif expected['request_scoped'] is None:
        return None
    return 0 <= tick - sampled <= max_age


def goal_value(world, expression):
    if 'op' not in expression:
        m = world['materials'][expression['material']]
        return all3([*(m[k] == expression[k] for k in ('region','holder','support','held_by')),
            *(world['devices'][d]['drive'] == value for d,value in expression['drives'].items()),
            (not world['grants']) if expression['no_grants'] else True,
            (not world['active_requests']) if expression['no_active_request'] else True])
    op=expression['op'];mid=expression.get('material');dev=expression.get('device')
    if op=='all':return all3(goal_value(world,x) for x in expression['args'])
    if op=='any':return any3(goal_value(world,x) for x in expression['args'])
    if op=='not':
        value=goal_value(world,expression['arg']);return None if value is None else not value
    if op in ('at','supported','holder'):
        field={'at':'region','supported':'support','holder':'holder'}[op]
        return world['materials'][mid][field] == expression['device' if op=='holder' else 'location']
    if op=='tools_empty':return all(d['held_material'] is None for d in world['devices'].values())
    if op=='drives_stopped':return all3(None if d['drive'] is None else d['drive']=='stopped' for d in world['devices'].values())
    if op=='drive_stopped':return None if world['devices'][dev]['drive'] is None else world['devices'][dev]['drive']=='stopped'
    if op=='no_grants':return not sequence(world['grants'])
    if op=='no_active_requests':return not sequence(world['active_requests'])
    if op=='unclamped':return world['devices'][dev]['clamped_material'] is None
    if op=='index_is':return world['devices'][dev]['actual_index']==expression['value']
    if op=='operation_count':return sum(x['material']==mid for x in world['devices'][dev]['operation_history'])>=number(expression['count'])
    if op=='cycle_count':return number(world['devices'][dev]['cycle_counts'][mid])>=number(expression['count'])
    if op=='external':
        e=world['external'][expression['key']]
        return flag(e['value']) if flag(e['valid']) is True else None
    raise InvalidFrame('Unsupported goal operator: '+op)


def capture(frame):
    req=frame['request'];identity(req);source=frame['source']
    stopped=None if source['drive'] is None else source['drive']=='stopped'
    return all3([stopped, req['subject'] in sequence(source['material_ids']),
                 grant_valid(frame['required_resources'],frame['grants'],owner_ref(req))])


def associated(frame):
    req=frame['request'];accepted=frame['accepted'];feedback=frame['feedback']
    return all3([identity(req)==identity(accepted)==identity(feedback),
                 flag(accepted['observed']) is True,flag(feedback['value']) is True])


def exclusive(frame):
    grants=sequence(frame['grants']);conflicts={frozenset(x) for x in sequence(frame['conflicts'])}
    return all(a['owner']==b['owner'] or (a['resource']!=b['resource'] and
        frozenset((a['resource'],b['resource'])) not in conflicts)
        for i,a in enumerate(grants) for b in grants[i+1:])


def ledger_consistent(frame, phases=True):
    values=[]
    for m in sequence(frame['materials']):
        p=m['physical'];ledger=m['ledger'];locations=sequence(ledger['locations'])
        if m['phase']=='unspawned':
            values.append(not locations and ledger['holder'] is None and p['region']=='unspawned' and p['held_by'] is None)
            continue
        base=len(locations)==1 and frame['location_owners'][locations[0]]==ledger['holder']
        if not phases:values.append(base);continue
        phase=m['phase']
        if phase=='stable':
            expected=(p['region'],p['region'],None,frame['location_owners'][p['region']],p['region'])
        else:
            source=m['source'];target=m['target'];actor=m['actor'];tool=m['tool']
            table={
                'reserved':(source,source,None,frame['location_owners'][source],source),
                'captured':(source,source,actor,frame['location_owners'][source],source),
                'cleared':(tool,tool,actor,actor,tool),
                'placed':(target,target,actor,actor,tool),
                'released':(target,target,None,actor,tool),
                'committed':(target,target,None,frame['location_owners'][target],target)}
            if phase not in table:raise InvalidFrame('Unknown handoff phase: '+phase)
            expected=table[phase]
        actual=(p['region'],p['support'],p['held_by'],ledger['holder'],locations[0] if len(locations)==1 else None)
        values.append(base and actual==expected)
    return all3(values)


def capacity(frame, idempotence=True):
    checks=[]
    for domain in sequence(frame['capacity_domains']):
        checks.append(len(sequence(domain['occupied']))+len(sequence(domain['reserved']))<=number(domain['capacity']))
    if idempotence:
        commits=sequence(frame['effective_commits'])
        # Changing a payload must not turn a second commit into a new transaction.
        keys=[(c['activation'],c['request']) for c in commits]
        checks.append(all(n<=1 for n in Counter(keys).values()))
    return all3(checks)


def drive_exit(frame):
    req=frame['request'];identity(req);write=frame['stop_write'];ack=frame['stop_ack']
    expected={'provider':req['device'],'epoch':frame['current_epoch'],'subject':req['subject'],
              'request_scoped':True,'activation':req['activation'],'request':req['request'],'value_type':'bool'}
    return all3([write['request']==req['request'],flag(write['run']) is False,
        None if frame['actual_drive'] is None else frame['actual_drive']=='stopped',
        req['epoch']==frame['current_epoch'],flag(ack['value']) is True, number(ack['sample_tick'])>=number(write['tick']),
        evidence_valid(ack,expected,frame['tick'],frame['max_age'])])


def isolated(frame, material_preservation=True):
    req=frame['request'];identity(req)
    checks=[frame['terminal'] not in ('confirmed_success','confirmed_failure','confirmed_cancel'),
            grant_valid(frame['required_resources'],frame['grants'],owner_ref(req))]
    if frame['deadline_expired'] is not None:
        checks.append(not flag(frame['deadline_expired']) or frame['terminal']=='attention_required')
    else:checks.append(None)
    if material_preservation:
        # This is the failure-handler microstep, not an interval containing
        # independent plant motion. P2 must split those observation frames.
        checks.append(frame['before_affected_materials']==frame['after_affected_materials'])
    return all3(checks)


TRIGGERS={'V01':'capture','V02':'confirm_success','V03':'consume_evidence','V04':'state',
          'V05':'state','V06':'state','V07':'scope_success','V08':'unknown_stop_handler',
          'V09':'root_success','V10a':'root_success'}


def evaluate(property_id, frame, task=None, variant='full', bound=None):
    """Return a local obligation result; never a whole-model truth label."""
    try:
        if property_id=='V10b':raise InvalidFrame('V10b requires ResponseMonitor')
        expected_kind=TRIGGERS[property_id]
        if frame['kind']!=expected_kind:return {'status':'NOT_TRIGGERED','property':property_id}
        number(frame['tick'])
        if property_id=='V10a':
            if bound is None:raise InvalidFrame('V10a requires bound_ticks')
            if frame['tick']>number(bound):return {'status':'OUTSIDE_QUERY_BOUND','property':property_id}
        if variant not in ('full','pilot_legacy'):raise InvalidFrame('Unknown property variant')
        if variant=='pilot_legacy' and property_id in ('V02','V03'):raise InvalidFrame('Property not declared in pilot scope')
        if property_id=='V01':value=capture(frame)
        elif property_id=='V02':value=associated(frame)
        elif property_id=='V03':value=evidence_valid(frame['evidence'],frame['expected'],frame['tick'],frame['max_age'])
        elif property_id=='V04':value=exclusive(frame)
        elif property_id=='V05':value=ledger_consistent(frame,variant=='full')
        elif property_id=='V06':value=capacity(frame,variant=='full')
        elif property_id=='V07':value=drive_exit(frame)
        elif property_id=='V08':value=isolated(frame,variant=='full')
        else:
            if task is None:raise InvalidFrame('Independent TaskSpec is required')
            value=goal_value(frame['world'],task['goal'])
            if variant=='full':
                value=all3([value,not sequence(frame['world']['active_requests']),not sequence(frame['world']['grants'])])
        active=True
        if property_id=='V04':active=bool(frame['grants'])
        elif property_id=='V05':active=bool(frame['materials'])
        elif property_id=='V06':active=any(d['occupied'] or d['reserved'] for d in frame['capacity_domains']) or bool(frame.get('effective_commits',[]))
        status='UNKNOWN' if value is None else 'SATISFIED' if value else 'VIOLATED'
        if property_id=='V10a' and value is False:status='GOAL_NOT_MET_AT_THIS_EVENT'
        return {'status':status,'property':property_id,'trigger_observed':active,
                'scope':'one observation frame; no universal or unreachable conclusion'}
    except (KeyError,IndexError) as error:
        return {'status':'UNKNOWN','property':property_id,'reason':'MISSING_FIELD:'+str(error)}
    except (TypeError,InvalidFrame) as error:
        return {'status':'INVALID_FRAME','property':property_id,'reason':str(error)}


class ResponseMonitor:
    """V10b on one trace, with inclusive deadlines and explicit tail coverage."""
    def __init__(self, window, trigger_horizon):
        self.window=number(window);self.horizon=number(trigger_horizon)
        if self.window==0:raise InvalidFrame('Response window must be positive')
        self.now=-1;self.pending={};self.responded={};self.violations=[];self.unknown=[]

    def step(self,tick,events):
        number(tick)
        if tick<=self.now:raise InvalidFrame('Feed all events at a tick in one strictly increasing step')
        self.now=tick
        for event in sequence(events):
            try:
                key=identity(event['request']);kind=event['kind']
                if kind=='accepted':
                    if tick>self.horizon:continue
                    valid=request_evidence_valid(event,tick)
                    if valid is None:raise InvalidFrame('Unknown acceptance evidence binding')
                    if not valid:continue
                    if flag(event['evidence']['value']) is not True:continue
                    # Never reset an already recorded acceptance clock.
                    self.pending.setdefault(key,tick)
                elif kind=='response' and key in self.pending:
                    terminal=event['terminal'];valid=False
                    if terminal=='attention_required':
                        valid=grant_valid(event['required_resources'],event['grants'],owner_ref(event['request']))
                    elif terminal in ('confirmed_success','confirmed_failure','confirmed_cancel'):
                        valid=request_evidence_valid(event,tick) is True and flag(event['evidence']['value']) is True
                    if valid:self.responded.setdefault(key,tick)
            except (KeyError,InvalidFrame,TypeError) as error:
                self.unknown.append({'tick':tick,'reason':str(error)})
        for key,accepted in self.pending.items():
            deadline=accepted+self.window;response=self.responded.get(key)
            if tick>=deadline and (response is None or response>deadline) and key not in self.violations:
                self.violations.append(key)
        return self.result()

    def result(self):
        tail=[k for k,t in self.pending.items() if k not in self.responded and self.now<t+self.window]
        status=('TRACE_VIOLATED' if self.violations else 'UNKNOWN' if self.unknown else
                'INCOMPLETE_WINDOW' if tail or self.now<self.horizon else
                'TRACE_VACUOUS' if not self.pending else 'TRACE_SATISFIED')
        return {'status':status,'scope':'one trace, not all executions','trigger_horizon':self.horizon,
                'checked_until':self.now,'accepted':len(self.pending),'uncovered':len(tail),
                'violations':[list(x) for x in self.violations],'unknown_frames':copy.deepcopy(self.unknown)}
