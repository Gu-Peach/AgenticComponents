"""Render full/auto experiment charts without treating algorithm output as truth.

Inputs: JSONL records with case_id, scene_id, profile, method, repeat, bound,
search_budget_seconds, result, elapsed_total_seconds, worker_peak_rss_bytes.
"""
import argparse
from collections import Counter, defaultdict
import csv
import html
import json
import math
from pathlib import Path
import statistics

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np

METHODS=('full','auto')
COLORS={'full':'#31465c','auto':'#087f8c'}
NAMES={'full':'full：未优化','auto':'auto：自动约简'}
INVALID={'INVALID_INPUT','DEPENDENCY_CHANGED','DEPENDENCY_LOCK_MISSING','INCONSISTENT_ASSUMPTIONS'}
COHORTS={'semantic':None,'static':None,'contexts':set()}


def finite_number(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


def profile_of(record):
    return str(record.get('profile',record.get('result',{}).get('environment','nominal'))).split('@')[0]


def load_records(path):
    records={}; ignored=duplicates=0
    for line_no,line in enumerate(Path(path).read_text(encoding='utf-8-sig').splitlines(),1):
        if not line.strip():continue
        record=json.loads(line)
        if record.get('method') not in METHODS or not record.get('case_id'):
            ignored+=1;continue
        if not isinstance(record.get('result'),dict):record['result']={'status':record.get('status','MISSING_RESULT')}
        record.setdefault('scene_id',record['case_id'][:3])
        record.setdefault('repeat',1)
        record.setdefault('profile',record['result'].get('environment','nominal'))
        record.setdefault('bound',record['result'].get('bound_ticks'))
        record.setdefault('search_budget_seconds',None)
        key=(record['case_id'],profile_of(record),record['repeat'],record['bound'],record['search_budget_seconds'],record['method'])
        if key in records:duplicates+=1
        records[key]=record
    return list(records.values()),{'ignored_nonjob_lines':ignored,'superseded_duplicate_records':duplicates}


def complete(record):
    r=record['result']
    return (r.get('status')=='CHECKED' and r.get('finite_model_exhausted') is True and
            not r.get('limit') and not r.get('horizon_reached') and not r.get('early_witness') and
            all(x.get('valid') is True for x in r.get('replays',{}).values()))


def classification(record):
    r=record['result'];status=r.get('status',record.get('status','MISSING_RESULT'))
    if status in INVALID:return 'input'
    if complete(record):return 'complete'
    if status=='WORKER_TIMEOUT':return 'worker_timeout'
    if r.get('limit')=='TIMEOUT':return 'timeout'
    if r.get('limit')=='RESOURCE_LIMIT':return 'resource'
    if status=='CHECKED' and r.get('horizon_reached'):return 'bound'
    return 'other'


def valid_job(record):
    if COHORTS['semantic'] is not None:return record['case_id'] in COHORTS['semantic']
    return classification(record)!='input'


def static_job(record):
    if COHORTS['static'] is not None:return record['case_id'] in COHORTS['static']
    return classification(record)=='input'


def configure_cohorts(records,config):
    COHORTS['semantic']=set(config['semantic_case_ids']) if 'semantic_case_ids' in config else None
    COHORTS['static']=set(config['static_case_ids']) if 'static_case_ids' in config else None
    if COHORTS['semantic'] is not None and COHORTS['static'] is not None:
        if COHORTS['semantic'] & COHORTS['static']:raise ValueError('Semantic/static cohorts overlap')
    COHORTS['contexts']={(r['repeat'],r['bound'],r['search_budget_seconds']) for r in records}


def expected_semantic_jobs(records):
    if COHORTS['semantic'] is not None:
        return len(COHORTS['semantic'])*max(1,len(COHORTS['contexts']))
    return len([r for r in records if valid_job(r)])


def search_time(record):
    value=record['result'].get('elapsed_seconds')
    return float(value) if finite_number(value) and value>=0 else None


def total_time(record):
    value=record.get('elapsed_total_seconds')
    return float(value) if finite_number(value) and value>=0 else None


def memory_mib(record):
    value=record.get('worker_peak_rss_bytes')
    if not finite_number(value):value=record['result'].get('peak_sampled_rss_bytes')
    return float(value)/(1024**2) if finite_number(value) and value>0 else None


def pair_records(records):
    groups=defaultdict(dict)
    for r in records:
        key=(r['case_id'],profile_of(r),r['repeat'],r['bound'],r['search_budget_seconds'])
        groups[key][r['method']]=r
    pairs=[];unpaired=[];mismatched=[]
    for key,methods in groups.items():
        if set(methods)!=set(METHODS):unpaired.append(key);continue
        left,right=methods['full'],methods['auto']
        a,b=left['result'],right['result']
        if a.get('status')=='CHECKED' and b.get('status')=='CHECKED':
            if any(not r.get(name) for r in (a,b) for name in ('input_digest','model_digest','algorithm_hashes')):
                mismatched.append({'case_id':key[0],'reason':'missing input/model/algorithm digest'});continue
            if a['model_digest']!=b['model_digest'] or a.get('input_digest')!=b.get('input_digest'):
                mismatched.append({'case_id':key[0],'reason':'input/model digest differs'});continue
            if a['algorithm_hashes']!=b['algorithm_hashes']:
                mismatched.append({'case_id':key[0],'reason':'algorithm hashes differ'});continue
        pairs.append((left,right))
    return pairs,unpaired,mismatched


def conclusive_value(prop,pid):
    if not prop or prop.get('applicable') is False:return None
    verdict=prop.get('verdict')
    if verdict=='VIOLATED_IN_MODEL':return False
    if prop.get('incomplete_window'):return None
    if pid=='V10a':
        if verdict=='GOAL_REACHABLE_WITHIN_BOUND':return True
        if verdict in ('GOAL_NOT_REACHED_ON_FINITE_MODEL','GOAL_NOT_REACHED_WITHIN_BOUND'):return False
    else:
        if verdict in ('PROVED_ON_FINITE_MODEL','NO_VIOLATION_WITHIN_BOUND'):return True
    return None


def agreement(pairs,pid):
    comparable=agree=0;contradictions=[]
    for a,b in pairs:
        av=conclusive_value(a['result'].get('properties',{}).get(pid),pid)
        bv=conclusive_value(b['result'].get('properties',{}).get(pid),pid)
        if av is None or bv is None:continue
        comparable+=1
        if av==bv:agree+=1
        else:contradictions.append({'case_id':a['case_id'],'profile':profile_of(a),'repeat':a['repeat'],'bound':a['bound'],'search_budget_seconds':a['search_budget_seconds'],
                                   'full':a['result']['properties'][pid]['verdict'],
                                   'auto':b['result']['properties'][pid]['verdict']})
    return {'comparable_pairs':comparable,'compatible_pairs':agree,'contradictions':contradictions,
            'compatible_fraction':agree/comparable if comparable else None,
            'meaning':'Same bounded question, not accuracy against independent truth.'}


def conflicting_properties(a,b):
    left=a['result'].get('properties',{});right=b['result'].get('properties',{})
    conflicts=[]
    for pid in set(left)&set(right):
        av=conclusive_value(left[pid],pid);bv=conclusive_value(right[pid],pid)
        if av is not None and bv is not None and av!=bv:conflicts.append(pid)
    return sorted(conflicts)


def closed_metadata_mismatches(pairs):
    records=[]
    for a,b in pairs:
        if not(complete(a) and complete(b)):continue
        left=a['result'].get('properties',{});right=b['result'].get('properties',{})
        for pid in sorted(set(left)&set(right)):
            fields={name:{'full':left[pid].get(name),'auto':right[pid].get(name)}
                    for name in ('vacuous','trigger_reachable','applicable') if left[pid].get(name)!=right[pid].get(name)}
            if fields:records.append({'case_id':a['case_id'],'profile':profile_of(a),'repeat':a['repeat'],'property':pid,'mismatches':fields})
    return records


def compatible_closed_pairs(pairs):
    return [(a,b) for a,b in pairs if valid_job(a) and valid_job(b) and complete(a) and complete(b) and not conflicting_properties(a,b)]


def setup_style():
    for candidate in (Path('C:/Windows/Fonts/msyh.ttc'),Path('C:/Windows/Fonts/simhei.ttf')):
        if candidate.exists():
            font_manager.fontManager.addfont(str(candidate))
            plt.rcParams['font.family']=font_manager.FontProperties(fname=str(candidate)).get_name()
            break
    plt.rcParams.update({'font.size':10,'axes.titlesize':13,'axes.labelsize':10,
                         'axes.spines.top':False,'axes.spines.right':False,'axes.unicode_minus':False,
                         'figure.facecolor':'white','axes.facecolor':'white','savefig.facecolor':'white',
                         'svg.fonttype':'path','grid.color':'#e3e8ec','grid.linewidth':0.7})


def save_chart(fig,out,name,title):
    fig.suptitle(title,fontsize=16,fontweight='bold',x=.06,ha='left')
    fig.tight_layout(rect=(0,.025,1,.93))
    fig.savefig(out/(name+'.png'),dpi=180,bbox_inches='tight')
    fig.savefig(out/(name+'.svg'),bbox_inches='tight')
    plt.close(fig)
    return {'id':name,'title':title,'png':name+'.png','svg':name+'.svg'}


def no_data(ax,text):
    ax.text(.5,.5,text,ha='center',va='center',transform=ax.transAxes,color='#607080',wrap=True)
    ax.set_xticks([]);ax.set_yticks([])


def overview(records,out):
    fig,axes=plt.subplots(1,2,figsize=(12.5,5.7))
    categories=[('complete','有限模型穷尽','#087f8c'),('bound','到达时间界限','#97bdc2'),
                ('timeout','搜索超时','#de9b3b'),('worker_timeout','进程看门狗超时','#bc7532'),
                ('resource','状态/内存限制','#bd6a4c'),('input','语义组输入拒绝','#ba4e4a'),
                ('missing','缺失作业','#e0e4e8'),('other','其他未决/错误','#a1a8b3')]
    for j,m in enumerate(METHODS):
        subset=[r for r in records if r['method']==m];semantic=[r for r in subset if valid_job(r)]
        counts=Counter(classification(r) for r in semantic)
        den=expected_semantic_jobs(subset);counts['missing']=max(0,den-len(semantic))
        static=sum(static_job(r) for r in subset)
        axes[0].bar(j,static,color='#c7cdd3',label='预定义结构错误组' if j==0 else None)
        axes[0].bar(j,len(semantic),bottom=static,color=COLORS[m],alpha=.85,
                    label='预定义语义验证组' if j==0 else None)
        axes[0].text(j,len(subset)+max(len(subset)*.025,1),str(len(subset)),ha='center')
        bottom=0
        for key,label,color in categories:
            n=counts[key]
            axes[1].bar(j,n,bottom=bottom,color=color,label=label if j==0 else None)
            label_text=f'{n}\n({n/den*100:.1f}%)' if key=='complete' and den else str(n)
            if n:axes[1].text(j,bottom+n/2,label_text,ha='center',va='center',fontsize=9,color='#102530')
            bottom+=n
        rate=counts['complete']/den*100 if den else 0
    for ax in axes:ax.set_xticks(range(2),[NAMES[m] for m in METHODS]);ax.set_ylabel('验证作业数');ax.grid(axis='y');ax.set_axisbelow(True);ax.margins(y=.17)
    axes[0].set_title('固定分组，不能按结果调整分母');axes[1].set_title('语义验证组的结束原因')
    axes[0].legend(loc='upper center',bbox_to_anchor=(.5,-.12),ncol=1,frameon=False)
    axes[1].legend(loc='upper center',bbox_to_anchor=(.5,-.12),ncol=3,frameon=False,fontsize=8)
    fig.text(.06,-.11,'“穷尽”包含反例，不等于正确；语义组中的意外输入拒绝、错误与缺失均保留在覆盖率分母。',fontsize=9,color='#596876')
    return save_chart(fig,out,'01_coverage','全量覆盖与未决结果')


def verdict_bucket(prop,pid):
    if not prop:return 'unknown'
    v=prop.get('verdict')
    if v=='NOT_APPLICABLE':return 'na'
    if pid=='V09':
        if v=='VIOLATED_IN_MODEL':return 'violated'
        if v=='PROVED_ON_FINITE_MODEL':return 'vacuous' if prop.get('vacuous') else 'proved'
        if v=='NO_VIOLATION_WITHIN_BOUND':return 'bounded'
    else:
        if v=='GOAL_REACHABLE_WITHIN_BOUND':return 'reachable'
        if v=='GOAL_NOT_REACHED_ON_FINITE_MODEL':return 'unreachable'
        if v=='GOAL_NOT_REACHED_WITHIN_BOUND':return 'bounded'
    return 'unknown'


def verdict_chart(records,out):
    fig,axes=plt.subplots(2,1,figsize=(12.5,7))
    schemes={
      'V09':[('violated','发现违例','#ba4e4a'),('proved','有限模型证明（触发可达）','#087f8c'),
             ('vacuous','空泛成立','#e5c96b'),('bounded','界限内未发现','#97bdc2'),('unknown','UNKNOWN / 未给出','#c7cdd3'),('na','不适用','#eeeeee')],
      'V10a':[('reachable','找到成功见证','#087f8c'),('unreachable','有限模型内不可达','#6b83a0'),
              ('bounded','界限内未到达','#97bdc2'),('unknown','UNKNOWN / 未给出','#c7cdd3'),('na','不适用','#eeeeee')]
    }
    for ax,pid in zip(axes,('V09','V10a')):
        for j,m in enumerate(METHODS):
            method_rows=[r for r in records if r['method']==m];semantic=[r for r in method_rows if valid_job(r)]
            counts=Counter(verdict_bucket(r['result'].get('properties',{}).get(pid),pid) for r in semantic)
            counts['unknown']+=max(0,expected_semantic_jobs(method_rows)-len(semantic))
            left=0
            for key,label,color in schemes[pid]:
                n=counts[key];ax.barh(j,n,left=left,color=color,label=label if j==0 else None)
                if n>=3:ax.text(left+n/2,j,str(n),ha='center',va='center',fontsize=9)
                left+=n
        ax.set_yticks(range(2),[NAMES[m] for m in METHODS]);ax.invert_yaxis();ax.set_xlabel('路径检查作业数');ax.grid(axis='x');ax.set_axisbelow(True)
        ax.set_title('V09：程序报告成功时，独立目标是否成立？' if pid=='V09' else 'V10a：是否存在达到独立目标并成功结束的路径？',loc='left')
        ax.legend(loc='upper center',bbox_to_anchor=(.5,-.27),ncol=3,frameon=False,fontsize=9)
    fig.subplots_adjust(hspace=.8)
    return save_chart(fig,out,'02_properties','安全性与目标可达性分别统计')


def equal_axes(ax,x,y,label):
    low=min(x+y)*.8;high=max(x+y)*1.25
    low=max(low,1e-5);high=max(high,low*10)
    ax.set_xscale('log');ax.set_yscale('log');ax.set_xlim(low,high);ax.set_ylim(low,high)
    ax.plot([low,high],[low,high],'--',lw=1,color='#8a969f',label='两方法相同')
    ax.scatter(x,y,s=24,c=COLORS['auto'],alpha=.65,edgecolors='white',linewidths=.3)
    ax.set_xlabel('full '+label);ax.set_ylabel('auto '+label);ax.grid(which='major');ax.set_axisbelow(True)
    ax.legend(loc='upper left',frameon=False,fontsize=9)


def efficiency(pairs,out):
    valid=[(a,b) for a,b in pairs if valid_job(a) and valid_job(b)]
    joint=compatible_closed_pairs(valid)
    timed=[(search_time(a),search_time(b)) for a,b in joint if search_time(a) and search_time(b)]
    fig,axes=plt.subplots(1,2,figsize=(12.5,5.3))
    if timed:
        x,y=map(list,zip(*timed));equal_axes(axes[0],x,y,'搜索耗时（秒）')
        ratios=[a/b for a,b in timed];axes[0].set_title(f'双方均穷尽的配对：n={len(timed)}\n中位 full/auto 耗时比={statistics.median(ratios):.2f}')
    else:no_data(axes[0],'没有双方均完成的同配置配对，\n不计算加速比。')
    matrix=np.zeros((2,2),dtype=int)
    for a,b in valid:matrix[0 if complete(b) else 1,0 if complete(a) else 1]+=1
    axes[1].imshow(matrix,cmap='Blues',vmin=0,vmax=max(1,int(matrix.max())))
    for (i,j),v in np.ndenumerate(matrix):axes[1].text(j,i,str(v),ha='center',va='center',fontsize=20,color='white' if v>matrix.max()*.5 else '#25384b')
    axes[1].set_xticks([0,1],['full 穷尽','full 未穷尽']);axes[1].set_yticks([0,1],['auto 穷尽','auto 未穷尽'])
    axes[1].set_title(f'完整配对的覆盖矩阵（n={len(valid)}）')
    fig.text(.06,-.01,'散点在对角线下方表示 auto 更快；超时不计作完成时间；结论矛盾对不纳入耗时比。',fontsize=9,color='#596876')
    return save_chart(fig,out,'03_efficiency','配对效率与预算截断')


def cactus(records,out):
    fig,ax=plt.subplots(figsize=(12.5,5))
    maximum=0;any_completed=False
    for m in METHODS:
        rs=[r for r in records if r['method']==m and valid_job(r)]
        values=sorted(search_time(r) for r in rs if complete(r) and search_time(r) is not None and search_time(r)>0)
        den=expected_semantic_jobs([r for r in records if r['method']==m]);maximum=max(maximum,den)
        if values:
            any_completed=True
            ax.step(values,range(1,len(values)+1),where='post',color=COLORS[m],lw=2,label=f'{NAMES[m]}：{len(values)}/{den} 穷尽')
        else:ax.plot([],[],color=COLORS[m],label=f'{NAMES[m]}：0/{den} 穷尽')
    if maximum:
        ax.axhline(maximum,color='#c0c8cf',ls=':',lw=1,label='路径检查作业数（方法数相同时）')
    ax.set_xscale('log');ax.set_xlabel('有限模型穷尽所需搜索时间（秒，对数轴）');ax.set_ylabel('累计穷尽作业数');ax.grid();ax.set_axisbelow(True)
    if not any_completed:
        budgets=[r['search_budget_seconds'] for r in records if finite_number(r['search_budget_seconds'])]
        ax.set_xlim(.001,max(.01,max(budgets,default=1)*1.1))
        ax.text(.5,.45,'当前预算内没有有限模型穷尽结果',transform=ax.transAxes,ha='center',color='#607080')
    ax.legend(frameon=False,loc='upper left');ax.set_ylim(bottom=0)
    fig.text(.06,-.005,'只统计已穷尽模型；未决作业在曲线终点与总数之间形成缺口。未将多种子或多性质当成独立案例。',fontsize=9,color='#596876')
    return save_chart(fig,out,'04_cactus','求解覆盖随时间的变化')


def scene_chart(records,out):
    scenes=sorted({r['scene_id'] for r in records})
    fig,ax=plt.subplots(figsize=(12.5,5.2));x=np.arange(len(scenes));width=.34
    for offset,m in zip((-.5,.5),METHODS):
        values=[];denoms=[]
        for scene in scenes:
            rows=[r for r in records if r['scene_id']==scene and r['method']==m and valid_job(r)]
            den=(sum(cid.startswith(scene+'-') for cid in COHORTS['semantic'])*max(1,len(COHORTS['contexts']))) if COHORTS['semantic'] is not None else len(rows)
            denoms.append(den);values.append(100*sum(complete(r) for r in rows)/den if den else 0)
        bars=ax.bar(x+offset*width,values,width,color=COLORS[m],label=NAMES[m])
        for bar,v in zip(bars,values):
            if v:ax.text(bar.get_x()+bar.get_width()/2,v+1,f'{v:.0f}',ha='center',fontsize=8)
    ax.set_xticks(x,scenes);ax.set_ylim(0,112);ax.set_ylabel('有限模型穷尽比例（%）');ax.set_xlabel('场景来源');ax.grid(axis='y');ax.set_axisbelow(True);ax.legend(frameon=False)
    fig.text(.06,-.005,'每场景采用预定义语义组分母，意外拒绝/错误仍计入；同父例变体相关，不能据此宣称跨行业泛化。',fontsize=9,color='#596876')
    return save_chart(fig,out,'05_scenes','各场景的完成覆盖')


def state_chart(pairs,out):
    joint=compatible_closed_pairs(pairs)
    states=[(float(a['result']['states']),float(b['result']['states'])) for a,b in joint if a['result'].get('states',0)>0 and b['result'].get('states',0)>0]
    memories=[(memory_mib(a),memory_mib(b)) for a,b in joint if memory_mib(a) and memory_mib(b)]
    fig,axes=plt.subplots(1,2,figsize=(12.5,5.3))
    if states:
        x,y=map(list,zip(*states));equal_axes(axes[0],x,y,'访问状态数');axes[0].set_title(f'双方穷尽配对的状态规模（n={len(states)}）')
    else:no_data(axes[0],'没有双方均穷尽的状态规模配对。')
    if memories:
        x,y=map(list,zip(*memories));equal_axes(axes[1],x,y,'峰值 RSS（MiB）');axes[1].set_title(f'双方穷尽配对的进程内存（n={len(memories)}）')
    else:no_data(axes[1],'没有可比较的峰值内存记录。')
    fig.text(.06,-.005,'只比较双方穷尽且无矛盾结论的配对；RSS 含解释器和建模开销，采样峰值不是严格分配量。',fontsize=9,color='#596876')
    return save_chart(fig,out,'06_state_memory','状态空间与内存')


def aggregate(records,pairs,unpaired,mismatched,info,config,profile):
    conflicts=[{'case_id':a['case_id'],'profile':profile_of(a),'repeat':a['repeat'],'bound':a['bound'],
                'search_budget_seconds':a['search_budget_seconds'],'properties':conflicting_properties(a,b)}
               for a,b in pairs if conflicting_properties(a,b)]
    strata=sorted({(r['bound'],r['search_budget_seconds']) for r in records},key=str)
    stats={'primary_profile':profile,'methods':{},'pairing':{'pairs':len(pairs),'unpaired':len(unpaired),'mismatched':mismatched},
           'agreement':{p:agreement(pairs,p) for p in ('V09','V10a')},'input_processing':info,
           'config':config,'not_accuracy':True,'independent_oracle_available':False,
           'contradictory_pairs':conflicts,'closed_coverage_metadata_mismatches':closed_metadata_mismatches(pairs),
           'configuration_strata':[{'bound':a,'search_budget_seconds':b} for a,b in strata],
           'heterogeneous_budget_warning':len(strata)>1,
           'fixed_semantic_case_count':len(COHORTS['semantic']) if COHORTS['semantic'] is not None else None,
           'fixed_static_case_count':len(COHORTS['static']) if COHORTS['static'] is not None else None}
    for m in METHODS:
        rows=[r for r in records if r['method']==m];valid=[r for r in rows if valid_job(r)]
        counts=Counter(classification(r) for r in valid);den=expected_semantic_jobs(rows)
        counts['missing']=max(0,den-len(valid));cases={r['case_id'] for r in rows}
        static=[r for r in rows if static_job(r)]
        stats['methods'][m]={'jobs':len(rows),'unique_cases':len(cases),'outcomes':dict(counts),
            'path_jobs':den,'semantic_observed_jobs':len(valid),
            'static_jobs':len(static),'static_input_rejected_jobs':sum(classification(r)=='input' for r in static),
            'static_unexpected_accepts':sum(r['result'].get('status')=='CHECKED' for r in static),
            'input_rejected_jobs':sum(classification(r)=='input' for r in rows),
            'finite_exhaustion_rate':counts['complete']/den if den else None,
            'effective_reductions':dict(Counter(r['result'].get('reduction','none') for r in valid)),
            'V09':dict(Counter(verdict_bucket(r['result'].get('properties',{}).get('V09'),'V09') for r in valid)),
            'V10a':dict(Counter(verdict_bucket(r['result'].get('properties',{}).get('V10a'),'V10a') for r in valid))}
    joint=compatible_closed_pairs(pairs)
    ratios=[search_time(a)/search_time(b) for a,b in joint if search_time(a) and search_time(b)]
    stats['paired_complete']={'pairs':len(joint),'timed_pairs':len(ratios),'median_full_over_auto_search_time':statistics.median(ratios) if ratios else None,
        'excluded_contradictory_pairs':len(conflicts),
        'selection_bias':'Only jointly completed, logically compatible jobs; do not generalize this ratio to timeouts or all cases.'}
    return stats


def csv_output(records,out):
    with (out/'jobs.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.writer(f);writer.writerow(['case_id','scene_id','profile','method','repeat','bound','search_budget_seconds','status','end_reason','finite_exhausted','search_seconds','total_seconds','states','peak_rss_mib','V09','V09_vacuous','V10a'])
        for r in records:
            p=r['result'].get('properties',{})
            writer.writerow([r['case_id'],r['scene_id'],profile_of(r),r['method'],r['repeat'],r['bound'],r['search_budget_seconds'],
                r['result'].get('status'),classification(r),complete(r),search_time(r),total_time(r),r['result'].get('states'),memory_mib(r),
                p.get('V09',{}).get('verdict'),p.get('V09',{}).get('vacuous'),p.get('V10a',{}).get('verdict')])


def report_text(stats,charts,records):
    methods=stats['methods'];a=methods['full'];b=methods['auto'];joint=stats['paired_complete']
    percent=lambda v:'—' if v is None else f'{100*v:.1f}%'
    budget=sorted({r['search_budget_seconds'] for r in records if finite_number(r['search_budget_seconds'])})
    bounds=sorted({r['bound'] for r in records if finite_number(r['bound'])})
    text=f'''# 方法一全量 full / auto 对比

主图环境：`{stats['primary_profile']}`。时间界限：{bounds} tick；搜索预算：{budget} 秒/作业。计数以实际运行记录为准，输入拒绝和路径检查分开。

配置中的状态预算为 {stats['config'].get('state_budget','未登记')}，内存预算为 {stats['config'].get('memory_mb','未登记')} MiB，重复次数为 {stats['config'].get('repeats','未登记')}。实际方法顺序：{stats['config'].get('order','未登记')}。

本轮是有预算的探索性实验。没有独立真值，因此不计算准确率、精确率或召回率；同结论比例仅衡量同一问题下的结果兼容性。PLC/ST 对比未纳入。

| 指标 | full | auto |
| --- | ---: | ---: |
| 作业数 | {a['jobs']} | {b['jobs']} |
| 去重案例 ID 数 | {a['unique_cases']} | {b['unique_cases']} |
| 结构错误组中实际拒绝 | {a['static_input_rejected_jobs']} | {b['static_input_rejected_jobs']} |
| 语义组意外输入拒绝 | {a['outcomes'].get('input',0)} | {b['outcomes'].get('input',0)} |
| 语义组固定分母 | {a['path_jobs']} | {b['path_jobs']} |
| 有限模型穷尽 | {a['outcomes'].get('complete',0)} | {b['outcomes'].get('complete',0)} |
| 穷尽率（路径作业为分母） | {percent(a['finite_exhaustion_rate'])} | {percent(b['finite_exhaustion_rate'])} |
| 搜索超时 | {a['outcomes'].get('timeout',0)} | {b['outcomes'].get('timeout',0)} |
| 进程看门狗超时 | {a['outcomes'].get('worker_timeout',0)} | {b['outcomes'].get('worker_timeout',0)} |
| 状态/内存限制 | {a['outcomes'].get('resource',0)} | {b['outcomes'].get('resource',0)} |

“穷尽”不等于“正确”，其中可以包含反例；`PROVED_ON_FINITE_MODEL` 只针对当前声明的抽象模型。V09 在根成功从未发生时可空泛成立，必须与 V10a 分开解读。

## 配对一致性

语义组分母由配置中的案例清单固定，不能因为意外拒绝、模型错误或进程超时而缩小。结构错误组单独统计。

只比较相同案例、环境、重复编号、时间界限与预算的作业；输入/模型摘要缺失、摘要不一致或算法源码哈希不一致的对从比较中排除。有限模型证明与同界限的无违例结论可兼容，但强度不同。

| 性质 | 双方有可比较结论 | 兼容结论对 | 矛盾对 |
| --- | ---: | ---: | ---: |
'''
    for pid in ('V09','V10a'):
        ag=stats['agreement'][pid];text+=f"| {pid} | {ag['comparable_pairs']} | {ag['compatible_pairs']} | {len(ag['contradictions'])} |\n"
    text+=f"\n缺少另一方法的配置：{stats['pairing']['unpaired']}；输入/模型摘要不匹配：{len(stats['pairing']['mismatched'])}。没有可比较结论的 UNKNOWN 对不会被算成一致。\n"
    if stats['contradictory_pairs']:
        text+='\n**检测到矛盾结论，需要先检查反例、边界和模型，不能直接宣称优化正确。** 具体案例见 stats.json。\n'
    text+=f"\n双方均穷尽时的 vacuous / trigger_reachable / applicable 元数据差异共 {len(stats['closed_coverage_metadata_mismatches'])} 条，已单列诊断；它们不自动等于逻辑矛盾。\n"
    if stats['heterogeneous_budget_warning']:
        text+='\n**记录含多个界限/预算配置。** 配对按配置分层，但聚合图不能当作单一预算实验；应分别用配置子集出图。\n'
    text+='\n## 效率口径\n\n'
    if joint['median_full_over_auto_search_time'] is not None:
        text+=f"双方均穷尽、且没有矛盾结论的 {joint['timed_pairs']} 个可计时配对中，中位 `full / auto` 搜索耗时比为 **{joint['median_full_over_auto_search_time']:.2f}**。这一数字只描述该子集，不能外推到全体案例；超时不是实际完成耗时。\n"
    else:text+='没有双方均穷尽且有完整计时的配对，因此不报告加速比。\n'
    text+='\n图中使用搜索阶段耗时；jobs.csv 另存工作进程内总耗时。配置给出的计时口径为：'+str(stats['config'].get('timing','需核对运行器定义'))+'。内存为进程采样 RSS，含解释器和建模开销。\n\n'
    for c in charts:
        text+=f"## {c['title']}\n\n![{c['title']}]({c['png']})\n\n[矢量 SVG]({c['svg']})\n\n"
    text+='''## 限制与后续实验

- 本轮未提供独立真值；模板构造保障的性质不能冒充任意控制器缺陷检出率。
- 单次运行或少量重复只用于探索。正式效率结论需要随机化顺序、重复计时、固定预算和受控负载。
- 同父案例的变体、多个性质与多个界限相关，不能当作独立工业场景样本做显著性推断。
- 更高穷尽率表示在本次预算下覆盖更好；它不自动说明真实工业系统更安全。
- 数据、精确预算与完整指标分别保存在 jobs.csv、stats.json 和实验配置记录中。PNG 用于预览，SVG 用于后续排版。
'''
    return text


def html_output(out,stats,charts):
    cards=[]
    for m in METHODS:
        s=stats['methods'][m];rate=s['finite_exhaustion_rate']
        cards.append(f'<div class="card"><small>{html.escape(NAMES[m])}</small><strong>{s["outcomes"].get("complete",0)} / {s["path_jobs"]}</strong><span>有限模型穷尽 · {rate*100:.1f}%</span></div>' if rate is not None else f'<div class="card">{m} 无记录</div>')
    figs=''
    for c in charts:
        svg=(out/c['svg']).read_text(encoding='utf-8')
        svg=svg[svg.find('<svg'):]
        figs+=f'<section><h2>{html.escape(c["title"])}</h2>{svg}<p><a href="{c["png"]}">PNG</a> · <a href="{c["svg"]}">SVG</a></p></section>'
    source=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>方法一实验结果</title>
<style>body{{font:16px/1.65 "Microsoft YaHei",sans-serif;background:#f1f5f7;color:#22384a;margin:0}}main{{max-width:1220px;margin:auto;padding:42px 24px}}h1{{font-size:32px;margin-bottom:8px}}p{{color:#546979}}.cards{{display:flex;gap:18px;margin:24px 0}}.card{{background:white;padding:22px 28px;border-radius:12px;flex:1}}small,span,strong{{display:block}}strong{{font-size:30px;color:#087f8c}}section{{background:white;border-radius:12px;padding:22px;margin:22px 0}}section svg{{width:100%;height:auto}}h2{{font-size:21px}}a{{color:#087f8c}}.notice{{border-left:4px solid #de9b3b;padding:12px 18px;background:#fff8e8}}@media(max-width:700px){{.cards{{display:block}}.card{{margin-bottom:12px}}main{{padding:22px 10px}}}}</style>
<main><h1>方法一 · full / auto 全量对比</h1><p>主环境：{html.escape(stats['primary_profile'])}。图表内嵌，可离线查看。</p><div class="notice">没有独立真值，不报告准确率。超时与 UNKNOWN 单独展示；穷尽包含反例，不等于程序正确。</div><div class="cards">{''.join(cards)}</div><p><a href="report.md">完整报告</a> · <a href="jobs.csv">作业数据 CSV</a> · <a href="stats.json">指标 JSON</a></p>{figs}</main></html>'''
    (out/'index.html').write_text(source,encoding='utf-8')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--config',type=Path);parser.add_argument('--profile',default='nominal')
    args=parser.parse_args();records,info=load_records(args.input)
    config=json.loads(args.config.read_text(encoding='utf-8-sig')) if args.config else {}
    primary=[r for r in records if profile_of(r)==args.profile]
    if not primary:raise ValueError(f'No records for profile {args.profile}')
    configure_cohorts(primary,config)
    args.output.mkdir(parents=True,exist_ok=True);setup_style()
    pairs,unpaired,mismatched=pair_records(primary)
    charts=[overview(primary,args.output),verdict_chart(primary,args.output),efficiency(pairs,args.output),
            cactus(primary,args.output),scene_chart(primary,args.output),state_chart(pairs,args.output)]
    stats=aggregate(primary,pairs,unpaired,mismatched,info,config,args.profile)
    stats['other_profile_counts']=dict(Counter(profile_of(r) for r in records if profile_of(r)!=args.profile))
    (args.output/'stats.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (args.output/'charts.json').write_text(json.dumps(charts,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    csv_output(records,args.output)
    (args.output/'report.md').write_text(report_text(stats,charts,primary),encoding='utf-8')
    html_output(args.output,stats,charts)
    print(json.dumps({'jobs':len(records),'primary_jobs':len(primary),'charts':len(charts),'output':str(args.output),'agreement':stats['agreement']},ensure_ascii=False))


if __name__=='__main__':main()
