"""Audit frozen inputs and compare decisions without treating timeouts as answers."""
import argparse
from collections import Counter,defaultdict
import json
from pathlib import Path
import statistics
from run_solver_ablation import read,write,sha,sources

BASE=Path(__file__).resolve().parents[1]


def answer(pid,verdict):
    if pid=='V10a':
        if verdict=='GOAL_REACHABLE_WITHIN_BOUND':return 'REACHABLE'
        if verdict in ('GOAL_NOT_REACHED_WITHIN_BOUND','GOAL_NOT_REACHED_ON_FINITE_MODEL'):return 'UNREACHABLE'
    elif verdict=='VIOLATED_IN_MODEL':return 'VIOLATED'
    elif verdict in ('PROVED_ON_FINITE_MODEL','NO_VIOLATION_WITHIN_BOUND'):return 'HOLDS'
    return None


def stats(xs):
    if not xs:return {'n':0,'median':None,'q1':None,'q3':None}
    a=sorted(xs)
    def q(p):
        i=(len(a)-1)*p;lo=int(i);return a[lo]+(a[min(lo+1,len(a)-1)]-a[lo])*(i-lo)
    return {'n':len(a),'median':statistics.median(a),'q1':q(.25),'q3':q(.75)}


def main(a):
    plan=read(a.output/'plan.json');gold=read(a.workspace/'experiments/method1-v3/core.json')
    labels={(q['case_id'],q['property']):q['expected'] for q in gold['queries']}
    errors=[];conflicts=[];missing=[]
    static=read(a.output.parent/'static-results.json')
    static_gold=read(a.workspace/'experiments/method1-v3/static.json')['expected_by_case']
    static_ok=(len(static['records'])==576 and {r['case'] for r in static['records']}==set(static_gold)
               and all(r['expected']==r['actual']==static_gold[r['case']] for r in static['records']))
    if not static_ok:errors.append('static classification check failed')
    if sha(a.workspace/'experiments/method1-v3/core.json')!=plan['core_sha256']:errors.append('reference core drift')
    if sha(a.workspace/'experiments/method1-v3/freeze.json')!=plan['core_freeze_sha256']:errors.append('reference freeze drift')
    if sources(BASE)!=plan['optimized_sources'] or sources(a.baseline)!=plan['baseline_sources']:errors.append('source drift')
    if sha(BASE/'tools/run_solver_ablation.py')!=plan['runner_sha256']:errors.append('runner drift')
    for cid,h in plan['input_locks'].items():
        if sha(a.workspace/'datasets/ac-path-v1/cases'/cid/'dependencies.lock.json')!=h:errors.append('input lock drift:'+cid)
    groups=defaultdict(list);scores=defaultdict(Counter);decisions=[];pairs=defaultdict(dict);models={};stable=defaultdict(list)
    psha=sha(a.output/'plan.json');traces_checked=0
    for job in plan['jobs']:
        path=a.output/'jobs'/(job['id']+'.json')
        if not path.exists():missing.append(job['id']);continue
        row=read(path);r=row['result'];j=row['job']
        if j!=job or row.get('plan_sha256')!=psha:errors.append('job plan mismatch:'+job['id'])
        expected_sources=plan['baseline_sources' if j['method']=='baseline' else 'optimized_sources']
        if r.get('algorithm_hashes')!=expected_sources:errors.append('worker source mismatch:'+job['id'])
        if r.get('semantics_hash')!=gold['semantics_hash']:errors.append('semantics mismatch:'+job['id'])
        identity=(j['case_id'],j['profile'])
        fingerprint=(r.get('model_digest'),r.get('input_digest'))
        if identity in models and models[identity]!=fingerprint:errors.append('model/input differ between methods:'+str(identity))
        models[identity]=fingerprint
        for name,trace in row.get('trace_files',{}).items():
            if sha(a.output/'worker-output'/trace['path'])!=trace['sha256']:errors.append('trace drift:'+job['id']+'|'+name)
            if not r.get('replays',{}).get(name,{}).get('valid'):errors.append('trace replay not confirmed:'+job['id']+'|'+name)
            traces_checked+=1
        group=' / '.join((j['role'],j['profile'],j['method'],str(j['seconds'])))
        groups[group].append(row)
        pair=(j['role'],j['case_id'],j['profile'],j['seconds'],j['repeat']);pairs[pair][j['method']]=row
        if j['profile']!='nominal':continue
        for pid in ('V09','V10a'):
            if (j['case_id'],pid) not in labels:continue
            expected=labels[(j['case_id'],pid)];actual=answer(pid,r.get('properties',{}).get(pid,{}).get('verdict'))
            tag='unresolved' if actual is None else 'correct' if actual==expected else 'wrong'
            scores[group]['total']+=1;scores[group][tag]+=1
            d={'job':j['id'],'case':j['case_id'],'property':pid,'expected':expected,'actual':actual,'status':tag,'group':group}
            decisions.append(d)
            if tag=='wrong':conflicts.append(d)
            if j['role']=='ablation':stable[(j['method'],j['seconds'],j['case_id'],pid)].append(actual)
    stability=defaultdict(Counter)
    for (method,budget,cid,pid),vs in stable.items():
        key=method+' / '+str(budget);stability[key]['total']+=1
        if len(vs)==3 and all(v is not None for v in vs) and len(set(vs))==1:stability[key]['stable_answered']+=1
        if len({v for v in vs if v is not None})>1:errors.append('repeat conflict:'+str((method,budget,cid,pid)))
    agreement=Counter();ratios=defaultdict(list);paired_details=[]
    for key,methods in pairs.items():
        if 'baseline' not in methods:continue
        for method in ('storage','portfolio'):
            if method not in methods:continue
            x=methods['baseline']['result'];y=methods[method]['result']
            for pid in x.get('properties',{}):
                xp=x['properties'][pid];yp=y.get('properties',{}).get(pid,{})
                xv=answer(pid,xp['verdict']);yv=answer(pid,yp.get('verdict'))
                if pid=='V10b':
                    if xp.get('incomplete_window') and xp['verdict']!='VIOLATED_IN_MODEL':xv=None
                    if yp.get('incomplete_window') and yp.get('verdict')!='VIOLATED_IN_MODEL':yv=None
                if xv is not None and yv is not None:
                    agreement['jointly_decided']+=1
                    if xv!=yv:errors.append('cross-method conflict:'+str(key)+'|'+pid)
            if x.get('finite_model_exhausted') and y.get('finite_model_exhausted'):
                if method=='storage' and (x['states']!=y['states'] or x['edges']!=y['edges']):
                    errors.append('closed storage graph size differs:'+str(key))
                ratio=x['elapsed_seconds']/y['elapsed_seconds'];group=key[0]+' / '+method+' / '+str(key[3])
                ratios[group].append(ratio)
                paired_details.append({'case':key[1],'repeat':key[4],'group':group,'ratio':ratio,
                                       'baseline_states':x['states'],'optimized_states':y['states']})
    summaries={}
    for group,rows in groups.items():
        rs=[x['result'] for x in rows];c=scores[group];known=c['correct']+c['wrong']
        summaries[group]={'jobs':len(rows),'status_counts':dict(Counter(r['status'] for r in rs)),
            'limits':dict(Counter(str(r.get('limit')) for r in rs)),'closed_jobs':sum(r.get('finite_model_exhausted',False) for r in rs),
            'score':dict(c),'coverage':known/c['total'] if c['total'] else None,
            'accuracy_answered':c['correct']/known if known else None,
            'search_seconds':stats([r['elapsed_seconds'] for r in rs if 'elapsed_seconds' in r]),
            'worker_seconds':stats([x['worker_seconds'] for x in rows if 'worker_seconds' in x]),
            'states':stats([r['states'] for r in rs if 'states' in r]),
            'rss_mib':stats([r['peak_sampled_rss_bytes']/2**20 for r in rs if 'peak_sampled_rss_bytes' in r])}
    summary={'id':'solver-optimization-report/0.4','planned':len(plan['jobs']),'recorded':sum(len(v) for v in groups.values()),
             'static_matches':sum(r['expected']==r['actual'] for r in static['records']),
             'reporter_sha256':sha(__file__),
             'errors':errors,'missing':missing,'reference_conflicts':conflicts,'traces_digest_and_replay_records_checked':traces_checked,
             'cross_method_agreement':dict(agreement),'groups':summaries,
             'stable_queries':{k:dict(v) for k,v in stability.items()},'paired_closed_search_speedup':{k:stats(v) for k,v in ratios.items()},
             'gates':{'execution_complete':not missing,'integrity':not errors,'reference_consistent':not conflicts,
                      'whole_line_truth_complete':False},
             'scope':'Same v3 semantic model and frozen query labels. No new truth labels, semantic reductions, or PLC baseline.'}
    write(a.output/'audit.json',summary);write(a.output/'query-results.json',decisions);write(a.output/'paired-results.json',paired_details)
    render(a.output,summary)
    print(json.dumps({'gates':summary['gates'],'jobs':summary['recorded'],'errors':errors[:10],'conflicts':len(conflicts)},ensure_ascii=False))


def render(out,s):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    colors={'baseline':'#8292ac','storage':'#36ae95','portfolio':'#d69846'}
    fig,axes=plt.subplots(1,2,figsize=(10.5,4.2),layout='constrained')
    for method in ('baseline','storage'):
        c=s['groups']['full_nominal / nominal / '+method+' / 0.5']['score']
        axes[0].bar(method,100*c.get('correct',0)/c['total'],color=colors[method])
        axes[0].text(method,100*c.get('correct',0)/c['total']+1,str(c.get('correct',0))+'/'+str(c['total']),ha='center')
    axes[0].set(ylim=(0,100),ylabel='Answered correctly (%)',title='All 659 reference queries, 0.5 s')
    for method in ('baseline','storage','portfolio'):
        ys=[]
        for b in (.5,2.):
            d=s['stable_queries'][method+' / '+str(b)];ys.append(100*d.get('stable_answered',0)/d['total'])
        axes[1].plot([.5,2.],ys,'o-',color=colors[method],label=method)
    axes[1].set(ylim=(0,100),xlabel='Shared search budget (s)',ylabel='Stable answered queries (%)',title='24 cases, 35 gold queries, 3 repeats')
    axes[1].legend();axes[1].grid(alpha=.2)
    fig.savefig(out/'optimization-results.png',dpi=170);fig.savefig(out/'optimization-results.svg');plt.close(fig)
    lines=['# 求解器优化 v4 实验报告','',
       '本轮实现 O0 剖析、O1 的专用状态复制/按需图边存储，以及 O2 的定向见证搜索组合。语义保持 method1-semantics/0.2；参考答案沿用 v3。',
       '',f"计划 {s['planned']} 项，记录 {s['recorded']} 项；参考冲突 {len(s['reference_conflicts'])} 条，完整性错误 {len(s['errors'])} 条；静态分类 {s['static_matches']}/576。",'',
       '## 全量 nominal 对照','', '| 方法 | 正确 | 错误 | 未决 | 覆盖率 |','| --- | ---: | ---: | ---: | ---: |']
    for method in ('baseline','storage'):
        g=s['groups']['full_nominal / nominal / '+method+' / 0.5'];c=g['score']
        lines.append(f"| {method} | {c.get('correct',0)} | {c.get('wrong',0)} | {c.get('unresolved',0)} | {g['coverage']:.1%} |")
    lines+=['','每个方法遍历全部 360 个语义案例，准确率和覆盖率只使用其中有独立参考的 659 条查询。baseline 是本轮重跑的冻结 v3 源码，不把历史机器负载下的耗时当作当前基线。',
       '', '## 三次重复的稳定覆盖','', '| 方法 | 0.5 秒 | 2 秒 |','| --- | ---: | ---: |']
    for method in ('baseline','storage','portfolio'):
        vals=[]
        for b in (.5,2.):
            c=s['stable_queries'][method+' / '+str(b)];vals.append(f"{c.get('stable_answered',0)}/{c['total']} ({c.get('stable_answered',0)/c['total']:.1%})")
        lines.append('| '+method+' | '+' | '.join(vals)+' |')
    lines+=['','固定沿用 v3 的 24 个案例，其中 35 条查询有参考标签。重复次数不增加独立样本数。portfolio 的见证阶段最多使用总搜索预算的 15%，完整搜索使用剩余预算。',
       '', '![优化结果](optimization-results.png)', '', '## 共同闭合搜索的耗时比','',
       '| 配置 | 配对数 | baseline/优化 中位数 | Q1 | Q3 |','| --- | ---: | ---: | ---: | ---: |']
    for k,v in s['paired_closed_search_speedup'].items():
        lines.append(f"| {k} | {v['n']} | {v['median']:.3f} | {v['q1']:.3f} | {v['q3']:.3f} |")
    lines+=['','比值大于 1 表示优化较快。只纳入同案例、环境、预算、重复下双方都闭合的搜索；不能外推到全部案例。重复配对存在同父案例相关性，这不是独立样本置信区间。',
       '', '## 资源、压力与审核边界','',
       'audit.json 另含每组超时/闭合数量、搜索时间、整个 worker 时间、状态数和采样 RSS 的中位数及四分位数。压力实验在同一批 24 个案例的 delayed/fault 环境中对照 baseline 与 storage，不报告尚无完整整线真值的准确率。',
       '', '参考核心与输入锁保持不变；各方法的输入摘要和模型摘要一致。所有已给出的共有性质结论逐项比较，见证由 worker 在模型上重放，审核重新核对见证摘要与重放记录。该审核不是独立整线物理/计时真值证明。',
       '', '## 本轮未实现的内容','',
       'O1 的不可变分块/搜索检查点、O2 的生产侧证明预处理，以及 O3–O6 的消息、时间、偏序和直接符号求解仍未实现。当前优化只降低状态处理成本、改变有预算搜索顺序，不减少允许故障或消息选择。',
       '', '优化入口为 --optimization storage 或 --optimization portfolio，默认 none 保留旧搜索路径。若组合策略损失稳定覆盖或耗时退化，应继续单列为消融，不自动启用。',
       '', '整线独立计时参考与精化证明仍是单独的未完成义务，不能因本轮提速而将 whole_line_truth_complete 改为 true。']
    (out/'实验报告.md').write_text('\n'.join(lines)+'\n',encoding='utf8')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--baseline',type=Path,default=BASE/'baselines/solver-v3')
    main(p.parse_args())
