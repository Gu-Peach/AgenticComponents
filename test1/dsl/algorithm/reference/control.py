"""Reference token interpreter. No production IR, controller, or reduction calls."""
from .common import clone,TERMINAL,duration,key
from .state import activate,request,world
from .plant import resources,authorized,reserve,release,can_release,predicates,available
from .observations import condition
from .monitors import record,grants,state_checks


def policy(d,t):
    n=d.nodes[t['node']]
    name=n[5][1] if n[0]=='invoke' else n[3][1] if n[0]=='with-control' else None
    return d.env['policies'][name] if name else d.execution['policy_templates']['normal']


def schedule(t,kind,start):
    t.update(hardware=kind,hardware_start=start,hardware_due=None)


def stop(d,s,k):
    t=s['tokens'][k];status=t['status'];kind=t['kind']
    if status in TERMINAL:return
    if kind in ('invoke','with-control'):
        if status in ('ready','gate'):
            release(s,k);t['status']='cancelled';return
        if status not in ('stopping','exiting'):
            t.update(status='stopping' if kind=='invoke' else 'exiting',stop_start=s['tick'],abort_exit=True)
            t['receipts'].pop('stop',None);schedule(t,'stop',s['tick'])
            if kind=='with-control':s['plant']['devices'][t['actor']].update(run_command=False,drive='decelerating')
    else:t['status']='cancelling' if t['children'] else 'cancelled'


def abort(d,s,k,reason):
    if s['abort'] is None:s['abort']=reason
    stop(d,s,k)


def finish(d,s,k,log):
    t=s['tokens'][k];a=d.actions[t['node']];args=a['args']
    target=args.get('target',a['device']+'.exit' if a['model']['id'] in ('transport@0.1','circulate@0.1') else args.get('location'))
    record(d,s,'V02',{'kind':'confirm_success','tick':s['tick'],'request':request(d,s,k),
        'accepted':{**request(d,s,k),'observed':'accepted' in t['receipts']},'feedback':t['receipts']['result']['packet']},log)
    s['completed'][k]={'material':args.get('material'),'target':target,'epoch':t['epoch'],'request':k}
    release(s,k);t['status']='ok';t['hardware']=None
    log.append({'kind':'invoke_succeeded','request':k})


def invoke(d,s,snapshot,k,log):
    t=s['tokens'][k];status=t['status'];p=policy(d,t);now=s['tick']
    if status in ('waiting_accept','executing') and 'fault' in t['receipts']:
        abort(d,s,k,'device_fault:'+k);return
    if status in ('ready','gate'):
        t['status']='gate';args=d.actions[t['node']]['args'];wanted=resources(d,s,k)
        pre=predicates(d,snapshot,k,'preconditions')
        if pre is True and authorized(d,s,wanted,k) and ('target' not in args or available(d,s,args['target'],k)):
            s['plant']['grants'].update({r:k for r in wanted});t.update(owned=wanted,status='waiting_accept',submitted=now)
            reserve(d,s,k);schedule(t,'accept',now);log.append({'kind':'submit','request':k})
        elif now>=t['born']+p['gate_ticks']:abort(d,s,k,'gate_timeout:'+k)
    elif status=='waiting_accept':
        if 'rejected' in t['receipts']:abort(d,s,k,'rejected:'+k)
        elif 'accepted' in t['receipts']:
            if predicates(d,snapshot,k,'sustaining_conditions') is not True:abort(d,s,k,'hold_failed:'+k)
            else:t.update(status='executing',execution_start=now)
        elif now>=t['submitted']+p['accept_ticks']:abort(d,s,k,'accept_timeout:'+k)
    elif status=='executing':
        if predicates(d,snapshot,k,'sustaining_conditions') is not True:abort(d,s,k,'hold_failed:'+k)
        elif t.get('result_confirmed') and predicates(d,s,k,'completion_conditions') is True:finish(d,s,k,log)
        elif now>=t['execution_start']+p['execute_ticks']:abort(d,s,k,'execution_timeout:'+k)
    elif status=='stopping':
        if 'stop' in t['receipts'] and s['plant']['devices'][t['actor']]['drive']=='stopped':
            if can_release(d,s,k):release(s,k);t['status']='failed'
            else:t['status']='isolated'
        elif now>=t['stop_start']+p['stop_ticks']:t['status']='isolated'


def control_scope(d,s,snapshot,k,log):
    t=s['tokens'][k];n=d.nodes[t['node']];c=d.controls[d.env['controls'][n[2]]];p=policy(d,t);now=s['tick']
    status=t['status'];device=s['plant']['devices'][t['actor']]
    if status in ('entering','body') and snapshot['plant']['devices'][t['actor']]['permit'] is not True:
        abort(d,s,k,'control_hold_failed:'+k);return
    if status in ('ready','gate'):
        t['status']='gate'
        if snapshot['plant']['devices'][t['actor']]['permit'] is True and authorized(d,s,[c['writer']],k):
            t.update(status='entering',enter_start=now,owned=[c['writer']]);s['plant']['grants'][c['writer']]=k
            device['run_command']=True;schedule(t,'enter',now)
        elif now>=t['born']+p['gate_ticks']:abort(d,s,k,'control_gate_timeout:'+k)
    elif status=='entering':
        if 'enter' in t['receipts'] and snapshot['plant']['devices'][t['actor']]['drive']=='moving':
            t['status']='body';activate(d,s,n[4][1],t['path'],k,k)
        elif now>=t['enter_start']+p['accept_ticks']:abort(d,s,k,'control_enter_timeout:'+k)
    elif status=='body':
        child=s['tokens'][t['children'][0]]
        if child['status']=='ok':
            t.update(status='exiting',stop_start=now,abort_exit=False);t['receipts'].pop('stop',None)
            device.update(run_command=False,drive='decelerating');schedule(t,'stop',now)
        elif child['status'] in TERMINAL:abort(d,s,k,'control_child_failed:'+k)
    elif status=='exiting':
        settled=all(s['tokens'][ch]['status'] in TERMINAL for ch in t['children'])
        if 'stop' in t['receipts'] and snapshot['plant']['devices'][t['actor']]['drive']=='stopped' and settled:
            if not t.get('abort_exit'):
                ack=t['receipts']['stop']['packet']
                record(d,s,'V07',{'kind':'scope_success','tick':now,'request':request(d,s,k),
                    'stop_write':{'request':k,'run':False,'tick':t['stop_start']},'stop_ack':ack,
                    'current_epoch':device['epoch'],'actual_drive':device['drive'],'max_age':d.profile['max_age']},log)
            release(s,k);t['status']='failed' if t.get('abort_exit') else 'ok'
        elif now>=t['stop_start']+p['stop_ticks']:
            t['status']='isolated';s['abort']=s['abort'] or 'control_stop_unknown:'+k


def composite(d,s,snapshot,k,log):
    t=s['tokens'][k];n=d.nodes[t['node']];kind=n[0];now=s['tick']
    if t['status']=='ready':
        t.update(status='body',position=0)
        if kind=='seq':activate(d,s,n[2][1],t['path'],k,t['scope'])
        elif kind=='par':
            for child in n[2:]:activate(d,s,child[1],t['path'],k,t['scope'])
        elif kind=='repeat':
            if int(n[2])==0:t['status']='ok'
            else:activate(d,s,n[3][1],t['path']+[0],k,t['scope'])
        else:t['status']='choosing'
        return
    if kind=='branch' and t['status']=='choosing':
        values=[condition(d,snapshot,c[1],t['path'],log,s) for c in n[4:-1]];choice=None
        if n[2]=='exclusive':
            if values.count(True)>1:abort(d,s,k,'exclusive_conflict:'+k);return
            if None not in values:choice=values.index(True) if True in values else len(values)
        else:
            for i,v in enumerate(values):
                if v is None:break
                if v is True:choice=i;break
            else:choice=len(values)
        if choice is not None:
            t['status']='body';activate(d,s,n[4+choice][-1][1],t['path'],k,t['scope'])
        elif now>=t['born']+duration(n[3]):abort(d,s,k,'branch_timeout:'+k)
        return
    statuses=[s['tokens'][ch]['status'] for ch in t['children']]
    if any(x in TERMINAL-{'ok'} for x in statuses):abort(d,s,k,'child_failed:'+k);return
    if not statuses or not all(x=='ok' for x in statuses):return
    if kind=='seq' and t['position']+3<len(n):
        t['position']+=1;activate(d,s,n[2+t['position']][1],t['path'],k,t['scope'])
    elif kind=='repeat' and t['position']+1<int(n[2]):
        t['position']+=1;activate(d,s,n[3][1],t['path']+[t['position']],k,t['scope'])
    else:t['status']='ok'


def scan(d,s,log):
    snapshot=clone(s);now=s['tick']
    keys=sorted(s['tokens'],key=lambda k:(s['tokens'][k].get('eligible',-1),s['tokens'][k]['node'],s['tokens'][k]['path']))
    for k in keys:
        t=s['tokens'][k]
        if t['status'] in TERMINAL or now<t['eligible']:continue
        if s['abort']:stop(d,s,k)
        if t['status'] in TERMINAL:continue
        if t['status']=='cancelling':
            if all(s['tokens'][ch]['status'] in TERMINAL for ch in t['children']):t['status']='failed'
        elif t['kind']=='invoke':invoke(d,s,snapshot,k,log)
        elif t['kind']=='with-control':control_scope(d,s,snapshot,k,log)
        elif t['kind'] in ('seq','par','branch','repeat'):composite(d,s,snapshot,k,log)
        elif t['kind']=='fail':abort(d,s,k,'explicit_fail:'+d.nodes[t['node']][2])
        elif t['kind']=='delay':
            if now>=t['born']+max(1,duration(d.nodes[t['node']][2:])):t['status']='ok'
        elif t['kind']=='await':
            n=d.nodes[t['node']];value=condition(d,snapshot,n[2],t['path'],log,s)
            log.append({'kind':'condition','node':t['node'],'value':value})
            if value is True:t['status']='ok'
            elif now>=t['born']+duration(n[3]):abort(d,s,k,'await_timeout:'+k)
        state_checks(d,s,log)
    changes=len(s['tokens'])-len(snapshot['tokens'])+sum(s['tokens'][k]['status']!=t['status'] for k,t in snapshot['tokens'].items())
    if changes>d.execution['max_transitions_per_tick']:s['abort']='E_STEP_BUDGET'
    if s['abort']:
        before=clone(s['plant']['materials'])
        for k in list(s['tokens']):stop(d,s,k)
        for k,t in s['tokens'].items():
            if t['status']=='isolated':
                record(d,s,'V08',{'kind':'unknown_stop_handler','tick':now,'request':request(d,s,k),
                    'required_resources':t['owned'],'grants':grants(d,s),'terminal':'attention_required','deadline_expired':True,
                    'before_affected_materials':before,'after_affected_materials':s['plant']['materials']},log)
    root=s['tokens'][key(d.body[1],[])]
    if root['status']=='ok' and not s['abort']:
        s['outcome']='succeeded';record(d,s,'V09',{'kind':'root_success','tick':now,'world':world(s)},log)
    if s['abort'] and all(t['status'] in TERMINAL for t in s['tokens'].values()) and not any(t.get('hardware') for t in s['tokens'].values()):
        s['outcome']='attention_required' if any(t['status']=='isolated' for t in s['tokens'].values()) else 'failed'
