"""Audit P2 diagnostic artifacts; leave actual query truth admission to P3."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from check_reference_graphs import check_graph
from reference.frontend import load
from reference.transition import ReferenceModel
from reference.enumerate import replay

def read(p):return json.loads(Path(p).read_text(encoding='utf8'))
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(p,v):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf8')


def main(a):
    summary=read(a.validation/'summary.json');freeze=read(a.validation/'source-freeze.json');errors=list(summary['errors'])
    for path,h in freeze['reference_sources'].items():
        if sha(BASE/path)!=h:errors.append('Reference source drift:'+path)
    if sha(BASE/'tools/run_reference_p2.py')!=freeze['runner_sha256']:errors.append('Runner drift')
    if sha(a.workspace/'tools/build_standard_answers.py')!=freeze['reference_parser_sha256']:errors.append('Reference parser drift')
    if sha(a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1/manifest.json')!=freeze['P1_manifest_sha256']:errors.append('P1 inventory drift')
    graph_checks=[]
    for row in read(a.validation/'small-models.json'):
        path=a.validation/row['graph']['path']
        if sha(path)!=row['graph']['sha256']:errors.append('Small graph hash mismatch:'+row['fixture'])
        try:check=check_graph(read(path));graph_checks.append({'fixture':row['fixture'],**check})
        except Exception as e:errors.append('Graph check:'+row['fixture']+':'+str(e))
    walks=read(a.validation/'corpus-greedy.json');admission=read(a.validation/'admission.json')
    ids=read(a.workspace/'datasets/ac-path-v1/manifest.json')['subsets']['D-V']
    if {r['case_id'] for r in walks}!=set(ids) or len(walks)!=len(ids):errors.append('Incomplete/duplicate corpus walk coverage')
    trace_checks=[]
    for r in walks:
        if r.get('trace'):
            p=a.validation/r['trace']['path']
            if sha(p)!=r['trace']['sha256']:errors.append('Greedy trace drift:'+r['case_id'])
            model=ReferenceModel(load(a.workspace,r['case_id']))
            trace_checks.append({'case_id':r['case_id'],**replay(model,read(p))})
    native=read(a.validation/'native-results.json')
    for row in native:
        model=ReferenceModel(load(a.workspace,row['summary']['case_id'],row['summary']['profile']['name']))
        if model.model_digest!=row['summary']['model_digest']:errors.append('Native model differs')
        for name,w in row['witnesses'].items():
            p=a.validation/'native'/w['path']
            if sha(p)!=w['sha256']:errors.append('Native trace drift:'+name)
            trace_checks.append({'case_id':row['summary']['case_id'],'profile':row['summary']['profile']['name'],**replay(model,read(p))})
    mapping=read(a.mapping/'pilot-migration.json');comparisons=read(a.mapping/'timing-comparison.json')
    old=read(a.workspace/'datasets/ac-path-v1/oracle/whole-line-v1/query-inventory.json')['queries']
    source_ids={q['query_id'] for q in old if 'P1-PILOT-TIMING-BRIDGE' in q['blocking_issues']}
    if {r['source_query_id'] for r in mapping['records']}!=source_ids:errors.append('Pilot mapping source coverage differs')
    if len({r['target_query_id'] for r in mapping['records']})!=160:errors.append('Pilot target identities duplicate/missing')
    if any(r['equivalence_claimed'] or r['verdict'] is not None for r in mapping['records']):errors.append('Pilot migration incorrectly claims truth/equivalence')
    for r in mapping['records']:
        d=r['target'];m=ReferenceModel(load(a.workspace,d['case_id'],d['profile']))
        if d['model_digest']!=m.model_digest:errors.append('Migration model mismatch:'+d['case_id'])
    log=a.test_log.read_text(encoding='utf-8-sig');match=re.search(r'Ran (\d+) tests',log)
    tests=int(match.group(1)) if match else 0
    if not match or not log.rstrip().endswith('OK'):errors.append('Tests not successful')
    audit={'stage':'P2','reviewer_type':'AI_technical_review','errors':errors,'tests_passed':tests,
       'model_constructed':len(admission),'greedy_walks':len(walks),
       'greedy_outcomes':dict(Counter(r['outcome'] for r in walks)),
       'greedy_goal_at_end':sum(r['goal_at_end'] for r in walks),
       'greedy_counterexample_candidates':sum(bool(r['violations']) for r in walks),
       'small_graph_checks':graph_checks,'replayed_traces':len(trace_checks),'trace_checks':trace_checks,
       'native_runs':len(native),'native_closed':sum(r['summary']['finite_model_closed'] for r in native),
       'native_limits':dict(Counter(str(r['summary']['limit']) for r in native)),
       'pilot_migration_queries':len(mapping['records']),'legacy_equivalence_proved':False,
       'gates':{'artifact_integrity':not errors,'small_graphs_closed_and_checked':len(graph_checks)==12 and not errors,
         'independent_reference_package':not summary['forbidden_imports'],
         'whole_line_truth_complete':False,'P3_truth_admission_complete':False},
       'truth_labels_created':0,'test_log_sha256':sha(a.test_log),'source_freeze_sha256':sha(a.validation/'source-freeze.json')}
    write(a.output/'audit.json',audit)
    lines=['# P2 独立整线参考模型验收','',
       'P2 已提供独立转换模型、小模型闭合图及观察对应。实际查询真值仍待 P3 证据准入；没有改写旧答案或把执行样本当成全路径证明。','',
       '| 验收内容 | 结果 |','| --- | ---: |',f'| 新旧参考测试 | {tests} 项通过 |',
       f'| 语义案例装载/初态检查 | {len(admission)}/360 |',f'| 具体合法路径检查 | {len(walks)}/360 |',
       f'| 小模型闭合图及后继完整性复核 | {len(graph_checks)}/12 |',
       f"| 小模型状态总数 | {sum(x['states'] for x in graph_checks)} |",
       f"| 原区间试点枚举 | {len(native)} 项，其中 {audit['native_closed']} 项闭合 |",
       f"| 试点新身份迁移 | {len(mapping['records'])} 条 |",f'| 证据/来源错误 | {len(errors)} |','| 新建实际案例真值 | 0 |','',
       '## 具体执行样本','',
       f"360 条路径中，程序成功 {audit['greedy_outcomes'].get('succeeded',0)} 条，失败 {audit['greedy_outcomes'].get('failed',0)} 条；真正满足独立目标并成功 {audit['greedy_goal_at_end']} 条。发现 {audit['greedy_counterexample_candidates']} 条候选反例路径，需要 P3 核查后才能作为正式答案证据。",
       '', '路径选择为无可选故障、最短允许时长/时延。选择合法路径不改变原模型的分支范围，但一条失败路径不能证明目标不可达，一条成功路径也不能证明所有路径安全。',
       '', '## 原时延区间枚举','', '| 案例 | 环境 | 状态数 | 是否闭合 | 资源终止 |','| --- | --- | ---: | --- | --- |']
    for r in native:
        x=r['summary'];lines.append(f"| {x['case_id']} | {x['profile']['name']} | {x['states']} | {'是' if x['finite_model_closed'] else '否'} | {x['limit'] or '无'} |")
    lines+=['','这些枚举采用 K=256、单项 6 秒搜索预算和资源上限。超时项保留未闭合状态，不能据此产生安全或不可达答案。',
       '', '## 旧试点时间口径','', '| 案例 | 旧同步微步终止 tick | 新六阶段终止 tick |','| --- | ---: | ---: |']
    for r in comparisons['comparisons']:lines.append(f"| {r['case_id']} | {r['legacy_terminal_tick']} | {r['reference_terminal_tick']} |")
    lines+=['','上表是固定单 tick 配置的诊断比较，不是原时延范围等价证明。旧试点库存保留；迁移记录采用新的查询身份，equivalence_claimed=false。',
       '', '## 尚未闭合的义务','',
       '- P3 对实际查询的见证、反例、完整图及保持性证书检查与真值准入。',
       '- 原同步试点与新六阶段语义的有限范围对应，不能直接复用旧计时结论。',
       '- 参考与被测模型在报文故障选择、接受反馈前的设备 Hold、外部载具 quiescent 条件上的范围核查。',
       '- 大模型完整枚举及一般性的模型到实现精化证明。',
       '', '完整小模型图已逐状态重新生成合法后继并核查边集合及可达性；该检查独立于枚举循环，但仍以参考转换关系为语义核心，不代表设备/PLC 实现已经获得形式证明。',
       '', '源代码、规范与复现入口见 ../../README-reference-p2.md；转换对应表见 ../../docs/P2参考模型与转换对应.md。']
    (a.output/'P2验收报告.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
    print(json.dumps({k:v for k,v in audit.items() if k not in ('small_graph_checks','trace_checks')},ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--validation',type=Path,required=True)
    p.add_argument('--mapping',type=Path,required=True);p.add_argument('--test-log',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    main(p.parse_args())
