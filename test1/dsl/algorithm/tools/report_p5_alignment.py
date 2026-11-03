"""Describe comparability findings without inventing solver accuracy metrics."""
import argparse
from pathlib import Path
import sys
BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from alignment_p5.io import read,write,sha,verify_files

ISSUES=[
 ('D01-device-hold','接受确认前的设备持续条件','许可丢失后，第 3 tick 旧算法仍抓取，参考模型已停止推进','model.py:plant_variants；独立于控制器扫描检查 sustaining_conditions'),
 ('D02-fault-packet-domain','故障报文选择范围','旧算法仅复制队首，参考环境允许任一在途包','model.py:fault_variants；枚举所有队列位置并保留原采样时间'),
 ('D03-external-conflict','外部替换资源检查','与源区冲突的别名资源已占用时，旧更新器仍搬动物料','model.py:apply_events；检查冲突闭包、活动请求及目标组容量'),
 ('D04-handoff-clause','V05 交接阶段','支承错误但账本归属一致的状态未被旧 V05 检出','properties.py / plant.py；记录阶段并核对物理、支承、归属元组'),
 ('D05-stop-evidence-clause','V07 停止证据','旧事件只检查 ack/actual_stopped 布尔值，未核对旧时间戳','保存停止写入和反馈身份、新鲜度；或证明受限生成域内等价'),
 ('D06-isolation-preservation','V08 隔离保持','只检查许可不足以覆盖失败处理器改动物料的义务','记录失败处理器前后物料状态；与独立物理阶段区分'),
 ('D07-unknown-observation','未知值传播','未知 drive 的 world 观测被旧实现返回为 False，参考返回 Unknown','expressions.py；补全三值语义与声明的表达式覆盖'),
 ('D08-response-tail-filter','V10b 查询尾部','旧监视器统计 K 后新接受请求，扩展查询只要求 K 内触发','查询适配器分别处理 K、触发截止、K+D 和隔离终态'),
 ('D09-property-trigger-points','V02/V03 触发位置','旧侧在 accepted 反馈触发 V02，参考侧在此消费 V03 证据','properties.py:edge_properties；按性质规范映射观察事件'),
 ('D10-pending-physical-stop','根流程终止条件','仍有待执行物理停止时，旧根流程提前进入 attention_required','model.py:controller；等待全部子任务和物理事件结清')]


def report(a):
    summary=read(a.audit/'summary.json');scope=read(a.audit/'evaluation-scope.json');gate=read(a.audit/'gate.json')
    verify_files(a.audit,read(a.audit/'manifest.json')['files'])
    probes={r['id']:r for r in read(a.audit/'diagnostics.json')['records']}
    lines=['| ID | 差异 | 诊断观察 | 证据范围 | 修复/证明入口 |','| --- | --- | --- | --- | --- |']
    for ident,title,finding,fix in ISSUES:
        p=probes[ident]
        lines.append(f"| [{ident}]({a.audit.name}/{p['evidence']}) | {title} | {finding} | {p['scope']} | {fix} |")
    selected_ids={q['query_id'] for q in scope['records']}
    within=sum(x['query_id'] in selected_ids for x in scope['nonvacuity_obligations'])
    text=f'''# P5.1：共同范围冻结与语义审核

本轮完成 P5 的第一步：冻结共同查询范围、核对全量输入绑定、建立可重放差异诊断及评分准入门禁。**P5 尚未全部完成，当前不能使用 P4 真值给旧求解器计算新的准确率。**

## 1. 范围冻结

- 共同评价视图：{scope['query_count']:,} 条查询，其中 26,970 条适用、525 条不适用。
- 显式替换 {scope['replaced_window_count']:,} 条窗口不足查询，记录新旧 ID、K、D、触发截止和检查终点；原问题仍保留，未回填答案。
- 保留 P4 的 {len(scope['nonvacuity_obligations']):,} 条触发状态待定记录，其中 {within:,} 条在本视图中。它们已有性质结论；后续性质准确率与触发覆盖分开报告，不自动记为错误或正常覆盖。
- `evaluation-scope.json` 不包含逐查询真值；诊断选择由场景 ID、环境和预设规则确定，不读取正确答案来挑选成功样本。
- V02/V03/V07 按协议一致性单列；其他性质也需明确构造保证与实际检错任务的边界。

P4 正式包 manifest SHA-256：`{scope['reference_manifest_sha256']}`。

## 2. 实际检查结果

| 检查 | 结果 | 可以得出的结论 |
| --- | --- | --- |
| P4 文件与源码摘要 | 全部通过 | 引用的是封存版本 |
| {summary['model_groups']:,} 个案例/环境的输入投影 | {summary['binding_statuses'].get('INPUT_PROJECTION_MATCH',0):,} 个一致 | 动作实参、节点结构、设备、位置、目标、控制作用域、环境数值和初态投影一致；不是完整绑定器等价证明 |
| 12 场景 × 最短/最长固定正常时序 | {summary['trace_statuses'].get('MATCHED_TERMINAL_PROJECTION',0)} 条终态投影一致 | 每条是声明区间内的一个确定调度；不能代表所有并发/故障路径 |
| 专项语义诊断 | {summary['diagnostic_statuses'].get('DIFFERENT',0)} 项差异 | 需要实现修复或限定域内的对应证明 |
| 专项证据重算 | {summary['probe_reproductions']} 项重现 | 使用同一实现重新生成；轨迹另做双侧合法后继重放，不冒称独立定理证明 |
| P5 评分门禁 | {gate['status']} | 暂不运行带准确率排名的正式实验 |

输入相同和正常运行样例相同，不能推出验证问题相同。专项诊断保留完整状态、事件、模型摘要和来源说明；可达轨迹通过两侧各自的后继关系重新核查。

## 3. 差异及处理顺序

{chr(10).join(lines)}

D01、D10 是从明确合成诊断初态出发、逐步可重放的执行分歧。D02、D09 基于可达前缀检查某个阶段或监视触发。其余是组件/监视器边界探针，**不声称这些构造状态可由原始语料程序到达，也不把它们混入数据集错误率**。若某种输入被当前生成协议排除，可以提交对应的域限制与保持性论证；不能仅因为未在正常样例中观察到，就宣称两侧义务一致。

单条诊断可帮助定位首个分歧，但第一分歧不等于已经找到全局最小反例。原始语料未改写；诊断收窄了程序或时序时均单独声明。

## 4. 下一步 P5.2 的验收条件

1. 在新语义版本实现物理阶段持续条件、完整报文故障域、外部事件守卫和根终止规则；保留旧 v0.2 与旧实验。
2. 补齐独立的状态/事件监视信息，按 V01–V10b 明确映射，并验证未知值、身份、阶段、支承与隔离边界。
3. 实现逐查询时间适配：全局故障预算不在 K 时重置；K 后继续既有执行至检查终点，仅按各查询范围判断违例和触发。
4. 新显式基线、storage 和 portfolio 共用对齐后的问题语义；优化仅改变求解策略，不改变允许轨迹。
5. 重新运行全量绑定、小模型完整后继集合/观察对应、双向轨迹重放和反向突变测试。普通样例一致不能自动将 `transition_relation` 标记为 PASS。

P5.3 再补充/分层报告触发覆盖，P5.4 冻结实现、预算、样本和运行顺序后重跑，P5.5 汇总准确率、求解覆盖、耗时/内存与不确定结果。历史 v3/v4 不能直接充当新语义下的基线。

当前没有已准入的 PLC 降低转换、性质映射和外部 PLC 检查器，因此本轮没有 PLC 对比成绩；显式搜索、storage、portfolio 只是算法基线与消融。

## 5. 门禁与文件

`gate.json` 必须同时满足参考完整性、输入绑定、转换语义、性质、时间窗口、对齐回归和源码冻结等条件才能开放评分。检查工具还复核审计文件及审计器源码摘要；文件缺失、源码变化或检查待定均拒绝准入。当前 `eligible_for_accuracy=false`，没有生成新的准确率或加速比。

入口：`tools/run_p5_alignment.py`、`tools/check_p5_gate.py`。结果包括 `evaluation-scope.json`、`binding-audit.json`、`trace-audit.json`、`diagnostics.json`、`evidence/` 和 `manifest.json`。测试日志与摘要在同目录上一级的 `tests.log`、`validation.json`。

审核为 AI 技术审核。P4 的条件证明可信边界继续有效；本次审计不构成真实设备安全认证、几何可达证明或任意 PLC 程序正确性证明。
'''
    target=a.audit.parent/'P5.1范围与语义审核报告.md'
    # Keep the admitted package immutable; the report is a sibling artifact.
    target.write_text(text,encoding='utf8')
    write(a.audit.parent/'report-metadata.json',dict(audit_manifest_sha256=sha(a.audit/'manifest.json'),report_sha256=sha(target),script_sha256=sha(__file__)))
    print(str(target))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--audit',type=Path,required=True);report(p.parse_args())
