"""Bind raw cases through the separate reference parser, then freeze P2 inputs."""
from pathlib import Path
from types import SimpleNamespace
import sys
import math
from .common import clone,read,need,digest,duration

EFFECTS={'reserve_target','capture','clear_source','place_supported','release_tool','commit_transfer','emit_registered',
         'advance_to_exit','wrap_to_entry','increment_cycle','record_operation','clamp_workpiece','unclamp_workpiece',
         'begin_index','begin_lift','finish_index','finish_lift','publish_success'}
PREDICATES={'source_contains','source_unclamped','target_compatible','target_capacity','tool_empty','source_stationary','target_stationary',
 'interlock_valid','all_grants_valid','drive_stopped','subject_on_device','drive_authorized','subject_at_exit','result_matches',
 'transfer_committed','supported_at','at_location','location_owned_by','clamped','unclamped','access_closed','no_processing',
 'operation_recorded','tools_clear','target_index_valid','axis_target_valid','index_reached','level_reached','material_unspawned'}


def load(workspace,case_id,profile='nominal'):
    workspace=Path(workspace);sys.path.insert(0,str(workspace/'tools'))
    from build_standard_answers import Case
    case=Case(workspace/'datasets/ac-path-v1',case_id)
    d=SimpleNamespace(case_id=case_id,body=clone(case.body),nodes=clone(case.nodes),actions=clone(case.actions),
      devices=clone(case.devices),locations=clone(case.locations),controls=clone(case.controls),models=clone(case.models),
      conditions=clone(case.conditions),env=clone(case.env),initial=clone(case.initial),task=clone(case.task),
      properties=clone(case.properties),queries=clone(case.queries),relations=clone(case.relations),
      input_hashes=clone(case.hashes),descriptor=clone(case.descriptor))
    d.execution=read(case.root/'shared/execution-profiles/fixed-60hz.json')
    pilot=d.descriptor['schema_type']=='PilotCase'
    if pilot:
        q=next(p for p in d.queries['profiles'] if p['id']==profile)
        # A versioned migration, not a proof of synchronous-pilot equivalence.
        p={'accept':q['accept'],'phase':q['phase'],'stop':q['stop'],'feedback':[0,0],
           'faults':[],'max_faults':0,'forced_stop_loss':q['stop_loss_device']}
    else:
        q=read(case.root/'shared/environments'/(profile.split('@')[0]+'.json'))
        p={'accept':q['accept_delay_ticks'],'phase':q['phase_duration_ticks'],'stop':q['stop_delay_ticks'],
           'feedback':q['feedback_delay_ticks'],'faults':q['permitted_events'],
           'max_faults':q['max_fault_events_per_case'],'forced_stop_loss':None}
    p.update(max_age=d.execution['default_fact_max_age_ticks'],events=clone(d.env.get('events',[])),
             response_window=d.queries.get('response_window_ticks'),name=profile,
             timing_scope='reference-six-phase/0.1',source_scope=d.descriptor['profile_scope'],
             pilot_migration=pilot,visibility=1,fault_packet_selection='any_queued_packet')
    d.profile=p;validate(d)
    d.input_digest=digest({'files':d.input_hashes,'profile':p,'reference_semantics':'reference-six-phase/0.1'})
    return d


def validate(d):
    need(d.execution['step_seconds']=={'numerator':1,'denominator':60},'Only declared 60 Hz semantics supported')
    need(type(d.execution['max_transitions_per_tick']) is int and d.execution['max_transitions_per_tick']>0,'Invalid scan transition budget')
    known_expr={'all','any','not','at','holder','supported','tools_empty','drives_stopped','drive_stopped',
                'no_grants','no_active_requests','external','operation_count','cycle_count','unclamped','index_is'}
    def expression(e):
        need(type(e) is dict and e.get('op') in known_expr,'Unknown world expression')
        if e['op'] in ('all','any'):
            for item in e['args']:expression(item)
        elif e['op']=='not':expression(e['arg'])
    for e in d.env.get('observation_definitions',{}).values():expression(e)
    if 'op' in d.task['goal']:expression(d.task['goal'])
    registered={r['id'] for r in d.relations['resources']+d.env.get('auxiliary_resources',[])}
    registered.update(m['id']+'.claim' for m in d.initial['materials'])
    for a in d.actions.values():
        model=a['model']
        need(a['device'] in d.devices,'Unknown actor')
        need(set(a['args'])==set(model['parameters']),'Incomplete action arguments')
        for param,typ in model['parameters'].items():
            v=a['args'][param]
            need((type(v) is int if typ=='integer' else type(v) is str),'Wrong argument type')
            if typ=='material':need(v in {m['id'] for m in d.initial['materials']},'Unknown material')
            elif typ=='location':need(v in d.locations,'Unknown location')
            else:need(typ=='integer','Unknown parameter sort')
        phases=model['phases'];ids=[p['id'] for p in phases]
        need(ids and len(set(ids))==len(ids),'Nonlinear/empty phase graph')
        for i,p in enumerate(phases):
            need(p['successor']==(ids[i+1] if i+1<len(ids) else 'completed') and p['fault_successor']=='stopping','Unsupported phase successor')
            need(p.get('request_identity_preserved') is True,'Request identity not preserved')
            need(p['advance_when']=='environment_phase_response_within_profile','Unknown phase timing rule')
            need(all(e['effect'] in EFFECTS for e in p['effects']),'Unknown physical effect')
        for field in ('preconditions','sustaining_conditions','completion_conditions'):
            need(all(p['predicate'] in PREDICATES for p in model[field]),'Unknown predicate')
        need(all(o.get('preserve_effects') is True for o in model['failure_outcomes']),'Rollback failure contract unsupported')
    for n in d.nodes.values():
        need(n[0] in ('seq','par','repeat','branch','invoke','with-control','await','delay','fail'),'Unknown DSL node')
        if n[0]=='branch':need(n[2] in ('ordered','exclusive'),'Unknown branch mode');duration(n[3])
        elif n[0]=='await':duration(n[3])
        elif n[0]=='delay':duration(n[2:])
        elif n[0]=='repeat':need(type(n[2]) is str and n[2].isdigit() and int(n[2])<=10000,'Invalid repeat bound')
    for a in d.actions.values():
        if a['model']['id']=='transfer@0.1':
            need(any(e['device']==a['device'] and e['source']==a['args']['source'] and e['target']==a['args']['target']
                     for e in d.relations['transfer_edges']),'Undeclared transfer edge')
        if any(r.startswith('delegate:') for r in a['model']['resource_claims']):
            scope=a['scope'];need(scope in d.controls and d.controls[scope]['owner']==a['device'],'Invalid writer delegation')
            rule=d.models[d.controls[scope]['contract_ref']]['delegation']
            need(rule['inherit_only'] is True and a['behavior'] in rule.get('allowed_behaviors',[rule.get('allowed_behavior')]),'Capability not delegated')
        for r in a['model']['resource_claims']:
            if r=='target.capacity' or r.startswith('delegate:'):continue
            resolved=(a['args']['material']+'.claim' if r=='material.claim' else
                      d.locations[a['args'][r.split('.')[0]]]['zone_ref'] if r in ('source.zone','target.zone') else
                      a['device']+'.'+r.split('.')[1] if r.startswith('device.') else None)
            need(resolved in registered,'Undeclared action resource')
    for c in d.controls.values():
        need(c['writer'] in registered,'Undeclared writer')
        contract=d.models[c['contract_ref']];bounds=contract['parameters']['speed'];v=c['speed_m_s']
        need(type(v) in (int,float) and math.isfinite(v) and bounds['min']<=v<=bounds['max'],'Invalid drive speed')
        need(contract['enter']['writes']['run'] is True and contract['exit']['writes']['run'] is False,'Unknown control writes')
    for p in d.env['policies'].values():
        need(all(type(p[k]) is int and p[k]>0 for k in ('gate_ticks','accept_ticks','execute_ticks','stop_ticks')),'Invalid policy budget')
    for name in ('accept','phase','stop','feedback'):
        a,b=d.profile[name];need(type(a) is int and type(b) is int and (0 if name=='feedback' else 1)<=a<=b,'Invalid interval')
    for event in d.profile['events']:
        need(type(event['tick']) is int and event['tick']>=0,'Invalid event tick')
        need(event['kind'] in ('set_external','replace_carrier'),'Unknown external event')
        if event['kind']=='replace_carrier':need(event['destination'] in d.locations,'External destination undeclared')
    need(type(d.profile['max_faults']) is int and d.profile['max_faults']>=0,'Invalid fault budget')
    need(set(d.profile['faults'])<={'delayed_feedback','duplicate_same_request','old_request_feedback',
         'provider_restart','hold_permission_loss','missing_stop_confirmation'},'Unknown fault kind')
    need(type(d.profile['max_age']) is int and d.profile['max_age']>=0,'Invalid freshness bound')
    need(not any(r.get('rollback') for r in d.profile['events']),'Unsupported recovery')
    for dev in d.devices.values():need(type(dev['parameters']['capacity']) is int and dev['parameters']['capacity']>=1,'Invalid capacity')
