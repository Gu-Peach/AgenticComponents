"""Versioned verification entry. Reference labels are not accepted as inputs."""
import gc
import time
from .core import fingerprint,require
from .frontend import load_case,environment
from .model import TransitionModel
from .search import explore,witness,replay


def build(case,workspace,profile='nominal',fast_copy=False):
    data=load_case(case,workspace);env=environment(data,profile)
    data['input_digest']=fingerprint(data['input_hashes'])
    return TransitionModel(data,env,fast_copy)


def verify(case,workspace,queries,profile='nominal',seconds=30,states=20000,memory_mb=512,optimization='none'):
    require(optimization in ('none','storage','portfolio'),'INVALID_INPUT','Unknown strategy')
    started=time.perf_counter();model=build(case,workspace,profile,optimization!='none')
    build_seconds=time.perf_counter()-started;begin=time.perf_counter();early={};traces={};phase_stats=[]
    if optimization=='portfolio':
        first=explore(model,queries,seconds*.15,states,memory_mb,'witness',False)
        early={r['query_id']:r for r in first['results'] if r['verdict'] in ('VIOLATED','REACHABLE')}
        traces={qid:witness(model,first,index) for qid,index in first['witnesses'].items() if qid in early}
        phase_stats.append(first['statistics']);del first;gc.collect()
    budget=max(0,seconds-(time.perf_counter()-begin))
    graph=explore(model,queries,budget,states,memory_mb,'complete',optimization=='none')
    phase_stats.append(graph['statistics'])
    for row in graph['results']:
        if row['query_id'] in early:
            prior=early[row['query_id']]
            require(row['verdict'] in ('UNKNOWN',prior['verdict']),'INCONSISTENT_SEARCH','Portfolio passes disagree')
            row.update(prior)
    for qid,index in graph['witnesses'].items():traces[qid]=witness(model,graph,index)
    results=graph['results'];stats=graph['statistics'];del graph
    checking=time.perf_counter();receipts={qid:replay(model,payload) for qid,payload in traces.items()}
    return dict(status='CHECKED',model_version=model.version,semantics_id=model.spec['id'],model_digest=model.model_digest,
        input_hashes=model.data['input_hashes'],implementation_hashes=model.implementation_hashes,optimization=optimization,results=results,statistics=stats,
        search_phases=phase_stats,frontend_seconds=build_seconds,search_and_packaging_seconds=checking-begin,
        replay_seconds=time.perf_counter()-checking,replays=receipts,
        truth_source='algorithm_output_not_oracle',comparison_admission='REQUIRES_SEPARATE_P5_GATE'),traces
