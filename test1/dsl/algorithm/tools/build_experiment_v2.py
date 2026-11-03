"""Admission depends on independent evidence, never on tested-solver success."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def write(p,d):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def build(workspace,implementation,output):
    workspace=Path(workspace);implementation=Path(implementation);output=Path(output)
    sys.path[:0]=[str(workspace/'tools'),str(implementation/'tools')]
    from build_standard_answers import Case,logical_proofs,RefError
    from sequential_reference import SequentialReference,profile_for,certify
    from reference_channel_v2 import fixtures,enumerate_channel
    dataset=workspace/'datasets/ac-path-v1';old=dataset/'oracle/standard-answers-v1'
    spec=read(implementation/'specs/method1-semantics-v2.json');spec_hash=hashlib.sha256(json.dumps(spec,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    candidates=[json.loads(x) for x in (old/'answers.jsonl').read_text(encoding='utf-8').splitlines()]
    selected={};rejected=[]
    for a in candidates:
        if a['environment'].split('@')[0]!='nominal' or a['bound_ticks']!=3000 or a['property_id'] not in ('V09','V10a') or not a['accuracy_eligible']:continue
        selected.setdefault(a['case_id'],{})[a['property_id']]=a
    core=[];evidence={}
    for cid,answers in sorted(selected.items()):
        if set(answers)!={'V09','V10a'}:rejected.append({'case_id':cid,'reason':'not all selected business properties have reference answers'});continue
        case=Case(dataset,cid);proofs=logical_proofs(case);verified=[]
        for pid,a in answers.items():
            path=old/a['evidence'];record=read(path)
            if path.parent.name=='proofs':
                p=proofs.get(pid)
                if not p or p['verdict']!=a['verdict']:break
                verified.append({'property':pid,'expected':a['verdict'],'basis':'recomputed independent logical certificate'})
            else:
                witness=SequentialReference(case,profile_for(case,'nominal' if case.descriptor['schema_type']=='PilotCase' else 'nominal@0.1')).run()
                certify(case,witness)
                if witness['completion_tick']>3000:break
                candidate=('REACHABLE' if witness['independent_goal'] else 'UNREACHABLE') if pid=='V10a' else ('HOLDS' if witness['independent_goal'] else 'VIOLATED')
                if candidate!=a['verdict']:break
                # A witness proves existence/violation. Universal conclusions
                # require the independent v1 unique-success projection rule.
                if a['verdict'] in ('HOLDS','UNREACHABLE') and a['reason']!='unique_successful_sequential_goal_projection':break
                verified.append({'property':pid,'expected':a['verdict'],'basis':a['reason'],'completion_tick':witness['completion_tick']})
            evidence[cid+'|'+pid]={'source_evidence':str(path.relative_to(dataset)),'source_sha256':sha(path),
                'input_hashes':case.hashes,'semantics_hash':spec_hash,'feedback_alignment':'healthy witness/logical proof does not require one-shot-only behavior',
                'human_review':'pending','paper_gold_approved':False}
        if len(verified)!=2:rejected.append({'case_id':cid,'reason':'independent recertification failed'});continue
        core.append({'case_id':cid,'profile':'nominal','bound':3000,'properties':verified})
    ids=read(dataset/'manifest.json')['cases']
    valid=[c for c in ids if not c.rsplit('-',1)[-1].startswith('DS')]
    core_ids={x['case_id'] for x in core}
    write(output/'core.json',{'id':'method1-core/0.2','semantics_id':spec['id'],'semantics_hash':spec_hash,
        'property_scope':['V09','V10a'],'case_count':len(core),'query_count':len(core)*2,'cases':core,
        'admission':'Both selected query labels independently recertified before algorithm evaluation; no solver-outcome filtering.',
        'not_claimed':'Does not make all V01-V10 properties gold for these cases; no parallel/fault-case accuracy claims; human review pending.'})
    write(output/'evidence-index.json',evidence)
    write(output/'pressure.json',{'id':'method1-pressure/0.2','cases':valid,'case_count':len(valid),
        'without_complete_business_labels':sorted(set(valid)-core_ids),'accuracy_allowed':False,
        'admission_rejections':rejected,'profiles':['nominal','delayed','fault'],'purpose':'coverage, limits and performance; may overlap core cases'})
    static_ref=read(old/'static-answers.json')['records']
    static_labels={r['case_id']:('VALID' if r['verdict']=='WELL_FORMED_FOR_REFERENCE_SUBSET' else r['verdict']) for r in static_ref}
    write(output/'static.json',{'cases':ids,'expected_by_case':static_labels,
        'note':'Expected categories match independently checked v1 static records; runtime support errors are not syntax negatives.'})
    channels=[{'input':c,'expected':enumerate_channel(c)} for c in fixtures()]
    write(output/'protocol-core.json',{'id':'independent-channel-core/0.2','semantics_hash':spec_hash,'fixtures':channels,
        'query':'which ticks can first valid observation occur by the finite horizon?', 'source':'reference_channel_v2.py; no acverify imports'})
    write(output/'freeze.json',{'id':'method1-experiment/0.2','semantics_hash':spec_hash,'dataset_manifest_sha256':sha(dataset/'manifest.json'),
        'core_case_count':len(core),'core_query_count':len(core)*2,'protocol_fixtures':len(channels),'pressure_cases':len(valid),
        'input_hashes':{c:sha(dataset/'cases'/c/'dependencies.lock.json') for c in ids},
        'semantics_file_sha256':sha(implementation/'specs/method1-semantics-v2.json'),
        'evidence_boundary':'Reference-certified engineering core, not externally reviewed publication gold.'})
    print(json.dumps({'core_cases':len(core),'core_queries':len(core)*2,'protocol_fixtures':len(channels),'pressure_cases':len(valid)}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--implementation',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();build(a.workspace,a.implementation,a.output)
