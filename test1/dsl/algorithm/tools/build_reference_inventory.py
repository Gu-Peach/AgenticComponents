"""Normalize declared queries without importing the tested verifier or its results."""
import argparse
import ast
from collections import Counter,defaultdict
import hashlib
import itertools
import json
from pathlib import Path
import sys

BASE=Path(__file__).resolve().parents[1]
def read(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def write(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf8')


def applicability(case,pid):
    kinds={a['model']['id'] for a in case.actions.values()}
    constructs={n[0] for n in case.nodes.values()}
    if pid=='V01':return 'transfer@0.1' in kinds,'transfer capability occurs syntactically; reachability not assumed'
    if pid=='V07':return 'with-control' in constructs,'drive scope occurs syntactically; reachability not assumed'
    if pid in ('V02','V08','V10b'):return bool(case.actions) or 'with-control' in constructs,'request/control protocol domain'
    if pid=='V03':return bool(case.actions) or bool(case.conditions) or 'with-control' in constructs,'evidence consumption domain'
    if pid=='V04':return bool(case.relations['resources']),'declared authorization resources'
    if pid=='V05':return bool(case.initial['materials']),'declared material domain'
    if pid=='V06':return any('capacity' in d['parameters'] for d in case.devices.values()),'declared capacity domains'
    if pid in ('V09','V10a'):return True,'valid candidate process and independent TaskSpec'
    raise ValueError('Unknown property '+pid)


def build(a):
    if a.output.exists() and any(a.output.iterdir()):
        raise ValueError('Output is nonempty; use a new version/draft directory')
    sys.path.insert(0,str(a.workspace/'tools'))
    from build_standard_answers import Case,RefError
    dataset=a.workspace/'datasets/ac-path-v1';spec=read(BASE/'reference/specs/property-spec.json')
    semantics=read(a.workspace/'specs/method1-semantics-v2.json')
    ids=read(dataset/'manifest.json')['cases'];rows=[];extensions=[];cases={};static=[];drifts=[];changes=[];vacuity_risks=[]
    sha_cache={}
    def sha(p):
        p=Path(p).resolve()
        if p not in sha_cache:sha_cache[p]=hashlib.sha256(p.read_bytes()).hexdigest()
        return sha_cache[p]
    known={p['id'] for p in spec['properties']};seen=set();legacy_seen=set()
    for cid in ids:
        folder=dataset/'cases'/cid;descriptor=read(folder/'case.json')
        lock=read(folder/descriptor['dependency_lock']);lock_drift=[]
        roots={'dataset':dataset,'tool':a.workspace/'tools','dsl':a.workspace.parent}
        for entry in lock['files']:
            root=roots[entry['root']].resolve();path=(root/entry['path']).resolve()
            if not path.is_relative_to(root):raise ValueError('Escaping locked dependency')
            actual=sha(path)
            if actual!=entry['sha256']:
                lock_drift.append({'root':entry['root'],'path':entry['path'],'expected':entry['sha256'],'actual':actual})
        if lock_drift:drifts.append({'case_id':cid,'files':lock_drift})
        try:case=Case(dataset,cid)
        except RefError as error:
            static.append({'case_id':cid,'classification':error.code,'reason':str(error),'dynamic_queries':False})
            continue
        static.append({'case_id':cid,'classification':'REFERENCE_FRONTEND_ACCEPTED','dynamic_queries':True})
        pilot=descriptor['schema_type']=='PilotCase';q=case.queries
        profiles=q['profiles'] if pilot else [read(dataset/'shared/environments'/(name.split('@')[0]+'.json')) for name in q['environments']]
        profile_by_id={p['id']:p for p in profiles}
        bounds=[q['bound_ticks']] if pilot else q['bounds_ticks']
        props=case.properties['properties']
        if len({p['id'] for p in props})!=len(props) or any(p['id'] not in known for p in props):raise ValueError('Duplicate/unknown property '+cid)
        dependencies=dict(case.hashes)
        dependencies.update({'case_descriptor':sha(folder/'case.json'),'dependency_lock':sha(folder/descriptor['dependency_lock'])})
        cases[cid]={'scene':descriptor['scene_id'],'parent_id':descriptor['parent_id'],'split':descriptor.get('split'),
          'input_hashes':dependencies,'input_digest':digest(dependencies),'task_digest':sha(case.paths['task']),
          'contract_digest':digest({k:v for k,v in dependencies.items() if k.startswith('shared/')}),
          'constructs':dict(Counter(n[0] for n in case.nodes.values())),
          'capability_models':sorted(case.used_models),'declared_properties':[p['id'] for p in props],
          'not_declared_properties':sorted(known-{p['id'] for p in props}),'scope':descriptor['profile_scope']}
        pairs=[(name,k,'declared_query_plan') for name,k in itertools.product(profile_by_id,bounds)]
        pairs += [(name,3000,'supplement_nominal_K3000') for name in profile_by_id if name.split('@')[0]=='nominal' and 3000 not in bounds]
        for name,k,origin in pairs:
            for prop in props:
                pid=prop['id'];declared=prop.get('applicable',True);actual,reason=applicability(case,pid)
                if type(declared) is not bool:raise ValueError('Nonboolean applicability')
                legacy=(cid,name.split('@')[0],k,pid)
                if legacy in legacy_seen:raise ValueError('Duplicate legacy query '+str(legacy))
                legacy_seen.add(legacy)
                # A mutation removing a call does not remove the original
                # task's obligation. It raises vacuity risk, not automatic N/A.
                mismatched=not declared and actual
                if mismatched:changes.append({'case':cid,'property':pid,'declared':declared,'inferred':actual,'reason':reason})
                if declared and not actual:vacuity_risks.append({'case':cid,'property':pid,'profile':name,'bound':k,'reason':'NO_SYNTACTIC_TRIGGER; applicability preserved'})
                mapping=[]
                if pilot:mapping.append('P1-PILOT-TIMING-BRIDGE')
                if mismatched:mapping.append('P1-APPLICABILITY-REVIEW')
                if lock_drift:mapping.append('P1-DEPENDENCY-DRIFT')
                row={'case_id':cid,'profile_id':name,'profile':name.split('@')[0],
                    'profile_scope':descriptor['profile_scope'],'profile_digest':digest(profile_by_id[name]),
                    'bound_ticks':k,'property_id':pid,'semantic_version':semantics['id'],
                    'property_version':spec['pilot_legacy']['version'] if pilot else spec['id'],
                    'property_spec_digest':digest(spec),'semantics_digest':digest(semantics),'input_digest':cases[cid]['input_digest'],
                    'task_digest':cases[cid]['task_digest'],'contract_digest':cases[cid]['contract_digest'],
                    'origin':origin,'declared_applicability':declared,'syntactic_trigger_possible':actual,
                    'applicability':'REVIEW_REQUIRED' if mismatched else 'APPLICABLE' if declared else 'NOT_APPLICABLE',
                    'applicability_reason':'Preserve declared task scope; '+reason,'trigger_reachability':'UNKNOWN_NOT_SEARCHED','vacuous':None,
                    'vacuity_risk':declared and not actual,
                    'readiness':'NOT_APPLICABLE' if not declared and not mismatched else 'BLOCKED_MAPPING' if mapping else 'READY_FOR_P2',
                    'blocking_issues':mapping,'truth_status':'NOT_CONSTRUCTED','verdict':None}
                if pid=='V10b':
                    row.update(response_window_ticks=q['response_window_ticks'],
                        tail_policy='legacy_full_windows_only_report_uncovered',declared_tail_policy=q['tail_policy'],
                        trigger_horizon=k,covered_trigger_cutoff=max(-1,k-q['response_window_ticks']),checked_until=k,
                        full_response_window_possible=k>q['response_window_ticks'])
                row['query_id']=digest({key:row[key] for key in ('case_id','profile_id','profile_scope','profile_digest','bound_ticks',
                    'property_id','semantic_version','semantics_digest','property_version','property_spec_digest','input_digest')}|{'tail_policy':row.get('tail_policy')})
                if row['query_id'] in seen:raise ValueError('Duplicate query identity')
                seen.add(row['query_id']);rows.append(row)
                if pid=='V10b':
                    expanded={**row,'origin_query_id':row['query_id'],'origin':'proposed_response_tail_extension',
                              'tail_policy':'cover_triggers_through_K_extend_checks','checked_until':k+row['response_window_ticks'],
                              'readiness':'PROPOSED_REQUIRES_P2_ENVIRONMENT_EXTENSION','blocking_issues':['P1-TAIL-EXTENSION'],
                              'environment_continuation':'same fault budget and rules; no implicit recovery or silent removal of faults'}
                    expanded['covered_trigger_cutoff']=k
                    expanded['full_response_window_possible']=True
                    expanded['query_id']=digest({'original':row['query_id'],'tail_policy':expanded['tail_policy'],'checked_until':expanded['checked_until']})
                    extensions.append(expanded)
    if len(rows)!=27495:raise ValueError('Unexpected inventory size: '+str(len(rows)))
    counts={field:dict(Counter(str(x[field]) for x in rows)) for field in ('property_id','profile','bound_ticks','applicability','readiness','origin')}
    checked_sources=[BASE/'reference/properties.py',Path(__file__),a.workspace/'tools/build_standard_answers.py']
    import_violations=[]
    for path in checked_sources:
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8-sig'))):
            modules=[x.name for x in node.names] if isinstance(node,ast.Import) else [node.module or ''] if isinstance(node,ast.ImportFrom) else []
            if any(m=='acverify' or m.startswith('acverify.') for m in modules):import_violations.append(str(path))
    summary={'schema':'reference-p1-inventory/0.1','queries':len(rows),'unique_query_ids':len(seen),
             'semantic_cases':len(cases),'static_cases':len(static),'static_classifications':dict(Counter(x['classification'] for x in static)),
             'counts':counts,'extension_queries':len(extensions),'applicability_disagreements':changes,
             'dependency_drifts':drifts,'vacuity_risks':vacuity_risks,'truth_labels_created':0,
             'response_queries_with_no_full_window':sum(x.get('full_response_window_possible') is False for x in rows),
             'gates':{'all_queries_identified':True,'all_properties_executable_on_frames':True,
                 'no_tested_verifier_imports':not import_violations,'all_queries_ready_for_p2':all(x['readiness'] in ('READY_FOR_P2','NOT_APPLICABLE') for x in rows)},
             'note':'Readiness is not a truth verdict. Pilot timing mapping and extended response horizons must not silently redefine historical queries.'}
    write(a.output/'query-inventory.json',{'metadata':summary,'queries':rows})
    write(a.output/'case-inputs.json',cases);write(a.output/'static-scope.json',static)
    write(a.output/'proposed-query-extensions.json',{'queries':extensions,'admitted':False})
    write(a.output/'inventory-summary.json',summary)
    files={p.name:sha(p) for p in a.output.glob('*.json') if p.name!='manifest.json'}
    write(a.output/'manifest.json',{'schema':'whole-line-reference-p1/0.1','stage':'P1','files':files,
        'property_spec_digest':digest(spec),'semantic_base_digest':digest(semantics),
        'source_hashes':{p.relative_to(BASE).as_posix():sha(p) for p in
           [Path(__file__),BASE/'tools/build_property_spec.py',BASE/'reference/properties.py',
            BASE/'reference/specs/property-spec.json',BASE/'reference/specs/semantics-clarifications.md']},
        'reference_parser_sha256':sha(a.workspace/'tools/build_standard_answers.py'),
        'whole_line_truth_complete':False,'no_answers_file':'P1 constructs obligations and inventory, not truth labels'})
    print(json.dumps({k:v for k,v in summary.items() if k not in ('dependency_drifts','applicability_disagreements','vacuity_risks')},ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    build(p.parse_args())
