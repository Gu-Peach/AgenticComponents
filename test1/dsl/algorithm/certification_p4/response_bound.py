"""Sufficient per-request response bound under fresh, fault-free feedback."""
from .invariants import catalog,material_domains,control_fences,drive_fences
from certification.evidence_check import require


def derive(model):
    catalog(model);d=model.d;p=d.profile
    require(p['response_window'] is not None,'No declared response property')
    require(p['max_faults']==0 and p['forced_stop_loss'] is None,'Packet/restart/confirmation faults not covered')
    latency=1+p['feedback'][1]
    require(latency<=p['max_age'],'Fresh arrival not guaranteed')
    material_domains(model);control_fences(model);drive_fences(model)
    require(all(not dev['operation_history'] for dev in model.initial['plant']['devices'].values()),'Initial operation request collision not ruled out')
    bounds={}
    for node,a in d.actions.items():
        policy=d.env['policies'][d.nodes[node][5][1]]
        # Before acknowledgement, actuator work may already have progressed.
        # Conservatively charge all remaining phases, two deliveries and two
        # controller boundaries; after any abort, stop timeout bounds isolation.
        normal_or_abort=len(a['model']['phases'])*p['phase'][1]+2*latency+4
        bound=normal_or_abort+policy['stop_ticks']+2
        require(bound<=p['response_window'],'Response window below sufficient bound')
        bounds[node]={'phase_bound':len(a['model']['phases'])*p['phase'][1],
          'visibility_and_delivery_bound':latency,'normal_or_abort_bound':normal_or_abort,
          'stop_or_isolation_bound':policy['stop_ticks']+2,'total_bound':bound}
    return {'bounds':bounds,'no_optional_faults':True,'fresh_latency_bound':latency,
            'max_age':p['max_age'],'response_window':p['response_window'],
            'premises':'reviewed phase templates; stable completion fields protected by leases and external quiescence; global abort never resets stop clocks',
            'scope':'relative response deadline for all accepted requests in the frozen reference model'}


def generate(model):return {'kind':'p4_response_bound/0.1','model_digest':model.model_digest,'derivation':derive(model)}
def check(model,payload):
    require(payload['model_digest']==model.model_digest,'Response proof model differs')
    expected=derive(model);require(expected==payload['derivation'],'Response bound/premises changed');return expected
def verdict(query,checked):
    if query['property_id']!='V10b':return {'verdict':None,'reason':'OTHER_PROPERTY'}
    if query.get('covered_trigger_cutoff',0)<1:return {'verdict':None,'reason':'NO_FULL_RESPONSE_WINDOW'}
    return {'verdict':'HOLDS','scope':'contract_compositional_response_bound','proof_class':'timed_contract_bound',
            'response_upper_bound':max((b['total_bound'] for b in checked['bounds'].values()),default=0),
            'vacuous':True if not checked['bounds'] else None,'trigger_reachability':'UNREACHABLE' if not checked['bounds'] else 'UNKNOWN'}
