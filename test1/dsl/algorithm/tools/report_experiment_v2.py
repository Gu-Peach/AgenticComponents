import argparse
from collections import Counter,defaultdict
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

def main(root):
    root=Path(root);s=json.loads((root/'summary.json').read_text(encoding='utf-8'))
    plt.rcParams.update({'font.family':'Microsoft YaHei','axes.unicode_minus':False,'svg.fonttype':'none','font.size':11})
    fig,axes=plt.subplots(1,2,figsize=(11,4.6),layout='constrained')
    for ax,pid in zip(axes,('V09','V10a')):
        for i,method in enumerate(('full','auto')):
            c=s['scores'][method+'-'+pid]['counts'];correct=c.get('correct',0);wrong=c.get('wrong',0);unknown=c.get('unresolved',0)
            ax.bar(i,correct,color='#087f8c',label='参考一致' if i==0 else None)
            ax.bar(i,wrong,bottom=correct,color='#bd4d4d',label='参考冲突' if i==0 else None)
            ax.bar(i,unknown,bottom=correct+wrong,color='#c5cdd4',label='未决' if i==0 else None)
            ax.text(i,correct/2,f'{correct}\n{correct/303:.1%}',ha='center',va='center')
            ax.text(i,correct+wrong+unknown/2,str(unknown),ha='center',va='center')
        ax.set_title(pid+'：固定分母 303 条查询');ax.set_xticks([0,1],['full','auto']);ax.set_ylabel('查询数');ax.set_ylim(0,325);ax.legend(frameon=False,loc='upper center',bbox_to_anchor=(.5,-.12),ncol=3)
    fig.suptitle('v2 核心集：正确、错误与未决同时报告')
    for ext in ('png','svg'):fig.savefig(root/f'core-results.{ext}',dpi=160,bbox_inches='tight')
    plt.close(fig)
    rows=[json.loads(x) for x in (root/'jobs.jsonl').read_text(encoding='utf-8').splitlines()]
    pressure=defaultdict(Counter)
    for row in rows:
        if row['method']!='auto':continue
        r=row['result'];category='穷尽' if r.get('finite_model_exhausted') else '超时' if r.get('limit')=='TIMEOUT' else '其他未决/错误'
        pressure[row['profile']][category]+=1
    fig,ax=plt.subplots(figsize=(10,4.5),layout='constrained');names=list(pressure)
    for i,name in enumerate(names):
        bottom=0
        for cat,color in [('穷尽','#087f8c'),('超时','#dfa049'),('其他未决/错误','#c5cdd4')]:
            n=pressure[name][cat];ax.bar(i,n,bottom=bottom,color=color,label=cat if i==0 else None)
            if n:ax.text(i,bottom+n/2,str(n),ha='center',va='center')
            bottom+=n
    ax.set_xticks(range(len(names)),names);ax.set_ylabel('作业数');ax.legend(frameon=False)
    ax.set_title('压力覆盖：nominal 为 1s，其他环境为 0.25s；不同预算不直接比较速度')
    for ext in ('png','svg'):fig.savefig(root/f'pressure-results.{ext}',dpi=160,bbox_inches='tight')
    plt.close(fig)
    lines=['# 方法一实验 v2 结果\n',
      '采用统一的保持型反馈语义。固定核心集先于算法运行建立；核心仅含 V09/V10a 的参考认证查询，不能外推为全部性质的人工审定 gold。\n',
      '| 查询 | 方法 | 参考一致 | 冲突 | 未决 | 覆盖率 |\n| --- | --- | ---: | ---: | ---: | ---: |']
    for pid in ('V09','V10a'):
        for method in ('full','auto'):
            v=s['scores'][method+'-'+pid];c=v['counts'];lines.append(f'| {pid} | {method} | {c.get("correct",0)} | {c.get("wrong",0)} | {c.get("unresolved",0)} | {v["coverage"]:.1%} |')
    lines += ['\n![核心集](core-results.png)\n','![压力集](pressure-results.png)\n',
      f'静态检查 {s["static_matches"]}/{s["static_total"]} 与参考一致；路径作业 {s["jobs"]} 全部有结束记录。核心集 303 个案例、606 条查询；协议独立参考另有 61 个有限枚举配置。\n',
      '已回答的核心查询中未发现与参考答案冲突，但未决保留在总分母中；不能把这写成“全量准确率 100%”。单次短预算结果不作为最终性能结论。\n',
      '普通 fault 与 pilot 的 stop_unknown_c1 分别记录；压力图中的 nominal/其他环境预算不同，图只描述各自覆盖，不能由柱高推断环境间性能优劣。\n',
      '完整配置见 config.json；逐作业结果见 jobs.jsonl 与 jobs/；指标与矛盾清单见 summary.json。源码在本次运行期间未变化。']
    (root/'README.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root',type=Path);a=p.parse_args();main(a.root)
