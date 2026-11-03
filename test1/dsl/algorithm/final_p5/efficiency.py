"""Paired, censored-aware summaries for the frozen repeated cohort."""
from collections import defaultdict,Counter
import math
import random
import statistics
from .common import read,read_rows,write,sha,seal,verify_files


def median(values):
    values=[v for v in values if isinstance(v,(int,float)) and math.isfinite(v)]
    return statistics.median(values) if values else None


def paired_ratio(pairs,field,seed=20261103):
    parent=defaultdict(list)
    for baseline,other in pairs:
        a,b=baseline.get(field),other.get(field)
        if a is None or b is None or a<=0 or b<=0:continue
        parent[baseline['scene'],baseline['parent']].append(math.log(b/a))
    scene=defaultdict(list)
    for (sid,_),values in parent.items():scene[sid].append(statistics.median(values))
    values=[statistics.median(v) for _,v in sorted(scene.items())]
    if not values:return dict(ratio=None,ci95=None,scene_clusters=0,parent_clusters=0,paired_jobs=len(pairs))
    point=math.exp(statistics.median(values));interval=None
    if len(values)>=3:
        rng=random.Random(seed);samples=sorted(math.exp(statistics.median(rng.choices(values,k=len(values)))) for _ in range(2000))
        interval=[samples[int(.025*(len(samples)-1))],samples[int(.975*(len(samples)-1))]]
    return dict(ratio=point,ci95=interval,scene_clusters=len(values),parent_clusters=len(parent),paired_jobs=len(pairs),
                interpretation='method / baseline; below 1 means less time/memory',
                estimator='median within parent, median within scene, median across scenes; scene-cluster percentile bootstrap')


def build(scores,output):
    scores=scores.resolve();output=output.resolve()
    if output.exists():raise ValueError('Use a fresh efficiency output')
    verify_files(scores,read(scores/'manifest.json')['files'])
    jobs=read_rows(scores/'job-scores.jsonl');repeated=[j for j in jobs if j['role']=='repeated']
    grouped=defaultdict(list)
    for j in repeated:grouped[j['method'],j['seconds']].append(j)
    summaries=[]
    for (method,budget),values in sorted(grouped.items()):
        checked=[j for j in values if j['status']=='COMPLETED'];solved=[j for j in values if j['all_applicable_correct']]
        summaries.append(dict(method=method,seconds=budget,jobs=len(values),worker_statuses=dict(Counter(j['status'] for j in values)),
            limits=dict(Counter(str(j['limit']) for j in values)),all_queries_correctly_decided=len(solved),
            complete_query_fraction=len(solved)/len(values),
            median_search_seconds_all_checked=median(j['search_seconds'] for j in checked),
            median_search_seconds_solved_only=median(j['search_seconds'] for j in solved),
            median_worker_seconds_solved_only=median(j['worker_seconds'] for j in solved),
            median_sampled_rss_mb=median(j['peak_sampled_rss_bytes']/1024**2 for j in checked if j['peak_sampled_rss_bytes']),
            median_last_phase_states=median(j['states'] for j in checked),
            median_total_phase_states=median(j['phase_states'] for j in checked),
            scope='Sampled cohort only. Timeouts are not completed runtimes; portfolio phase-state sums can revisit states.'))
    blocks=defaultdict(dict)
    for j in repeated:blocks[j['case_id'],j['profile'],j['seconds'],j['repeat']][j['method']]=j
    comparisons=[]
    for budget in sorted({j['seconds'] for j in repeated}):
        for method in ('storage','portfolio'):
            allpairs=[(v['none'],v[method]) for k,v in blocks.items() if k[2]==budget and 'none' in v and method in v]
            valid=[(a,b) for a,b in allpairs if a['status']=='COMPLETED' and b['status']=='COMPLETED']
            solved=[(a,b) for a,b in valid if a['all_applicable_correct'] and b['all_applicable_correct']]
            comparisons.append(dict(method=method,seconds=budget,total_paired_jobs=len(allpairs),
                joint_checked=len(valid),joint_correctly_decided=len(solved),
                search_time_ratio=paired_ratio(solved,'search_seconds'),worker_time_ratio=paired_ratio(solved,'worker_seconds'),
                sampled_rss_ratio=paired_ratio(valid,'peak_sampled_rss_bytes'),
                runtime_selection='Both methods correctly decide every applicable query; report this conditional subset alongside full coverage.'))
    output.mkdir(parents=True);write(output/'repeated-budget-summary.json',summaries);write(output/'paired-comparisons.json',comparisons)
    # Retain every planned repeat, including unknowns/errors, in reproducibility data.
    write(output/'repeated-job-data.json',repeated)
    stability=defaultdict(list)
    for j in repeated:stability[j['case_id'],j['profile'],j['seconds'],j['method']].append(j)
    stable=[]
    for key,values in sorted(stability.items()):
        rates=[v['determinate_queries']/v['applicable_queries'] if v['applicable_queries'] else 0 for v in values]
        stable.append(dict(case_id=key[0],profile=key[1],seconds=key[2],method=key[3],repeats=len(values),
                           determinate_fraction_min=min(rates),determinate_fraction_max=max(rates),
                           search_seconds=[v['search_seconds'] for v in values],states=[v['states'] for v in values]))
    write(output/'repeat-stability.json',stable)
    summary=dict(repeated_jobs=len(repeated),case_count=len({j['case_id'] for j in repeated}),parent_count=len({j['parent'] for j in repeated}),
                 scenes=len({j['scene'] for j in repeated}),bootstrap_replicates=2000,
                 limitations=['One non-exclusive workstation; no claim of hardware-independent latency.',
                              'Only joint completed-and-correct jobs enter runtime ratios; full coverage and all timeout counts remain visible.',
                              'Confidence intervals describe these selected scene clusters; they do not prove generalization to new industrial scenes.',
                              'RSS is sampled during search; unobserved transient peaks may be missed.'])
    write(output/'summary.json',summary);seal(output,stage='P5.5-efficiency',scoring_manifest_sha256=sha(scores/'manifest.json'))
    print(summary,flush=True)
