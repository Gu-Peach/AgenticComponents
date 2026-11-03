"""Standalone figures and a Chinese report from already frozen metric artifacts."""
from pathlib import Path
from collections import Counter,defaultdict
from .common import read,read_rows,write,sha,seal,verify_files

METHODS=('none','storage','portfolio')
LABELS={'none':'Explicit baseline','storage':'Storage','portfolio':'Portfolio'}
COLORS={'none':'#416b91','storage':'#258477','portfolio':'#d39a36'}


def percent(x):return '—' if x is None else f'{x*100:.2f}%'
def number(x,digits=3):return '—' if x is None else f'{x:.{digits}f}'
def table(headers,rows):
    return '\n'.join(['| '+' | '.join(headers)+' |','| '+' | '.join(['---']*len(headers))+' |']+
                     ['| '+' | '.join(str(x) for x in r)+' |' for r in rows])


def build(review,experiment,scores,efficiency,witnesses,static,output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
    review=review.resolve();experiment=experiment.resolve();scores=scores.resolve();efficiency=efficiency.resolve();witnesses=witnesses.resolve();output=output.resolve()
    if output.exists():raise ValueError('Use a fresh report directory')
    for root in (review,experiment,scores,efficiency,witnesses):verify_files(root,read(root/'manifest.json')['files'])
    summary=read(scores/'summary.json');metrics=read(scores/'metrics.json');admission=read(review/'summary.json')
    gate=read(review/'gate.json');plan=read(experiment/'plan.json');witness=read(witnesses/'summary.json')
    repeated=read(efficiency/'repeated-budget-summary.json');paired=read(efficiency/'paired-comparisons.json')
    repeated_jobs=read(efficiency/'repeated-job-data.json');structural=read(static)
    gold=read_rows(review/'gold.jsonl');output.mkdir(parents=True);figures=[]
    hardware=read(experiment.parent/'p54-hardware.json') if (experiment.parent/'p54-hardware.json').exists() else {}
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False,'savefig.facecolor':'white'})
    def save(fig,name):
        fig.savefig(output/(name+'.png'),dpi=180,bbox_inches='tight');fig.savefig(output/(name+'.svg'),bbox_inches='tight')
        figures.append(name);plt.close(fig)
    # Full-query coverage is shown before any conditional accuracy or runtime.
    fig,ax=plt.subplots(figsize=(10,5.2));bottom=np.zeros(3)
    categories=[('correct','Correct determinate','#27867b'),('incorrect','Incorrect determinate','#bc5144'),
                ('unknown','Unknown','#bcc4cc'),('worker_timeout','Worker timeout','#d9a03e'),('worker_error','Worker error','#75528b')]
    for category,label,color in categories:
        values=np.array([metrics['full_by_method'][m]['counts'].get(category,0)/metrics['full_by_method'][m]['applicable']*100 for m in METHODS])
        if not values.any():continue
        ax.bar([LABELS[m] for m in METHODS],values,bottom=bottom,label=label,color=color)
        for i,v in enumerate(values):
            if v>=4:ax.text(i,bottom[i]+v/2,f'{v:.2f}%',ha='center',va='center',color='white' if category=='correct' else '#252b31')
        bottom+=values
    ax.set_ylim(0,105);ax.set_ylabel('Share of applicable queries (%)');ax.set_title('Full admitted query view: coverage and correctness')
    handles,labels=ax.get_legend_handles_labels();fig.legend(handles,labels,loc='lower center',bbox_to_anchor=(.5,.10),ncol=3,frameon=False)
    fig.text(.5,.035,'N/A excluded; Unknown and worker failures remain in the denominator. This is not a PLC-tool comparison.',ha='center',fontsize=8)
    fig.subplots_adjust(left=.09,right=.98,bottom=.26,top=.88)
    save(fig,'01-full-query-outcomes')
    props=sorted({k.split('|')[1] for k in metrics['full_by_property']})
    fig,ax=plt.subplots(figsize=(8,6))
    matrix=np.array([[metrics['full_by_property'][m+'|'+p]['solved_coverage']*100 for m in METHODS] for p in props])
    im=ax.imshow(matrix,vmin=0,vmax=100,cmap='YlGnBu',aspect='auto')
    ax.set_xticks(range(3),[LABELS[m] for m in METHODS]);ax.set_yticks(range(len(props)),[p+('*' if p in ('V02','V03','V07') else '') for p in props])
    for i in range(len(props)):
        for j in range(3):ax.text(j,i,f'{matrix[i,j]:.1f}%',ha='center',va='center',color='white' if matrix[i,j]>60 else '#252b31')
    fig.colorbar(im,ax=ax,label='Determinate / applicable (%)');ax.set_title('Solve coverage by property')
    fig.text(.5,.01,'* Protocol-conformance properties are separated in the report; they are not arbitrary-controller detection scores.',ha='center',fontsize=8)
    fig.tight_layout(rect=(0,.045,1,1));save(fig,'02-property-solve-coverage')
    scenes=sorted({k.split('|')[1] for k in metrics['full_by_scene']})
    fig,ax=plt.subplots(figsize=(8,6))
    matrix=np.array([[metrics['full_by_scene'][m+'|'+s]['correct_fraction_of_all']*100 for m in METHODS] for s in scenes])
    im=ax.imshow(matrix,vmin=0,vmax=100,cmap='YlGnBu',aspect='auto')
    ax.set_xticks(range(3),[LABELS[m] for m in METHODS]);ax.set_yticks(range(len(scenes)),scenes)
    for i in range(len(scenes)):
        for j in range(3):ax.text(j,i,f'{matrix[i,j]:.1f}%',ha='center',va='center',color='white' if matrix[i,j]>60 else '#252b31')
    fig.colorbar(im,ax=ax,label='Correct / all applicable (%)');ax.set_title('Full-query correctness coverage by scene')
    fig.tight_layout();save(fig,'03-scene-correctness-coverage')
    fig,axes=plt.subplots(1,2,figsize=(12,4.5));budgets=sorted({r['seconds'] for r in repeated})
    width=.23
    for j,m in enumerate(METHODS):
        rs=[next(r for r in repeated if r['method']==m and r['seconds']==b) for b in budgets]
        axes[0].bar(np.arange(len(budgets))+(j-1)*width,[r['complete_query_fraction']*100 for r in rs],width,label=LABELS[m],color=COLORS[m])
        axes[1].bar(np.arange(len(budgets))+(j-1)*width,[r['median_sampled_rss_mb'] or 0 for r in rs],width,label=LABELS[m],color=COLORS[m])
    for ax in axes:ax.set_xticks(range(len(budgets)),[f'{b:g} s' for b in budgets]);ax.set_xlabel('Shared search budget')
    axes[0].set_ylabel('Jobs deciding all applicable queries correctly (%)');axes[0].set_ylim(0,105);axes[0].set_title('Repeated cohort: completion coverage')
    axes[1].set_ylabel('Median sampled search RSS (MiB)');axes[1].set_title('Repeated cohort: sampled memory')
    axes[0].legend(frameon=False,fontsize=8);fig.tight_layout();save(fig,'04-repeated-coverage-memory')
    fig,axes=plt.subplots(1,2,figsize=(12,4.8))
    for ax,field,title in zip(axes,['search_time_ratio','worker_time_ratio'],['Search and witness preparation','Worker end-to-end']):
        labels=[]
        for i,row in enumerate(paired):
            x=row[field];labels.append(f"{LABELS[row['method']]} / base\n{row['seconds']:g}s; {x['scene_clusters']} scenes, {x['paired_jobs']} pairs")
            if x['ratio'] is None:ax.text(1,i,'No jointly solved pairs',va='center',fontsize=8)
            else:
                ax.plot(x['ratio'],i,'o',color=COLORS[row['method']])
                if x['ci95']:ax.hlines(i,x['ci95'][0],x['ci95'][1],color=COLORS[row['method']],linewidth=2)
                ax.annotate(f"{x['ratio']:.2f}",(x['ratio'],i),xytext=(5,5),textcoords='offset points',fontsize=8)
        ax.axvline(1,color='#737b83',linestyle='--',linewidth=1)
        from matplotlib.ticker import MaxNLocator,FuncFormatter
        ax.xaxis.set_major_locator(MaxNLocator(5));ax.xaxis.set_major_formatter(FuncFormatter(lambda x,_:f'{x:.2f}'.rstrip('0').rstrip('.')))
        ax.set_yticks(range(len(paired)),labels);ax.invert_yaxis()
        ax.set_xlabel('Time ratio (below 1 = lower time)');ax.set_title(title)
    fig.suptitle('Conditional paired runtimes: both methods correctly decide every query',fontsize=12)
    fig.tight_layout(rect=(0,.02,1,.94));save(fig,'05-conditional-runtime-ratios')
    safety=[g for g in gold if g['truth_status']=='CERTIFIED' and g['property_id']!='V10a']
    before=Counter(str(g['p4_source_vacuous']) for g in safety);after=Counter(str(g['vacuous']) for g in safety)
    fig,ax=plt.subplots(figsize=(9,4.8));bottom=np.zeros(2)
    for key,label,color in [('False','Trigger reachable','#27867b'),('True','Trigger unreachable / vacuous','#d8a046'),('None','Trigger undecided','#bfc5cc')]:
        values=np.array([before[key],after[key]]);ax.bar(['P4','P5.3'],values,bottom=bottom,label=label,color=color)
        for i,v in enumerate(values):
            if v:ax.text(i,bottom[i]+v/2,f'{v:,}',ha='center',va='center',fontsize=9)
        bottom+=values
    ax.set_title('Reference trigger evidence, separate from solver performance');ax.set_ylabel('Safety / response queries')
    handles,labels=ax.get_legend_handles_labels();fig.legend(handles,labels,loc='lower center',bbox_to_anchor=(.5,.09),ncol=3,frameon=False,fontsize=8)
    fig.text(.5,.025,'V10a reachability queries excluded; multiple properties / K values are not independent samples.',ha='center',fontsize=8)
    fig.subplots_adjust(left=.10,right=.98,bottom=.25,top=.86)
    save(fig,'06-reference-trigger-review')
    primary=[]
    for m in METHODS:
        r=metrics['full_by_method'][m];c=r['counts']
        primary.append([m,r['applicable'],r['determinate'],c.get('correct',0),c.get('incorrect',0),c.get('unknown',0),
                        c.get('worker_error',0)+c.get('worker_timeout',0),percent(r['solved_coverage']),percent(r['answered_accuracy']),percent(r['correct_fraction_of_all'])])
    reviewed_ok=summary['disagreements']==0 and witness['issues']==0 and witness['verified']==witness['witnesses'] and structural['unexpected_count']==0
    status='通过' if reviewed_ok else '未通过，见分歧与见证审计记录'
    qtable=table(['方法','适用查询','确定回答','正确','错误','Unknown','worker 失败','求解覆盖率','已回答准确率','全范围正确比例'],primary)
    etable=table(['方法','预算','重复作业','全部适用查询正确决定','中位采样 RSS / MiB','最后阶段状态中位数'],
        [[r['method'],r['seconds'],r['jobs'],r['all_queries_correctly_decided'],number(r['median_sampled_rss_mb'],1),number(r['median_last_phase_states'],0)] for r in repeated])
    pair_table=table(['方法/基线','预算','共同正确完成作业','场景簇','搜索时间比','95% 场景簇区间','worker 时间比'],
        [[r['method']+'/none',r['seconds'],r['joint_correctly_decided'],r['search_time_ratio']['scene_clusters'],number(r['search_time_ratio']['ratio']),
          '—' if r['search_time_ratio']['ci95'] is None else '–'.join(number(x) for x in r['search_time_ratio']['ci95']),number(r['worker_time_ratio']['ratio'])] for r in paired])
    roles=table(['方法','维度','适用查询','求解覆盖率','已回答准确率','全范围正确比例'],
        [[key.split('|')[0],key.split('|')[1],r['applicable'],percent(r['solved_coverage']),percent(r['answered_accuracy']),percent(r['correct_fraction_of_all'])] for key,r in metrics['full_by_role'].items()])
    strata=table(['方法','参考空真标记','适用查询','确定回答','求解覆盖率'],
        [[key.split('|')[0],key.split('|')[1],r['applicable'],r['determinate'],percent(r['solved_coverage'])] for key,r in metrics['full_by_vacuity'].items()])
    classes=defaultdict(Counter)
    for row in read_rows(scores/'query-scores.jsonl'):
        if row['role']=='full' and row['outcome']!='not_applicable':classes[row['method'],row['gold_verdict']][row['outcome']]+=1
    class_table=table(['方法','参考结论类别','查询数','正确决定','该类正确比例'],
        [[m,v,sum(c.values()),c['correct'],percent(c['correct']/sum(c.values()))] for (m,v),c in sorted(classes.items())])
    minimum=min(metrics['full_by_method'][m]['solved_coverage'] for m in METHODS)
    maximum=max(metrics['full_by_method'][m]['solved_coverage'] for m in METHODS)
    base=metrics['full_by_method']['none']['solved_coverage']
    coverage_note=(f"在本次全量 0.5 秒搜索预算下，三种方法的求解覆盖率为 {percent(minimum)}–{percent(maximum)}，"
        f"其余约 {percent(1-maximum)}–{percent(1-minimum)} 仍未决定或执行失败。相对 none，storage 增加 "
        f"{(metrics['full_by_method']['storage']['solved_coverage']-base)*100:.3f} 个百分点，portfolio 增加 "
        f"{(metrics['full_by_method']['portfolio']['solved_coverage']-base)*100:.3f} 个百分点。"
        "因此当前主要限制仍是求解覆盖，不能只凭已回答准确率判断方法已经充分验证整线。")
    text=f'''# 方法一 P5：实验结果与最终审计

最终审计状态：**{status}**。本轮完成 P5.3 的条件对应/真值审查、P5.4 的冻结实验和 P5.5 的独立评分及见证审计。以下结果适用于固定的共同查询视图和已审核语义，不代表任意 PLC 程序、真实硬件或几何可达性。

## 1. 范围、来源与实验计划

- 原语料 576 份案例、72 个父案例；360 份语义案例，216 份前端负例。结构检查结果：`{structural['structural_counts']}`，非预期分类 {structural['unexpected_count']}。前端结果不并入动态查询准确率。
- 动态共同视图 27,495 条查询，其中 26,970 条适用且具有参考结论，525 条不适用。原有 1,065 条窗口不足查询留档，以不同 ID 的显式扩展查询替换；不能把新答案回填为旧问题答案。
- 新引擎为 acverify v0.3；none 是同语义显式基线，storage 和 portfolio 为复制/存储和搜索策略消融。没有将历史 v3/v4 成绩混入本次比较。
- 冻结 {len(plan['jobs']):,} 个独立子进程作业：3,240 个全量作业和 1,296 个重复作业，单实验 worker 串行运行。全量覆盖 1,080 个案例/环境组合 × 三方法，搜索预算 0.5 秒；分层重复覆盖 24 个父案例各选一个语义成员、各环境、0.5/2 秒、三次重复。
- 样本按场景与父案例的固定哈希选择，案例块顺序固定随机种子 {plan['seed']}，块内轮换六种方法顺序。所有算法使用同一 K、触发截止、尾部和故障预算。solver 墙钟预算与模型的 60 Hz tick/响应期限是不同概念。
- 实现、问题、运行顺序和主要指标定义在运行前冻结。独立见证审计与效率区间程序在运行中补齐、在读取正式预测前固定；绘图样式随后验证。没有依据中途结果更改样本、预算或方法。

P5.3 的准入基于 `{gate['status']}`：逐阶段源码条件论证、1,080 个实例前提、3,144 个观察帧边界及先前有限双向检查。它不是机器验证整个 Python 实现的无界精化证明，可信边界须随论文结果一起说明。

执行环境：`{hardware.get('os','未记录')}`；处理器标识 `{hardware.get('processor','未记录')}`；物理核心 {hardware.get('physical_cores','—')}、逻辑 CPU {hardware.get('logical_cpus','—')}；可见内存 {number(hardware.get('total_ram_bytes',0)/1024**3,1) if hardware else '—'} GiB。硬件信息在运行期间记录，未用于改变预算或选择案例；本机不是独占实验主机。

## 2. 全量动态结果

{qtable}

**已回答准确率只针对确定回答；全范围正确比例仍把 Unknown 和 worker 失败留在分母。** 没有确定回答时准确率显示“—”，不会显示 100%。本轮 worker 状态为 `{summary['worker_statuses']}`。

{coverage_note}

![全量查询结果](01-full-query-outcomes.png)

![逐性质求解覆盖](02-property-solve-coverage.png)

![逐场景正确覆盖](03-scene-correctness-coverage.png)

## 3. 协议一致性与工艺性质分开评价

{roles}

V02/V03/V07 含生成协议的构造保证，单列为 protocol_conformance；不能据其正确率宣称能检出任意 PLC 实现错误。process_property 的统计也只涵盖这里登记的有限符号环境和性质。逐父案例、环境、性质、空真状态的明细保存在 metrics.json 和逐查询评分文件中，不把重复 K 或性质行当作独立样本。

以下是对总体覆盖的描述性分解，不作新的性能假设检验：

{strata}

空真标记 True 表示已证明触发不可达；None 表示触发待定。False 包含非空真的安全/响应性质，也包含按定义不使用空真解释的 V10a 目标可达性查询，不能把整个 False 行都称为“发生过成功动作”。

{class_table}

不同参考结论的覆盖需分别考察；只解决大量容易的保持/不可达问题，不能说明对可达目标或违规反例具有相同能力。

## 4. 重复与效率

{etable}

{pair_table}

时间比为“方法 / none”，低于 1 表示耗时较低。只对双方都正确决定全部适用查询的配对作业计算完成时间比；这个条件子集不能代表全部难例，必须与完整求解覆盖和超时率一起解释。少于三个场景簇时不计算区间。区间按父案例中位数、场景中位数分层，再进行 2,000 次场景簇自助重采样，仅描述本次选定样本。

![重复作业覆盖与采样内存](04-repeated-coverage-memory.png)

![条件配对时间比](05-conditional-runtime-ratios.png)

内存为搜索期间采样 RSS，不是操作系统强制保留的内存上限，也不保证捕获每个瞬时峰值。模型构造、搜索与见证整理、重放、worker 总耗时和父进程墙钟分别保存；超时不是正常完成耗时。portfolio 的阶段状态数可能包含重访，不将其直接解释为发现更多不同状态。

重复明细和每个案例/环境的三次最小/最大确定回答比例在 repeat-stability.json 中。测量来自一台非独占工作站；随机配对顺序减轻趋势影响，但不能据此给出硬件无关的绝对性能保证。

## 5. 参考证据与见证审计

- P4 已封存证据重新核查，无需改写性质 verdict；P5.3 额外确定 587 条全包触发记录，其中本视图使用 585 条更新。
- 本视图当前空真统计：`{admission['vacuity']}`。其中 {admission['trigger_unknown']} 条性质有结论但触发可达性待定；不会将其当作已覆盖故障处理。
- 下图只统计安全/响应性质，排除不适用空真解释的目标可达性 V10a。
- 逐查询分歧/已知触发冲突共 {summary['disagreements']} 条。{witness['witnesses']} 份不同的正向见证，经新引擎重放及参考状态/历史对应检查，验证 {witness['verified']} 份，问题 {witness['issues']} 份；共核对 {witness['verified_query_claims']} 个去重后的查询声明。见证只用于审计预测，没有反过来改写 gold。

![参考触发证据](06-reference-trigger-review.png)

## 6. 结论的使用限制

这些表格首先说明在给定预算下能决定多少问题，再说明已决定结论的准确性。即使已回答准确率很高，也不能据此宣称全场景都已验证；Unknown 是实际实验结果，需要保留。效率比只适用于共同完成的样本；若区间跨过 1 或簇数很少，不宣称稳定性能优势。

当前未建立已准入的 PLC 代码转换、性质映射和外部 PLC 工具基线，因此 **PLC 工具对比未实施**。none/storage/portfolio 不是 PLCverif、PLCopen 或其他 PLC 工具的成绩。几何可达性、真实物理和后续学习调度不属于本次方法一验证。

P4 对源任务元数据的范围说明继续有效：`required_environment_gates` 等未被定义为可执行公式的字段，不会自动变成“全部必须为真”的时序义务。本轮核查的是明确登记的独立 goal、清理和 V01–V10b；额外业务时序要求需要另行公式化后建立新查询版本。

## 7. 冻结与复现

入口和完整路径见 [README-final-p5.md](../../README-final-p5.md)。最终包链接 P5.3 admission、查询/真值、P5.4 计划与原始作业、P5.5 评分、效率、见证映射及本报告，各自以 manifest 绑定。实现与运行源码快照保留；恢复必须匹配原计划，已封存作业不因重新运行更换答案。

审核类型为 AI 技术审核，不冒称第三方人工签字。最终完成条件按作业结束、证据有效、共同范围真值完整和算法确定回答率分别核查；前三者不意味着所有算法已决定所有问题。
'''
    (output/'P5最终实验报告.md').write_text(text,encoding='utf8')
    write(output/'report-summary.json',dict(review_status='PASS' if reviewed_ok else 'FAIL',figures=figures,
        metrics=metrics['full_by_method'],reference_trigger_unknown=admission['trigger_unknown'],
        source_manifests={name:sha(root/'manifest.json') for name,root in [('review',review),('experiment',experiment),('scores',scores),('efficiency',efficiency),('witnesses',witnesses)]},
        plc_comparison_performed=False))
    seal(output,stage='P5.5-final-report',reporter_sha256=sha(__file__))
    print(dict(output=str(output),review_status='PASS' if reviewed_ok else 'FAIL',figures=len(figures)),flush=True)
