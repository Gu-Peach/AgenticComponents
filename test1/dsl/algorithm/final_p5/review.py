"""Source-pinned conditional correspondence review, not a theorem prover."""
import ast
from pathlib import Path
from itertools import product
from collections import Counter,defaultdict
from .common import setup,read,read_rows,write,write_rows,sha,digest,seal,verify_files

RULES=[
 ('R01','Initial relation and executable bindings',['src/acverify_v3/model.py:initial_state','reference/state.py:initial','alignment_p52/input_bridge.py:compare_inputs'],
  'Both loaders bind the same executable AST meanings and raw contracts. Empty protocol initialization and registered locations establish R; missing cycle counters have the explicit zero interpretation.'),
 ('R02','Activation identity and cache coherence',['src/acverify_v3/model.py:activate','src/acverify_v3/channel.py:consume','src/acverify_v3/events.py:faults','reference/state.py:activate','reference/channel.py:deliver'],
  'Unique static node IDs and bounded loop paths make activation/request keys unique. Actor and epoch are fixed per token. Acceptance, enter, stop and fault caches are written with their receipts and reset on restart/stop; result-confirmed is retained explicitly in R.'),
 ('R03','Exogenous updates',['src/acverify_v3/events.py:apply_events','reference/environment.py:external'],
  'Same ordered events, due tick, carrier zones/conflicts, reservations, active-user and held-material guards, local/group capacity and epoch updates. Deferred events see unchanged guards under R.'),
 ('R04','Nondeterministic fault choices',['src/acverify_v3/events.py:faults','reference/environment.py:faults'],
  'Both include the no-fault choice and every legal token/queued-packet injection. Same global count, old-identity rewrite, FIFO stream, source timestamp, restart abort, permit loss and stop-confirmation suppression.'),
 ('R05','Held levels, sampling and FIFO',['src/acverify_v3/channel.py:emit','src/acverify_v3/channel.py:interested','src/acverify_v3/channel.py:sampling','src/acverify_v3/channel.py:delivery','reference/channel.py:emit','reference/channel.py:interested','reference/channel.py:sample','reference/channel.py:deliver'],
  'Sorted interested streams and identical finite latency products yield exactly the same dated packet lists. FIFO defers later packets until earlier packets are delivered/ignored. Epoch, Boolean type, identity and age tests agree on generated typed packets.'),
 ('R06','Control microsteps and cancellation',['src/acverify_v3/model.py:controller','src/acverify_v3/model.py:composite','src/acverify_v3/model.py:stop','reference/control.py:scan','reference/control.py:composite','reference/control.py:stop','reference/control.py:invoke','reference/control.py:control_scope'],
  'Same snapshot and eligible/node/path order. Each seq/par/repeat/branch/await/delay/fail rule, timeout ordering, atomic grant/capacity recheck and global cancellation agrees. New tasks are eligible next tick. Stop clocks are not reset on later abort scans. Normal scope exit waits for child success, current stop evidence and actual stop.'),
 ('R07','Device dates and capability effects',['src/acverify_v3/events.py:physical','src/acverify_v3/plant.py:effect','reference/transition.py:plant','reference/plant.py:effect'],
  'Both choose due=start+duration-1 on first visit and retain it. Sustaining conditions precede every physical phase; failure publishes held fault and schedules stop without applying action effects. Reviewed templates have the same effect arguments, next-stage date, source/target accounting and idempotent commit key.'),
 ('R08','Predicates in enabled call contexts',['src/acverify_v3/expressions.py:predicate','src/acverify_v3/expressions.py:world_expr','reference/plant.py:predicate','reference/properties.py:goal_value'],
  'Registered typed values, equal ledgers/claims and cache coherence make every enabled predicate equal. Two generalizations are explicitly excluded: run_command=None is unreachable from the admitted Boolean initial/command writers; no_processing on an isolated pending-stop token is never read by a new action because isolation implies global abort.'),
 ('R09','Retirement and terminal closure',['src/acverify_v3/model.py:retire','src/acverify_v3/model.py:controller','reference/state.py:retire','reference/control.py:scan'],
  'Delete inactive fields only after the token is terminal and no scheduled physical event remains. Preserve actor/epoch/owned resources and completion identity. Root failure/attention waits for all children and all physical events; late unused packets do not create new requests.'),
 ('R10','Property observation points',['src/acverify_v3/monitor.py:record','src/acverify_v3/monitor.py:state_checks','src/acverify_v3/monitor.py:on_success','src/acverify_v3/monitor.py:on_control_success','src/acverify_v3/monitor.py:on_isolation','reference/monitors.py:record','reference/monitors.py:state_checks','reference/control.py:finish'],
  'Capture, confirmation, evidence consumption, state checks, normal scope exit, failure-handler preservation and root-success observations occur at corresponding microsteps. Skipped repeated state checks after an invoke hold failure change no V04/V05/V06 field. Unknown remains uncovered, never a successful fact or fabricated violation.'),
 ('R11','History and response horizons',['src/acverify_v3/monitor.py:response_tick','src/acverify_v3/query.py:observed','src/acverify_v3/query.py:summarize','reference/monitors.py:bounded_response','certification/evidence_check.py:verdict_from_checked'],
  'First acceptance and earliest violation are never overwritten; terminal responses are observed before retirement. Passive histories reconstruct the reference trace event sequence. Filter each query by K, accepted cutoff C and check end E; no reset of environment state/fault budget at K. Empty legacy windows remain UNKNOWN.'),
 ('R12','Solver conclusions and strategies',['src/acverify_v3/search.py:explore','src/acverify_v3/search.py:replay','src/acverify_v3/pipeline.py:verify','src/acverify_v3/state_store.py:clone_state'],
  'Exact serialized states retain time/history; complete prefix exhaustion justifies bounded safety/unreachability, and finite closure is required for the implemented universal response result. Limits never justify absence. Portfolio merges only concrete positive witnesses within one search budget; copy/edge storage do not change successors.')]


def anchor(root,location):
    name,function=location.split(':');p=root/name;tree=ast.parse(p.read_text(encoding='utf8'))
    nodes=[n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==function]
    if len(nodes)!=1:raise ValueError('Ambiguous/missing source anchor: '+location)
    n=nodes[0]
    return dict(file=name,function=function,line=n.lineno,source_sha256=sha(p),ast_sha256=digest(ast.dump(n,include_attributes=False)))


def selector_values(root,file,function,selector):
    tree=ast.parse((root/file).read_text(encoding='utf8'));node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name==function)
    result=set()
    for n in ast.walk(node):
        if isinstance(n,ast.Compare) and isinstance(n.left,ast.Name) and n.left.id==selector:
            for c in n.comparators:
                if isinstance(c,ast.Constant) and isinstance(c.value,str):result.add(c.value)
                elif isinstance(c,(ast.Tuple,ast.List,ast.Set)):
                    result.update(v.value for v in c.elts if isinstance(v,ast.Constant) and isinstance(v.value,str))
    return result


def monitor_boundaries(workspace):
    setup(workspace)
    from acverify_v3.monitor import evidence_ok,stop_exit_valid,isolation_valid
    from reference.properties import evidence_valid,drive_exit,isolated,owner_ref
    counts=Counter();mismatches=[]
    for epoch,subject,act,request,valid,value,sampled,scoped in product([0,1],['M',None],['r','old'],['r','old'],[True,False,None],[True,False,None,1],[2,3,4,5,6],[False,True]):
        packet=dict(epoch=epoch,subject=subject,activation=act,request=request,valid=valid,value=value,sample_tick=sampled,provider='D')
        expected=dict(provider='D',epoch=0,subject='M',activation='r',request='r',request_scoped=scoped,value_type='bool')
        a=evidence_ok(packet,expected,5,2);b=evidence_valid(packet,expected,5,2);counts['V03_boolean_packets']+=1
        if a is not b:mismatches.append(dict(property='V03',packet=packet,expected=expected,sut=a,reference=b))
    req=dict(activation='r',request='r',device='D',subject=None,epoch=0)
    for sampled,epoch,request,drive,run,valid,value in product([1,3,4,5,6],[0,1],['r','old'],['stopped','moving',None],[False,True,None],[True,False,None],[True,False]):
        packet={**req,'epoch':epoch,'request':request,'provider':'D','valid':valid,'value':value,'sample_tick':sampled}
        command=dict(request='r',run=run,tick=3)
        frame=dict(request=req,stop_write=command,stop_ack=packet,current_epoch=0,actual_drive=drive,tick=5,max_age=2)
        a=stop_exit_valid(req,command,packet,0,drive,5,2);b=drive_exit(frame);counts['V07_stop_frames']+=1
        if a is not b:mismatches.append(dict(property='V07',frame=frame,sut=a,reference=b))
    for changed,required,held,terminal,expired in product([False,True],[[],['zone']],['r','other',None],['attention_required','confirmed_success','confirmed_failure','confirmed_cancel'],[True,False,None]):
        before={'M':'source'};after={'M':'target' if changed else 'source'};grants={} if held is None else {'zone':held}
        frame=dict(request=req,required_resources=required,grants=[] if held is None else [dict(resource='zone',owner=owner_ref({**req,'request':held,'activation':held}))],
                   terminal=terminal,deadline_expired=expired,before_affected_materials=before,after_affected_materials=after)
        a=isolation_valid(before,after,required,grants,'r',terminal,expired);b=isolated(frame);counts['V08_isolation_frames']+=1
        if a is not b:mismatches.append(dict(property='V08',frame=frame,sut=a,reference=b))
    return dict(counts=dict(counts),mismatches=mismatches,scope='Typed generated Boolean evidence domain and explicit boundary frames; no arbitrary IEC value-type claim.')


def domain(model):
    from certification_p4.invariants import catalog
    catalog(model);d=model.d;p=model.initial['plant']
    checks=dict(boolean_initial_commands=all(type(v['run_command']) is bool for v in p['devices'].values()),
                integer_epochs=all(type(v['epoch']) is int and v['epoch']>=0 for v in p['devices'].values()),
                registered_material_positions=all(m['region'] in d.locations and m['support'] in d.locations for m in p['materials'].values()),
                empty_initial_handoffs=not p['handoffs'],
                canonical_reserve_arguments=all(e['args']==['$material','$target','$request'] for a in d.actions.values() for phase in a['model']['phases'] for e in phase['effects'] if e['effect']=='reserve_target'))
    if not all(checks.values()):raise ValueError('Instance outside reviewed domain: '+str(checks))
    return checks


def run(workspace,recheck,trigger_dir,output,proof_document):
    workspace=setup(workspace)
    code_root=Path(__file__).resolve().parents[1]
    review_sources={p:sha(code_root/p) for p in ('final_p5/common.py','final_p5/review.py','final_p5/trigger_review.py','tools/admit_p53_review.py')}
    from alignment_p52.models import pair
    from alignment_p52.input_bridge import compare_inputs
    from alignment_p52.relation import canonical
    from acverify_v3.query import validate
    from alignment_p5.io import sources
    if output.exists():raise ValueError('Use a new P5.3 review directory')
    p4=workspace/'datasets/ac-path-v1/oracle/whole-line-p4-v1';p52=workspace/'artifacts/reference-p52/validation-v1';p51=workspace/'artifacts/reference-p5/alignment-v2'
    for root in (p4,p52,p51,recheck,trigger_dir):verify_files(root,read(root/'manifest.json')['files'])
    verify_files(workspace,read(p52/'manifest.json')['source_hashes'])
    if sources(workspace)!=read(p52/'manifest.json')['legacy_source_hashes']:raise ValueError('Frozen legacy/reference drift')
    if read(recheck/'summary.json')['conflicts'] or read(trigger_dir/'conflicts.json'):raise ValueError('Reference conflict')
    original=read_rows(p4/'answers.jsonl');repeated=read_rows(recheck/'answers.jsonl')
    old={r['query_id']:r for r in original};repeat={r['query_id']:r for r in repeated}
    if old.keys()!=repeat.keys():raise ValueError('Reference query scope changed')
    for qid,r in old.items():
        if any(r.get(k)!=repeat[qid].get(k) for k in ('truth_status','verdict','vacuous','trigger_reachability')):raise ValueError('Recheck changed original truth')
    output.mkdir(parents=True)
    (output/'review-argument.md').write_bytes(proof_document.read_bytes())
    for relative,expected in review_sources.items():
        destination=output/'provenance'/relative;destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes((code_root/relative).read_bytes())
        if sha(destination)!=expected:raise ValueError('Reviewer source changed during snapshot')
    scope=read(p51/'evaluation-scope.json')
    queries=[{**q,'comparison_admission':'ADMITTED_CONDITIONAL_REVIEW'} for q in scope['records']];groups=defaultdict(list)
    for q in queries:groups[q['case_id'],q['profile']].append(q)
    clauses=[dict(id=i,title=t,anchors=[anchor(workspace,l) for l in locs],argument=argument,status='REVIEWED_CONDITIONAL') for i,t,locs,argument in RULES]
    inventory={}
    for name,a,b in [('predicates',('src/acverify_v3/expressions.py','predicate','p'),('reference/plant.py','predicate','name')),
                     ('effects',('src/acverify_v3/plant.py','effect','op'),('reference/plant.py','effect','op')),
                     ('world_expressions',('src/acverify_v3/expressions.py','world_expr','op'),('reference/properties.py','goal_value','op'))]:
        left=selector_values(workspace,*a);right=selector_values(workspace,*b)
        if left!=right:raise ValueError('Operator inventory mismatch: '+name)
        inventory[name]=sorted(left)
    boundaries=monitor_boundaries(workspace)
    if boundaries['mismatches']:raise ValueError('Observation clause mismatch')
    records=[]
    for i,((cid,profile),qs) in enumerate(sorted(groups.items()),1):
        sut,ref=pair(workspace,cid,profile);checks=compare_inputs(sut,ref);validate(sut,qs)
        if not all(checks.values()) or canonical(sut.initial)!=canonical(ref.initial,True):raise ValueError('Input relation failed')
        premises=domain(ref)
        if any(q['model_digest']!=ref.model_digest or q['input_digest']!=ref.d.input_digest for q in qs):raise ValueError('Query binding drift')
        records.append(dict(case_id=cid,profile=profile,sut_model_digest=sut.model_digest,reference_model_digest=ref.model_digest,premises=premises))
        if i%180==0:print(dict(reviewed_instances=i,total=len(groups)),flush=True)
    policy=dict(id='p53-reviewed-correspondence/0.1',reviewer_type='AI_technical_review',
        proof_basis='Source-level conditional induction review with frozen anchors, per-instance premises and separate finite/mutation checks. Not a proof-assistant certificate.',
        clauses=clauses,operator_inventory=inventory,source_hashes=read(p52/'manifest.json')['source_hashes'],
        legacy_source_hashes=read(p52/'manifest.json')['legacy_source_hashes'],proof_document_sha256=sha(proof_document),
        reviewer_source_hashes=review_sources,domain_notes=['run_command remains Boolean under admitted writers.',
                      'An isolated process may differ under a direct no_processing call, but global abort prevents any enabled action from reading that predicate in this state.',
                      'Active transfer handoffs cannot refer to unspawned material under admitted initial states and phase effects.',
                      'Cancel is initialized False and has no runtime writer; all declared cancellation is global abort.',
                      'Unmodeled external intervention, geometry, arbitrary PLC programs and unregistered templates are outside this admission.'])
    write(output/'correspondence-review.json',policy);write(output/'instance-premises.json',records);write(output/'monitor-boundaries.json',boundaries)
    updates={r['query_id']:r for r in read(trigger_dir/'updates.json')};gold=[]
    for q in queries:
        r=dict(old[q['query_id']]);r['p4_source_verdict']=r['verdict'];r['p4_source_vacuous']=r['vacuous']
        if q['query_id'] in updates:
            u=updates[q['query_id']]
            if r['vacuous'] is not None or u['verdict_unchanged']!=r['verdict']:raise ValueError('Unauthorized gold change')
            r.update(vacuous=u['vacuous'],trigger_reachability=u['trigger_reachability'],p53_trigger_evidence=u['evidence'])
        r['comparison_role']=q['evaluation_role'];r['sut_comparison_eligible']=r['truth_status']=='CERTIFIED'
        r['nonvacuous_reference_answer']=r['truth_status']=='CERTIFIED' and r['vacuous'] is False
        gold.append(r)
    if any(r['truth_status'] not in ('CERTIFIED','NOT_APPLICABLE') for r in gold):raise ValueError('Selected view has unresolved truth')
    write_rows(output/'gold.jsonl',gold);write(output/'queries.json',dict(records=queries,records_digest=digest(queries),source_records_digest=scope['records_digest']))
    remaining=[dict(query_id=r['query_id'],case_id=r['case_id'],profile=r['profile'],property_id=r['property_id'],reason='Property truth certified, trigger undecided') for r in gold if r['truth_status']=='CERTIFIED' and r['vacuous'] is None]
    write(output/'remaining-obligations.json',dict(trigger_unknown=remaining,original_insufficient_windows=scope['original_window_obligations'],
        statistical_policy='Unknown triggers are retained in property accuracy and separately stratified; do not claim exercised failure coverage.',
        plc_baseline='NOT_CONFIGURED; no PLC-tool score is authorized'))
    gate=dict(id='p53-common-scope-admission/0.1',status='ADMITTED_CONDITIONAL_REVIEW',eligible_for_accuracy=True,
        query_records_digest=digest(queries),source_query_records_digest=scope['records_digest'],gold_sha256=sha(output/'gold.jsonl'),queries_sha256=sha(output/'queries.json'),
        source_hashes=policy['source_hashes'],legacy_source_hashes=policy['legacy_source_hashes'],
        p4_manifest_sha256=sha(p4/'manifest.json'),p52_manifest_sha256=sha(p52/'manifest.json'),
        trigger_review_manifest_sha256=sha(trigger_dir/'manifest.json'),reference_recheck_manifest_sha256=sha(recheck/'manifest.json'),
        proof_basis=policy['proof_basis'],allowed_methods=['none','storage','portfolio'],allowed_scope='Exact frozen 27495-query view only',
        not_claimed=['Unbounded Python equivalence proved mechanically','Arbitrary PLC controller correctness','Trigger completeness','PLC-tool comparison'])
    write(output/'gate.json',gate)
    summary=dict(stage='P5.3',queries=len(gold),truth_statuses=dict(Counter(r['truth_status'] for r in gold)),
        vacuity=dict(Counter(str(r['vacuous']) for r in gold if r['truth_status']=='CERTIFIED')),trigger_unknown=len(remaining),
        trigger_updates_in_view=sum('p53_trigger_evidence' in r for r in gold),instances=len(records),reviewed_clauses=len(clauses),
        monitor_boundary_frames=sum(boundaries['counts'].values()),source_verdicts_changed=0,gate=gate['status'])
    write(output/'summary.json',summary)
    verify_files(workspace,policy['source_hashes'])
    verify_files(code_root,review_sources)
    if sources(workspace)!=policy['legacy_source_hashes']:raise ValueError('Source changed during review')
    seal(output,stage='P5.3',reviewer_type='AI_technical_review',reference_manifest_sha256=sha(p4/'manifest.json'))
    print(summary,flush=True)
