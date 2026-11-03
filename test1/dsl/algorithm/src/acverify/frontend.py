"""Reuse the existing DSL grammar and binding checker; never load oracle labels."""
import copy
import importlib.util
from pathlib import Path
import sys
from .core import read_json, require, VerificationError, fingerprint


def import_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_case(case_path, algorithm_root):
    case_path = Path(case_path).resolve()
    if case_path.is_dir(): case_path /= 'case.json'
    folder = case_path.parent
    root = folder.parent.parent
    require(folder.parent.name == 'cases', 'INVALID_INPUT', 'Expected datasets/<version>/cases/<id>/case.json')
    descriptor = read_json(case_path)
    paths = {'case':case_path}
    for key, relative in descriptor['inputs'].items():
        path = (folder/relative).resolve()
        require(path.is_relative_to(root) and path.is_file(), 'INVALID_INPUT', 'Missing or escaping input', path=str(path))
        paths[key] = path
    algorithm_root = Path(algorithm_root).resolve()
    dsl = algorithm_root.parent
    checker = import_file('_acverify_corpus_frontend', algorithm_root/'tools/validate_corpus.py')
    paths['legacy_binder']=algorithm_root/'tools/validate_corpus.py'
    paths['legacy_parser']=dsl/'tools/check_design.py'
    paths['language_schema']=dsl/'process-ir.schema.json'
    parser = checker.load_parser(dsl)
    try:
        checked = checker.bind_case(root, descriptor['case_id'], parser)
    except checker.CorpusError as error:
        raise VerificationError('INVALID_INPUT', str(error), frontend_code=error.code) from error
    except (KeyError, TypeError, ValueError) as error:
        raise VerificationError('INVALID_INPUT', str(error)) from error
    data = {key:read_json(path) for key,path in paths.items() if key in ('environment','initial','task','properties','queries')}
    data.update(descriptor=descriptor, ir=checked['ir'], source_map=checked['mapping'], resolved=checked['resolved'],
                dataset_root=root, algorithm_root=algorithm_root, paths=paths)
    sid = descriptor['scene_id']
    for key,name in [('scene','instances'),('relations','relations'),('assumptions','model-assumptions')]:
        path=root/f'scenes/{sid}/{name}.json'; data[key]=read_json(path); paths[key]=path
    models = {}; contracts = {}
    for path in sorted((root/'shared/verification-contracts').glob('*.json')):
        obj=read_json(path);models[obj['id']]=obj;paths['model:'+obj['id']]=path
    for path in sorted((root/'shared/device-contracts').glob('*.json')):
        obj=read_json(path);contracts[obj['id']]=obj;paths['contract:'+obj['id']]=path
    data['models']=models;data['contracts']=contracts
    for path in sorted((root/'shared/services').glob('*.json')):paths['service:'+path.name]=path
    profile_path=root/'shared/execution-profiles/fixed-60hz.json'
    data['execution_profile']=read_json(profile_path);paths['execution_profile']=profile_path
    env=data['environment']
    data['devices']={d['id']:copy.deepcopy(d) for d in data['scene']['devices']+env.get('auxiliary_devices',[])}
    data['locations']={l['id']:copy.deepcopy(l) for l in data['scene']['locations']+env.get('auxiliary_locations',[])}
    for dev,values in env.get('scene_parameter_overrides',{}).items():
        data['devices'][dev]['parameters'].update(values)
        for loc in data['locations'].values():
            if loc['owner']==dev and not loc.get('slot'):loc['capacity']=data['devices'][dev]['parameters']['capacity']
    for key,action in data['resolved'].items():
        contract=contracts[data['devices'][action['device']]['contract_ref']]
        action['model_ref']=contract['capabilities'][action['behavior']]['verification_ref']
    data['input_hashes']={key:__import__('hashlib').sha256(p.read_bytes()).hexdigest() for key,p in paths.items()}
    lock_path=folder/descriptor['dependency_lock']
    require(lock_path.is_file(),'DEPENDENCY_LOCK_MISSING','Freeze the case inputs before verification')
    roots={'dataset':root,'dsl':dsl,'tool':algorithm_root/'tools'};expected={}
    for entry in read_json(lock_path)['files']:
        require(entry['root'] in roots,'INVALID_INPUT','Unknown dependency root')
        base=roots[entry['root']].resolve();p=(base/entry['path']).resolve()
        require(p.is_relative_to(base),'INVALID_INPUT','Dependency escapes its root')
        expected[p]=entry['sha256']
    for key,p in paths.items():
        require(expected.get(p.resolve())==data['input_hashes'][key],'DEPENDENCY_CHANGED','Consumed input is absent or changed in dependency lock',path=str(p))
    data['locked_hashes']=expected
    data['input_digest']=fingerprint(data['input_hashes'])
    return data


def environment(data, name):
    if data['descriptor'].get('schema_type')=='PilotCase':
        profiles=data['queries']['profiles']
        chosen=next((p for p in profiles if p['id']==name),None)
        require(chosen is not None,'UNSUPPORTED_MODEL','Unknown pilot environment')
        return {'id':name,'accept':chosen['accept'],'phase':chosen['phase'],'stop':chosen['stop'],
                'feedback':[0,0],'events':[],'faults':[], 'max_faults':0,
                'forced_stop_loss':chosen['stop_loss_device'],'max_age':data['execution_profile']['default_fact_max_age_ticks']}
    path=data['dataset_root']/f'shared/environments/{name.split("@")[0]}.json'
    require(path.is_file(),'UNSUPPORTED_MODEL','Unknown environment')
    p=read_json(path)
    supported={'delayed_feedback','duplicate_same_request','old_request_feedback','provider_restart','hold_permission_loss','missing_stop_confirmation'}
    require(set(p['permitted_events'])<=supported,'UNSUPPORTED_MODEL','Unknown environment event')
    digest=__import__('hashlib').sha256(path.read_bytes()).hexdigest()
    require(data['locked_hashes'].get(path.resolve())==digest,'DEPENDENCY_CHANGED','Environment profile differs from dependency lock')
    data['input_hashes']['environment_profile']=digest
    return {'id':p['id'],'accept':p['accept_delay_ticks'],'phase':p['phase_duration_ticks'],'stop':p['stop_delay_ticks'],
            'feedback':p['feedback_delay_ticks'],'events':data['environment'].get('events',[]),
            'faults':p['permitted_events'],'max_faults':p['max_fault_events_per_case'], 'forced_stop_loss':None,'max_age':data['execution_profile']['default_fact_max_age_ticks']}
