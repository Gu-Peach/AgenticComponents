"""Report checked reference truth coverage, not tested-algorithm accuracy."""
import argparse
from collections import Counter,defaultdict
import json
from pathlib import Path
import re
import sys

BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from certification.io import read,sha,write


def main(a):
    manifest=read(a.truth/'manifest.json');summary=read(a.truth/'summary.json');errors=[]
    for relative,h in manifest['files'].items():
        path=(a.truth/relative).resolve()
        if not path.is_relative_to(a.truth.resolve()) or sha(path)!=h:errors.append('Package file mismatch:'+relative)
    for relative,h in manifest['source_hashes'].items():
        if sha(BASE/relative)!=h:errors.append('Checker/kernel source mismatch:'+relative)
    if sha(BASE/'tools/audit_reference_truth_p3.py')!=manifest['auditor_sha256']:errors.append('Admission auditor source changed')
    rows=[json.loads(line) for line in (a.truth/'answers.jsonl').read_text(encoding='utf8').splitlines()]
    queries=read(a.truth/'query-registry.json')['queries'];registry={q['query_id']:q for q in queries}
    if len(rows)!=len(registry) or {r['query_id'] for r in rows}!=set(registry):errors.append('Answer coverage differs')
    counts=Counter(r['truth_status'] for r in rows)
    if dict(counts)!=summary['counts']:errors.append('Summary counts differ')
    checks=read(a.truth/'evidence-checks.json')
    for r in rows:
        if r['truth_status']!='CERTIFIED':continue
        if not r['evidence_refs']:errors.append('No evidence:'+r['query_id'])
        for path in r['evidence_refs']:
            if path not in checks or checks[path]['model_digest']!=r['model_digest']:errors.append('Wrong evidence binding:'+r['query_id'])
    test=a.test_log.read_text(encoding='utf-8-sig');m=re.search(r'Ran (\d+) tests',test)
    if not m or not test.rstrip().endswith('OK'):errors.append('Tests failed/incomplete')
    examples=[]
    for path,record in checks.items():
        if path.endswith('trace-stale-result.json.gz'):
            payload=read(a.truth/path)
            first=next((e for step in payload['steps'] for e in step['events'] if e['kind']=='response_deadline_violation'),None)
            examples.append({'case_id':record['case_id'],'profile':record['profile'],'evidence':path,'first_deadline_violation':first})
    audit={'stage':'P3','reviewer_type':'AI_technical_review','errors':errors,'tests_passed':int(m.group(1)) if m else 0,
      'query_records':len(rows),'counts':dict(counts),'evidence_files_rechecked':summary['evidence_files_rechecked'],
      'truth_coverage':summary['reference_truth_coverage'],'nonvacuous_certified':summary['nonvacuous_certified'],
      'vacuity':summary['vacuity'],'conflicts':summary['conflicts'],'response_counterexamples':examples,
      'gates':{'evidence_admission_pipeline_checked':not errors and not summary['conflicts'],
               'whole_line_truth_complete':summary['whole_line_truth_complete'],'sut_alignment_complete':False},
      'truth_manifest_sha256':sha(a.truth/'manifest.json'),'test_log_sha256':sha(a.test_log)}
    a.output.mkdir(parents=True,exist_ok=True);write(a.output/'audit.json',audit)
    render(a.output,summary,rows,audit)
    print(json.dumps(audit,ensure_ascii=False))


def render(out,s,rows,audit):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    ids=['V01','V02','V03','V04','V05','V06','V07','V08','V09','V10a','V10b']
    by=defaultdict(Counter)
    for r in rows:
        if r['truth_status']=='NOT_APPLICABLE':continue
        group='vacuous' if r['truth_status']=='CERTIFIED' and r['vacuous'] is True else 'nonvacuous' if r['truth_status']=='CERTIFIED' else 'unresolved'
        by[r['property_id']][group]+=1
    fig,ax=plt.subplots(figsize=(10,5.2),layout='constrained');left=[0.]*len(ids)
    for group,label,color in [('nonvacuous','Checked, non-vacuous','#3bb39a'),('vacuous','Checked, vacuous','#e3b65f'),('unresolved','Unresolved','#a7b1c4')]:
        values=[100*by[p][group]/sum(by[p].values()) for p in ids]
        ax.barh(ids,values,left=left,label=label,color=color);left=[a+b for a,b in zip(left,values)]
    ax.invert_yaxis();ax.set(xlim=(0,100),xlabel='Share of applicable reference queries (%)',title='P3 reference truth coverage — not algorithm accuracy')
    ax.legend(loc='upper center',bbox_to_anchor=(.5,-.13),ncol=3,frameon=False)
    fig.savefig(out/'truth-coverage.png',dpi=170);fig.savefig(out/'truth-coverage.svg');plt.close(fig)
    c=s['counts'];lines=['# P3 证据准入验收报告','',
      '**本轮生成的是冻结参考语义下的逐查询答案，不是旧算法的准确率结果。** 原 P1 查询、P2 模型、旧答案与实验输出未被覆盖。','',
      '| 项目 | 数量 |','| --- | ---: |',f"| 查询记录 | {s['queries']:,} |",f"| 已核验参考答案 | {c['CERTIFIED']:,} |",
      f"| 仍未决 | {c['UNRESOLVED']:,} |",f"| 不适用 | {c['NOT_APPLICABLE']:,} |",
      f"| 已核验且非空真 | {s['nonvacuous_certified']:,} |",f"| 已核验但为空真 | {s['vacuity'].get('True',0):,} |",
      f"| 逐份重新检查的证据文件 | {s['evidence_files_rechecked']:,} |",f"| 证据结论冲突 | {s['conflicts']} |",
      f"| P3 测试 | {audit['tests_passed']} 项通过 |",'',
      f"真值确定率为 **{s['reference_truth_coverage']:.2%}**，分母是全部适用查询。空真项单列，不作为已覆盖正常执行的安全样本；非空真中也包含初态不变量证明，不等于执行场景已充分覆盖。",'',
      '| 参考结论 | 数量 |','| --- | ---: |']
    for label in ('HOLDS','REACHABLE','VIOLATED','UNREACHABLE'):lines.append(f"| {label} | {s['verdicts'].get(label,0):,} |")
    lines+=['','## 性质覆盖','', '| 性质 | 已核验 | 未决 | 不适用 |','| --- | ---: | ---: | ---: |']
    for pid in ids:
        x=s['by_property'][pid];lines.append(f"| {pid} | {x.get('CERTIFIED',0)} | {x.get('UNRESOLVED',0)} | {x.get('NOT_APPLICABLE',0)} |")
    lines+=['','![参考真值覆盖](truth-coverage.png)','',
      'V03 尚没有本轮准入的实际查询答案；没有因为接收器看起来会拒绝坏证据，就将全部 V03 填成 HOLDS。V10b 的通过答案主要来自未接受任何请求的空真证明，不能解释为正常执行的响应保障。','',
      '## 两条有界响应反例','', '| 案例 | 环境 | 首次接受 tick | 期限 tick |','| --- | --- | ---: | ---: |']
    for x in audit['response_counterexamples']:
        e=x['first_deadline_violation'];lines.append(f"| {x['case_id']} | {x['profile']} | {e['accepted_at']} | {e['deadline']} |")
    lines+=['','这两条路径先确认新鲜 accepted，再选择 profile 允许但超过 max_age 的结果交付时延。保持值持续采样并不保证接收端最终获得新鲜证据。到期限时请求仍未完成合格响应，停止命令或 stopping 状态不能替代确认终态/合格隔离。',
      '反例在参考模型上逐步检查，绑定到对应 V10b 查询的范围。它们不自动证明旧执行器存在同一问题；修订预算或异常处理后也必须生成新模型/查询版本，不能反向修改本轮答案。','',
      '## 实现与证据边界','',
      '- 轨迹：核对初态、每一步合法转换、事件、身份与查询边界，仅支持存在性/违规结论。',
      '- 图：重新计算合法后继多重集合及可达性，不信任自报 closed；区分有界覆盖与完整闭合。',
      '- 逻辑证书：检查必经条件矛盾、最终条件蕴含目标、初始无生产者阻塞等规则前提。',
      '- 成功效果证书：无外部事件、无 par 的成功路径过近似；保留所有分支、擦除等待，只作普遍性推导。',
      '- 最终准入重新检查全部证据并独立聚合，比较结果与构造阶段一致；参考语义核心仍是可信基础，不是设备精化证明。','',
      '## 下一阶段缺口','',
      '仍有 19,163 条查询未决，主要需要并发/外部变化下的更强证书、V03 消费证据证明、更多故障和响应样本及完整图。P4 应按这些缺口扩展，不把未决当作错误或通过。',
      '另有 85 个案例涉及 required_environment_gates 元数据。生成器实际用它记录初始为 false 的事实，包含分流条件，不能直接当成必须全部变 true 的业务公式。本版只验证 V01–V10b 的正式义务、TaskSpec.goal 与清理；详见真值包 source-scope-notes.json。',
      '所有答案仍标记 sut_comparison_eligible=false。完成相应语义对应后，才能用同一查询定义评价被测算法，不能直接重算旧 v3/v4 准确率。','',
      '证据规则见 ../../docs/P3证据准入规则.md，正式答案见 ../../datasets/ac-path-v1/oracle/whole-line-p3-v1/answers.jsonl。']
    (out/'P3验收报告.md').write_text('\n'.join(lines)+'\n',encoding='utf8')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--truth',type=Path,required=True);p.add_argument('--test-log',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);main(p.parse_args())
