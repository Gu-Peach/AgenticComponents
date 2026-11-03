"""Diagnostic profiling; these instrumented times are not benchmark timings."""
import argparse
import cProfile
import json
from pathlib import Path
import pstats
import sys
import time


def main(a):
    sys.path.insert(0, str(a.implementation/'src'))
    from acverify.pipeline import build
    from acverify.backends import explore
    rows=[]
    for cid in a.cases:
        for profile in ('nominal','delayed','fault'):
            if cid=='S04-P01' and profile=='fault': profile='stop_unknown_c1'
            begin=time.perf_counter(); model=build(a.workspace/'datasets/ac-path-v1/cases'/cid/'case.json',a.workspace,profile,
                **({'fast_copy':True} if a.optimized else {}))
            construction=time.perf_counter()-begin
            counters={}
            for method in ('fault_variants','delivered','plant_variants'):
                original=getattr(model,method)
                def instrument(*args,_fn=original,_name=method,**kwargs):
                    counters[_name+'_calls']=counters.get(_name+'_calls',0)+1
                    for result in _fn(*args,**kwargs):
                        counters[_name+'_yields']=counters.get(_name+'_yields',0)+1
                        yield result
                setattr(model,method,instrument)
            profiler=cProfile.Profile();profiler.enable()
            graph=explore(model,bound=3000,state_limit=20000,time_limit=a.seconds,
                          mode='compact' if model.profile['events'] else 'clock',
                          **({'optimized':True,'keep_edges':False} if a.optimized else {}))
            profiler.disable();stat=pstats.Stats(profiler)
            functions=[{'file':key[0],'line':key[1],'function':key[2], 'calls':value[1],
                        'self_seconds':value[2],'cumulative_seconds':value[3]} for key,value in stat.stats.items()]
            functions.sort(key=lambda x:x['self_seconds'],reverse=True)
            row={'case_id':cid,'profile':profile,'construction_seconds':construction,
                 'search':graph['report'],'branch_counts':counters,'functions':functions[:35],
                 'note':'Nested generator yield counts are diagnostic, not independent branch probabilities.'}
            rows.append(row); print(json.dumps({'case':cid,'profile':profile,'states':graph['report']['states']}),flush=True)
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(json.dumps({'instrumented':True,'rows':rows},ensure_ascii=False,indent=2)+'\n',encoding='utf8')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True)
    p.add_argument('--implementation',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--seconds',type=float,default=.5)
    p.add_argument('--optimized',action='store_true')
    p.add_argument('--cases',nargs='+',default=['S04-P01','S01-P02','S04-P04','S12-P03'])
    main(p.parse_args())
