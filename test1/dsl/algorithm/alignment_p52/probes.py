"""Replay the P5.1 boundary recipes against the repaired engine."""
import copy
from .models import setup,fixture
from .relation import walk


def run(workspace):
    setup(workspace)
    from alignment_p5.diagnostics import component_probes
    from acverify_v3 import monitor
    from acverify_v3.expressions import world_expr
    from acverify_v3.query import observed
    old={r['id']:r for r in component_probes(workspace)}
    rows=[]
    for ident,options in [('D01-device-hold',dict(single=True,feedback=3,faults=['hold_permission_loss'])),
                          ('D10-pending-physical-stop',dict(single=True,faults=['hold_permission_loss'],stop=[5,5],stop_ticks=1))]:
        sut,ref=fixture(workspace,**options);trace=walk(sut,ref,128,2,'hold_permission_loss')
        rows.append(dict(id=ident,status='MATCH' if trace['status']=='MATCHED_TERMINAL' else 'DIFFERENT',
                         scope='reachable_diagnostic',trace=trace))
    sut,ref=fixture(workspace,single=True,feedback=3,faults=['duplicate_same_request'])
    p=walk(sut,ref,3);s=copy.deepcopy(p['trace'][-1]['sut']);s['tick']+=1
    samples=[]
    for state,log in sut.fault_variants(s,[]):
        if any(e['kind']=='fault' for e in log):samples.append({k:state['inbox'][-1][k] for k in ('request','kind','sample_tick')})
    q=old['D02-fault-packet-domain'];rows.append(dict(id=q['id'],status='MATCH' if samples==q['reference'] else 'DIFFERENT',sut=samples,reference=q['reference'],scope=q['scope']))
    for ident in ('D03-external-conflict','D04-handoff-clause','D05-stop-evidence-clause','D06-isolation-preservation','D07-unknown-observation','D08-response-tail-filter'):
        p=old[ident];sut,_=fixture(workspace,single=True);state=copy.deepcopy(sut.initial)
        if ident.startswith('D03'):
            state['tick']=p['sut_before']['tick'];state['world'].update(copy.deepcopy(p['sut_before']['world']))
            sut.profile['events']=[p['event']];sut.conflicts.add(frozenset(p['added_conflict']))
            sut.apply_events(state,[]);value=state['world']['materials']['M1']['region']
        elif ident.startswith('D04'):
            state['world'].update(copy.deepcopy(p['sut_state']['world']));monitor.state_checks(sut,state,[])
            value='V05' in state['violations']
        elif ident.startswith('D05'):
            f=p['reference_frame'];value=monitor.stop_exit_valid(f['request'],f['stop_write'],f['stop_ack'],f['current_epoch'],f['actual_drive'],f['tick'],f['max_age']) is not True
        elif ident.startswith('D06'):
            f=p['reference_frame'];value=monitor.isolation_valid(f['before_affected_materials'],f['after_affected_materials'],f['required_resources'],{},f['request']['request'],f['terminal'],f['deadline_expired']) is not True
        elif ident.startswith('D07'):
            state['world'].update(copy.deepcopy(p['sut_state']['world']));value=world_expr(sut,state,p['expression'])
        else:
            event=p['reference_events'][0];state['tick']=p['sut_state']['tick']
            state['acceptances']={event['request']:event['accepted_at']}
            state['response_violations']={event['request']:dict(accepted_at=event['accepted_at'],deadline=event['deadline'],tick=state['tick'])}
            value=observed(sut,state,{**p['query'],'applicability':'APPLICABLE'})['verdict']=='VIOLATED'
        rows.append(dict(id=ident,status='MATCH' if value==p['reference'] and type(value) is type(p['reference']) else 'DIFFERENT',
                         sut=value,reference=p['reference'],scope=p['scope']))
    sut,ref=fixture(workspace,single=True);p=walk(sut,ref,2);t=p['trace'][-1]['sut']['trigger_ticks']
    value={pid:pid in t for pid in ('V02','V03')};expected=old['D09-property-trigger-points']['reference']
    rows.append(dict(id='D09-property-trigger-points',status='MATCH' if value==expected else 'DIFFERENT',sut=value,reference=expected,scope='reachable_prefix'))
    return sorted(rows,key=lambda r:r['id'])
