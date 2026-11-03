"""Method-one orchestration; report supported scope instead of filling oracle labels."""
from pathlib import Path
import hashlib
import time
from .core import VerificationError, fingerprint
from .frontend import load_case, environment
from .model import TransitionModel
from .backends import explore, graph_bmc
from .diagnostics import trace, replay
from .properties import property_ir
from .reduction import dependencies


def build(case,workspace,profile='nominal'):
    data=load_case(case,workspace);env=environment(data,profile)
    data['input_digest']=fingerprint(data['input_hashes'])
    return TransitionModel(data,env)


def verify(case,workspace,profile='nominal',bound=256,states=20000,seconds=30,memory_mb=512,reduction='full',search='complete',backend='explicit'):
    try:
        start=time.perf_counter()
        model=build(case,workspace,profile)
        build_seconds=time.perf_counter()-start
        requested_reduction=reduction
        if reduction=='auto':reduction='clock' if search=='complete' and not model.profile['events'] else 'compact'
        graph=explore(model,bound,states,seconds,memory_mb,reduction,search)
        result=graph['report'];result.update(status='CHECKED',case_id=model.data['descriptor']['case_id'],environment=profile,
          model_version=model.version,input_digest=model.data['input_digest'],model_digest=model.model_digest,input_hashes=model.data['input_hashes'],
          semantics_id=model.spec['id'],semantics_hash=model.spec_hash,
          assumptions=model.export()['observation_semantics'],deployment_ready=False,
          truth_source='algorithm_output_not_independent_oracle',
          frontend_and_model_seconds=build_seconds,
          requested_reduction=requested_reduction,
          algorithm_hashes={str(p.relative_to(Path(__file__).parent)):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*.py')})
        witnesses={pid:trace(model,graph,i) for pid,i in graph['bad'].items()}
        if graph['goal'] is not None:witnesses['goal']=trace(model,graph,graph['goal'])
        for name,i in graph['terminals'].items():witnesses.setdefault('terminal_'+name,trace(model,graph,i))
        result['replays']={name:replay(model,w) for name,w in witnesses.items()}
        result['diagnostics']=[{'property':pid,'tick':graph['states'][index]['tick'],
             'reason':graph['states'][index]['reason'],
             'material_state':graph['states'][index]['world']['materials'],
             'witness_file':pid+'.trace.json'} for pid,index in graph['bad'].items()]
        result['terminal_reasons']={kind:graph['states'][index]['reason'] for kind,index in graph['terminals'].items()}
        if backend=='z3-graph':result['smt_cross_check']={p:graph_bmc(graph,p) for p in ('V09','V10a')}
        return result,witnesses,model.export()
    except VerificationError as error:
        return {'status':error.code,'message':str(error),'details':error.details,'properties':{},'truth_source':'no_conclusion'}, {},None
    except (FileNotFoundError,KeyError,TypeError) as error:
        return {'status':'INPUT_OR_MODEL_ERROR','message':str(error),'properties':{},'truth_source':'no_conclusion'}, {},None


def check(case,workspace):
    try:
        data=load_case(case,workspace)
        return {'status':'VALID_INPUT','case_id':data['descriptor']['case_id'],'nodes':len(data['ir']['nodes']),
                'input_hashes':data['input_hashes'],'deployment_ready':False}
    except VerificationError as error:return {'status':error.code,'message':str(error),'details':error.details}
    except (FileNotFoundError,KeyError,TypeError) as error:return {'status':'INVALID_INPUT','message':str(error)}
