"""Reproducible semantic boundary probes, explicitly separate from corpus gold."""
import copy
from .models import singleton, setup
from .projection import paired_trace, replay_pair


def hold_trace(workspace):
    sut, ref = singleton(workspace, 'S04-P01', one_action=True, feedback=3, fault='hold_permission_loss')
    trace = paired_trace(sut, ref, 30, 2, 'hold_permission_loss')
    return dict(id='D01-device-hold', scope='reachable_paired_trace_in_explicit_diagnostic_fixture',
        fixture=dict(case_id='S04-P01', one_action=True, feedback=3, fault='hold_permission_loss', fault_tick=2,
                     max_age=5, physical_intervals='lower endpoints'),
        trace=trace, replay=replay_pair(sut, ref, trace), status='DIFFERENT' if trace['status']=='DIVERGED' else 'NO_DIFFERENCE_IN_PROBE')


def pending_stop_trace(workspace):
    sut,ref=singleton(workspace,'S04-P01',one_action=True,fault='hold_permission_loss')
    data,env,d=copy.deepcopy(sut.data),copy.deepcopy(sut.profile),copy.deepcopy(ref.d)
    env['stop']=[5,5];d.profile['stop']=[5,5]
    for policies in (data['environment']['policies'],d.env['policies']):
        for policy in policies.values():policy['stop_ticks']=1
    from acverify.model import TransitionModel
    from reference.transition import ReferenceModel
    sut,ref=TransitionModel(data,env),ReferenceModel(d)
    trace=paired_trace(sut,ref,30,2,'hold_permission_loss')
    return dict(id='D10-pending-physical-stop',scope='reachable_paired_trace_in_explicit_diagnostic_fixture',
        fixture=dict(case_id='S04-P01',one_action=True,fault='hold_permission_loss',fault_tick=2,stop=[5,5],stop_ticks=1),
        trace=trace,replay=replay_pair(sut,ref,trace),status='DIFFERENT' if trace['status']=='DIVERGED' else 'NO_DIFFERENCE_IN_PROBE')


def component_probes(workspace):
    setup(workspace)
    from reference.environment import faults, external
    from reference.monitors import state_checks
    from reference.properties import drive_exit, isolated, goal_value
    from reference.state import world, request
    from acverify.properties import invariant_violations, edge_properties
    from acverify.expressions import world_expr
    probes = []

    sut, ref = singleton(workspace, 'S04-P01', one_action=True, feedback=3, fault='duplicate_same_request')
    prefix = paired_trace(sut, ref, 3)
    replay = replay_pair(sut, ref, prefix)
    a, b = copy.deepcopy(prefix['steps'][-1]['sut']), copy.deepcopy(prefix['steps'][-1]['reference'])
    a['tick'] += 1; b['tick'] += 1
    def origins(variants, inbox):
        result = []
        for state, events in variants:
            if any(e['kind']=='fault' and e['fault']=='duplicate_same_request' for e in events):
                packet = state[inbox][-1]
                result.append({k: packet[k] for k in ('request','kind','sample_tick')})
        return sorted(result, key=lambda p: (p['request'],p['kind'],p['sample_tick']))
    left, right = origins(sut.fault_variants(a, []), 'inbox'), origins(faults(ref.d, b, []), 'mail')
    probes.append(dict(id='D02-fault-packet-domain', scope='reachable_prefix_then_named_fault_phase',
        prefix=prefix, replay=replay, sut=left, reference=right, status='DIFFERENT' if left!=right else 'NO_DIFFERENCE_IN_PROBE'))

    sut, ref = singleton(workspace, 'S04-P01', one_action=True)
    mid = next(iter(sut.initial['world']['materials']))
    actor = next(iter(sut.actions.values()))['device']
    key = next(iter(sut.initial['tasks']))
    src = sut.actions[sut.ir['entry']]['arguments']['source']; carrier=sut.locations[src]['owner']
    target = sut.actions[sut.ir['entry']]['arguments']['target']
    zone = sut.locations[src]['zone_ref']; alias='diagnostic.conflicting_lease'
    event = dict(tick=1, kind='replace_carrier', carrier=carrier, materials=[mid], destination=target,
                 set_fact='replacement_complete', new_epoch=1)
    sut.profile['events']=[event]; ref.d.profile['events']=[copy.deepcopy(event)]
    sut.conflicts.add(frozenset((zone,alias)))
    ref.d.relations['resource_conflicts'].append([zone,alias])
    a,b=copy.deepcopy(sut.initial),copy.deepcopy(ref.initial)
    for s,w in ((a,'world'),(b,'plant')):
        s['tick']=1;s[w]['grants']={alias:'external-owner'}
        s[w]['external']={'replacement_complete':dict(value=False,valid=True,provider_epoch=0,sample_tick=0)}
    before_a,before_b=copy.deepcopy(a),copy.deepcopy(b)
    sut.apply_events(a,[]);external(ref.d,b,[])
    left=a['world']['materials'][mid]['region'];right=b['plant']['materials'][mid]['region']
    probes.append(dict(id='D03-external-conflict', scope='component_boundary_state_not_claimed_reachable',
        event=event, added_conflict=[zone,alias], sut_before=before_a, reference_before=before_b,
        sut=left,reference=right,status='DIFFERENT' if left!=right else 'NO_DIFFERENCE_IN_PROBE'))

    sut,ref=singleton(workspace,'S04-P01',one_action=True)
    a,b=copy.deepcopy(sut.initial),copy.deepcopy(ref.initial)
    a['world']['materials'][mid]['support']=target;b['plant']['materials'][mid]['support']=target
    log=[];state_checks(ref.d,b,log)
    left='V05' in invariant_violations(sut,a);right='V05' in b['violations']
    probes.append(dict(id='D04-handoff-clause',scope='monitor_boundary_state_not_claimed_reachable',
        sut_state=a,reference_state=b,reference_log=log,sut=left,reference=right,
        status='DIFFERENT' if left!=right else 'NO_DIFFERENCE_IN_PROBE'))

    req=request(ref.d,ref.initial,key)
    scope_req=dict(activation='feed@',request='feed@',device='C1',subject=None,epoch=0)
    packet={**scope_req,'provider':'C1','valid':True,'value':True,'sample_tick':1}
    frame=dict(kind='scope_success',tick=10,request=scope_req,stop_write=dict(request='feed@',run=False,tick=1),
               stop_ack=packet,current_epoch=0,actual_drive='stopped',max_age=2)
    event=dict(kind='control_succeeded',node=key,activation=key,ack=True,actual_stopped=True,
               stop_ack=packet,stop_write=frame['stop_write'],tick=10,max_age=2)
    left='V07' in edge_properties([event])[0];right=drive_exit(frame) is not True
    probes.append(dict(id='D05-stop-evidence-clause',scope='monitor_input_probe_not_claimed_reachable',
        sut_event=event,reference_frame=frame,sut=left,reference=right,status='DIFFERENT' if left!=right else 'NO_DIFFERENCE_IN_PROBE'))

    a=copy.deepcopy(sut.initial);before=copy.deepcopy(a['world']['materials'])
    for values in a['world']['occupancy'].values():
        if mid in values:values.remove(mid)
    a['world']['occupancy'][target].append(mid)
    a['world']['materials'][mid].update(region=target,support=target,holder=sut.locations[target]['owner'])
    a['tasks'][key].update(phase='attention',claims=[])
    frame=dict(kind='unknown_stop_handler',tick=10,request=req,required_resources=[],grants=[],
               terminal='attention_required',deadline_expired=True,
               before_affected_materials=before,after_affected_materials=a['world']['materials'])
    left='V08' in invariant_violations(sut,a);right=isolated(frame) is not True
    probes.append(dict(id='D06-isolation-preservation',scope='monitor_input_probe_not_claimed_reachable',
        sut_state=a,reference_frame=frame,sut=left,reference=right,status='DIFFERENT' if left!=right else 'NO_DIFFERENCE_IN_PROBE'))

    a,b=copy.deepcopy(sut.initial),copy.deepcopy(ref.initial)
    a['world']['devices'][actor]['drive']=None;b['plant']['devices'][actor]['drive']=None
    expr=dict(op='drive_stopped',device=actor)
    left=world_expr(sut,a,expr);right=goal_value(world(b),expr)
    probes.append(dict(id='D07-unknown-observation',scope='observation_boundary_probe_not_claimed_reachable',
        expression=expr,sut_state=a,reference_state=b,sut=left,reference=right,
        status='DIFFERENT' if left!=right or type(left)!=type(right) else 'NO_DIFFERENCE_IN_PROBE'))

    from certification.evidence_check import _response_violation
    a=copy.deepcopy(sut.initial);sut.data['queries']['response_window_ticks']=1
    a['tick']=12;a['tasks'][key].update(phase='requesting',accepted=True,accepted_tick=11)
    query=dict(property_id='V10b',bound_ticks=10,covered_trigger_cutoff=10,checked_until=13)
    events=[dict(kind='response_deadline_violation',request=key,accepted_at=11,deadline=12)]
    left='V10b' in invariant_violations(sut,a);right=_response_violation(events,query)
    probes.append(dict(id='D08-response-tail-filter',scope='query_adapter_probe_not_claimed_reachable',
        query=query,response_window_ticks=1,sut_state=a,reference_events=events,sut=left,reference=right,
        status='DIFFERENT' if left!=right else 'NO_DIFFERENCE_IN_PROBE',
        interpretation='Legacy monitor checks all accepted requests; proposed query excludes tail-only triggers. A query adapter is required, not relabeling.'))

    sut,ref=singleton(workspace,'S04-P01',one_action=True)
    prefix=paired_trace(sut,ref,2);replay=replay_pair(sut,ref,prefix)
    triggers=set()
    for step in prefix['steps'][1:]:triggers.update(edge_properties(step['sut_events'])[1])
    left={p:p in triggers for p in ('V02','V03')}
    right={p:p in prefix['steps'][-1]['reference']['triggered'] for p in ('V02','V03')}
    probes.append(dict(id='D09-property-trigger-points',scope='reachable_paired_prefix_protocol_monitor_probe',
        prefix=prefix,replay=replay,sut=left,reference=right,status='DIFFERENT' if left!=right else 'NO_DIFFERENCE_IN_PROBE'))
    return probes
