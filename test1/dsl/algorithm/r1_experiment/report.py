"""Score only sealed predictions; emit partial progress without reading labels."""
from collections import Counter,defaultdict
from pathlib import Path
import statistics
from final_p5.common import read,read_rows,write,write_rows,sha,seal,verify_files
from final_p5.scoring import classify,metric

def progress(output,plan):
    completed=[]
    for j in plan['jobs']:
        path=output/'jobs'/j['id']/'result.json'
        if path.exists():
            r=read(path);completed.append((j,r))
    summary=dict(planned=len(plan['jobs']),recorded=len(completed),
                 by_role=dict(Counter(j['role'] for j,r in completed)),
                 statuses=dict(Counter(r['status'] for j,r in completed)),
                 search_seconds_ceiling_remaining=sum(j['seconds'] for j in plan['jobs'] if not (output/'jobs'/j['id']/'result.json').exists()),
                 predictions_sealed=False)
    write(output/'progress.json',summary)
    return summary

def score(output,workspace):
    output=Path(output);plan=read(output/'plan.json')
    if not read(output/'completion.json')['predictions_sealed']:raise ValueError('Unsealed predictions')
    review=Path(plan['review'])
    if sha(review/'gold.jsonl')!=plan['gold_sha256']:raise ValueError('Reference drift')
    gold={r['query_id']:r for r in read_rows(review/'gold.jsonl')}
    rows=[];jobs=[];conflicts=[]
    for j in plan['jobs']:
        directory=output/'jobs'/j['id'];verify_files(directory,read(directory/'manifest.json')['files'])
        e=read(directory/'result.json')
        if e['job']!=j or e['plan_sha256']!=sha(output/'plan.json'):raise ValueError('Wrong job provenance')
        if e['status']=='INPUT_OR_SOURCE_DRIFT':raise ValueError('Source drift cannot be scored')
        report=e.get('report',{});pred={p['query_id']:p for p in report.get('results',[])}
        qs=read(output/'inputs'/j['group_file'])['records']
        if e['status']=='COMPLETED' and set(pred)!={q['query_id'] for q in qs}:raise ValueError('Missing query')
        if e['status']=='COMPLETED' and (report['model_digest']!=plan['model_digests'][j['case_id']+'|'+j['profile']] or report['implementation_hashes']!=plan['implementation_hashes']):raise ValueError('Model/source mismatch')
        for q in qs:
            g=gold[q['query_id']];p=pred.get(q['query_id'],dict(verdict='UNKNOWN',trigger_reachability='UNKNOWN'))
            tc=g['truth_status']=='CERTIFIED' and g['trigger_reachability'] in ('REACHABLE','UNREACHABLE') and p.get('trigger_reachability') in ('REACHABLE','UNREACHABLE') and g['trigger_reachability']!=p['trigger_reachability']
            outcome=classify(g,p,e['status'])
            if p['verdict'] in ('VIOLATED','REACHABLE'):
                ref=e.get('witnesses',{}).get(q['query_id'])
                if not ref or q['query_id'] not in report.get('replays',{}) or sha(directory/ref['path'])!=ref['sha256']:raise ValueError('Positive result lacks checked witness')
            if p['verdict'] in ('HOLDS','UNREACHABLE') and (not report['statistics']['explored_all_prefixes'] or (q['property_id']=='V10b' and not report['statistics']['finite_model_closed'])):raise ValueError('Negative result without required exhaustion')
            row=dict(job_id=j['id'],role=j['role'],case_id=j['case_id'],scene=j['scene'],parent=j['parent'],profile=j['profile'],
                     method=j['method'],seconds=j['seconds'],repeat=j['repeat'],query_id=q['query_id'],property_id=q['property_id'],
                     gold_verdict=g['verdict'],gold_vacuous=g['vacuous'],prediction=p['verdict'],outcome=outcome,trigger_conflict=tc)
            rows.append(row)
            if outcome=='incorrect' or tc:conflicts.append(row)
        s=report.get('statistics',{})
        detail=s.get('limit')
        if detail=='STATE_OR_STORAGE_LIMIT':
            detail='STATE_LIMIT' if s['states']>=j['state_limit'] else 'SERIALIZED_STORAGE_LIMIT'
        phases=report.get('search_phases',[])
        jobs.append(dict(**j,status=e['status'],limit=detail,phase_limits=[x['limit'] for x in phases],
                         states=s.get('states'),edges=s.get('edges'),rss=max((x['peak_sampled_rss_bytes'] for x in phases),default=None),
                         search_seconds=report.get('search_and_packaging_seconds'),worker_seconds=e.get('worker_seconds'),message=e.get('message')))
    grouped=defaultdict(list)
    for r in rows:grouped[(r['role'],r['method'],r['seconds'],r['gold_verdict'])].append(r)
    metrics=[dict(role=k[0],method=k[1],seconds=k[2],gold_class=k[3],**metric(v)) for k,v in sorted(grouped.items(),key=str)]
    target=output/'scores'
    write_rows(target/'query-scores.jsonl',rows);write_rows(target/'job-scores.jsonl',jobs)
    write(target/'metrics.json',metrics);write(target/'disagreements.json',conflicts)
    stable=defaultdict(list)
    for r in rows:
        if r['role']=='budget':stable[(r['method'],r['seconds'],r['query_id'])].append(r)
    stability=defaultdict(Counter)
    for (method,budget,qid),rs in stable.items():
        if all(r['outcome']=='not_applicable' for r in rs):continue
        c=stability[method,budget];c['applicable_unique']+=1
        c['stable_correct']+=len(rs)==3 and all(r['outcome']=='correct' and not r['trigger_conflict'] for r in rs)
    write(target/'stability.json',[dict(method=k[0],seconds=k[1],**v) for k,v in sorted(stability.items())])
    seal(target,kind='r1-scoring/0.1',prediction_manifest_sha256=sha(output/'prediction-manifest.json'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    artifact=Path(plan['artifacts']);artifact.mkdir(parents=True,exist_ok=True)
    fig,axes=plt.subplots(1,3,figsize=(12,3.8))
    for ax,category in zip(axes,['ALL','VIOLATED','REACHABLE']):
        for method in ['none','storage','portfolio']:
            xs=[];ys=[]
            for seconds in [.5,2.,10.,30.]:
                rs=[r for r in rows if r['role']=='budget' and r['method']==method and r['seconds']==seconds and (category=='ALL' or r['gold_verdict']==category)]
                m=metric(rs);xs.append(seconds);ys.append(100*(m['correct_fraction_of_all'] or 0))
            ax.plot(xs,ys,marker='o',label=method)
        ax.set(title=category,xlabel='Search budget (s)',ylabel='Correct / applicable (%)',ylim=(0,100))
        ax.set_xscale('log');ax.grid(alpha=.25)
    axes[-1].legend();fig.tight_layout();fig.savefig(artifact/'budget-coverage.png',dpi=170);plt.close(fig)
    text=['# R1 实验报告','',
          '本报告由已封存预测及独立真值生成。预算实验复用 P5 分层样本；重复计时不增加独立案例数。',
          '',f"计划作业 {len(jobs)}，状态分布：{dict(Counter(j['status'] for j in jobs))}；结论/触发冲突 {len(conflicts)}。",
          '', '![预算覆盖曲线](budget-coverage.png)','',
          '| 方法 | 搜索预算/秒 | 三次均正确决定 | 适用独立查询 | 稳定覆盖率 |','| --- | ---: | ---: | ---: | ---: |']
    for (method,budget),c in sorted(stability.items()):
        text.append(f"| {method} | {budget} | {c['stable_correct']} | {c['applicable_unique']} | {c['stable_correct']/c['applicable_unique']:.2%} |")
    text+=['','## 资源限制','', '| 作业类型 | 原因 | 数量 |','| --- | --- | ---: |']
    for (role,limit),count in sorted(Counter((j['role'],str(j['limit'])) for j in jobs).items()):text.append(f'| {role} | {limit} | {count} |')
    text+=['','## 解释边界','',
           '图中为本次样本的逐运行正确比例；稳定覆盖另表要求三次均正确。资源敏感性、K 子集实验与预算主表分开。',
           '剖析开启追踪/cProfile，不能把剖析耗时与正式运行速度比较。阶段 yield 计数包含上游组合，不可当独立分支因子相乘。',
           '规模清单为现有案例观察分布，K 实验仅使用已有准入查询。尚未新增受控节点/物料规模族，不能据此声称完成所有扩展性实验。',
           'PLC 编译/类型检查不等于外部模型检查或语义准入；具体支持状态见 plc-pilot/compatibility.json。',
           '本轮不自动实施 R2。核心机制需要结合 profiling、资源截断和关键类别覆盖审阅后选择。',
           '', '独立参考模型中的见证复核及图表人工检查仍需单列完成；本报告生成不自动代表 R1 最终验收通过。']
    (artifact/'R1实验报告.md').write_text('\n'.join(text)+'\n',encoding='utf8')
    write(output/'analysis-completion.json',dict(scored=True,conflicts=len(conflicts),charts_generated=True,visual_qa='PENDING',reference_witness_audit='PENDING',r1_complete=False))
