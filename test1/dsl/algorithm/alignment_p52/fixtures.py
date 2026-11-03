"""Finite diagnostics are separate from the unchanged corpus query set."""
import copy
from .models import fixture,setup


def definitions(workspace):
    setup(workspace)
    from acverify_v3.model import TransitionModel
    from reference.transition import ReferenceModel
    plans=[
        dict(id='transfer',single=True),
        dict(id='parallel_failure',single=True,special='parallel_failure'),
        dict(id='exclusive_conflict',case='S01-P01-DV04',single=True,special='exclusive'),
        dict(id='physical_interval',single=True,variable='phase'),
        dict(id='accept_interval',single=True,variable='accept'),
        dict(id='message_interval',single=True,variable='feedback'),
        dict(id='stop_interval',single=True,faults=['hold_permission_loss'],variable='stop'),
        dict(id='packet_faults',single=True,feedback=3,faults=['duplicate_same_request','old_request_feedback']),
        dict(id='restart_and_hold',single=True,feedback=3,faults=['provider_restart','hold_permission_loss']),
        dict(id='lost_stop',single=True,faults=['hold_permission_loss','missing_stop_confirmation'],max_faults=2),
        dict(id='parallel',case='S01-P05'),
        dict(id='parallel_restart',case='S01-P05',faults=['provider_restart']),
        dict(id='ordered_branch',case='S01-P02'),
        dict(id='empty_branch',case='S10-P03-DV04'),
        dict(id='external_carrier',case='S04-P04'),
        dict(id='indexing',case='S12-P04'),
        dict(id='processing',case='S12-P03'),
        dict(id='transfer_index_pipeline',case='S06-P01'),
        dict(id='lifting',case='S07-P01'),
        dict(id='repeat_circulation',case='S03-P02')]
    for plan in plans:
        options={k:v for k,v in plan.items() if k in ('single','feedback','case','faults')}
        sut,ref=fixture(workspace,**options)
        data,env,d=copy.deepcopy(sut.data),copy.deepcopy(sut.profile),copy.deepcopy(ref.d)
        if plan.get('special')=='parallel_failure':
            node=data['ir']['entry'];first=data['ir']['nodes'][0]
            data['ir']['entry']='both';data['ir']['nodes']=[first,
                dict(node_id='both',kind='par',children=[node,'later']),
                dict(node_id='later',kind='seq',children=['wait','fail']),
                dict(node_id='wait',kind='delay',duration=dict(value=4,unit='ms')),
                dict(node_id='fail',kind='fail',code='DIAGNOSTIC')]
            from reference.fixtures import set_program
            set_program(d,['par','both',d.body,['seq','later',['delay','wait','4','ms'],['fail','fail','DIAGNOSTIC']]])
        elif plan.get('special')=='exclusive':
            guard=dict(kind='ref',condition_ref='weak_finish');data['ir']['entry']='choice'
            data['ir']['nodes']=[dict(node_id='choice',kind='branch',mode='exclusive',timeout=dict(value=1,unit='s'),
                cases=[dict(condition=guard,child='left'),dict(condition=guard,child='right')],otherwise='other'),
                *[dict(node_id=n,kind='delay',duration=dict(value=0,unit='ms')) for n in ('left','right','other')]]
            data['resolved']={}
            from reference.fixtures import set_program
            set_program(d,['branch','choice','exclusive',['timeout','1','s'],
                ['case',['condition','weak_finish'],['delay','left','0','ms']],
                ['case',['condition','weak_finish'],['delay','right','0','ms']],['else',['delay','other','0','ms']]])
        for policies in (data['environment']['policies'],d.env['policies']):
            for p in policies.values():p.update(gate_ticks=24,accept_ticks=8,execute_ticks=32,stop_ticks=8)
        if 'variable' in plan:
            field=plan['variable'];values=[0,1] if field=='feedback' else [1,2]
            env[field]=values;d.profile[field]=values
        if 'max_faults' in plan:env['max_faults']=plan['max_faults'];d.profile['max_faults']=plan['max_faults']
        data['queries']['response_window_ticks']=40;d.queries['response_window_ticks']=40;d.profile['response_window']=40
        yield plan,TransitionModel(data,env),ReferenceModel(d)


def diagnostic_queries(sut,ref):
    from acverify_v3.properties import IDS
    from certification.binding import make_query
    from reference.common import digest
    from pathlib import Path
    import json
    import reference.properties
    spec=json.loads((Path(reference.properties.__file__).parent/'specs/property-spec.json').read_text(encoding='utf8'))
    result=[]
    for k in (2,16,128):
        for pid in IDS:
            source=dict(query_id=f'diagnostic:{pid}:{k}',case_id=ref.d.case_id,profile=ref.d.profile['name'],property_id=pid,
                bound_ticks=k,applicability='APPLICABLE',profile_scope='p5.2-finite-diagnostic',property_version='p5.2-test')
            if pid=='V10b':source.update(response_window_ticks=40,tail_policy='cover_triggers_through_K_extend_checks',covered_trigger_cutoff=k,checked_until=k+40)
            else:source.update(checked_until=k)
            result.append(make_query(source,ref,digest(spec)))
    return result


def compare_queries(sut,ref,seconds=20):
    from certification.construct import graph
    from certification.binding import resolve_many
    from acverify_v3.search import explore
    queries=diagnostic_queries(sut,ref)
    reference_graph,stats=graph(ref,bound=168,seconds=seconds)
    if reference_graph is None or not stats['finite_model_closed']:
        return dict(status='LIMIT',reference=stats)
    gold,receipt=resolve_many(ref,queries,reference_graph)
    actual=explore(sut,queries,seconds=seconds,state_limit=30000)
    mismatches=[]
    for q,a,b in zip(queries,actual['results'],gold):
        expected=b['verdict'] or 'UNKNOWN'
        if a['verdict']!=expected or a.get('vacuous')!=b.get('vacuous') or a.get('trigger_reachability')!=b.get('trigger_reachability','UNKNOWN'):
            mismatches.append(dict(property=q['property_id'],bound=q['bound_ticks'],actual=a,reference=b))
    return dict(status='MATCH' if not mismatches else 'DIFFERENT',queries=len(queries),mismatches=mismatches,
                reference_check=receipt,sut_statistics=actual['statistics'],reference_statistics=stats)
