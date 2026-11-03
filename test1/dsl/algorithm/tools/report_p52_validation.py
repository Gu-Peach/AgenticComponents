import argparse
from pathlib import Path
import sys
BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from alignment_p52.models import setup


def main(a):
    setup(a.workspace)
    from alignment_p5.io import read,sha,write,verify_files
    summary=read(a.audit/'summary.json');manifest=read(a.audit/'manifest.json');verify_files(a.audit,manifest['files'])
    finite=read(a.audit/'finite-model-checks.json')['records'];gate=read(a.audit/'gate.json')
    validation=read(a.audit.parent/'validation.json') if (a.audit.parent/'validation.json').exists() else None
    test_note=f"{validation['tests_run']} 项测试通过，失败 {validation['failures']}、错误 {validation['errors']}、跳过 {validation['skipped']}。" if validation else '测试计数未附加；请核对 tests.log。'
    table=['| 诊断模型 | 双向关系 | 状态对 | 查询对照 |','| --- | --- | ---: | --- |']
    for r in finite:table.append(f"| {r['definition']['id']} | {r['relation']['status']} | {r['relation'].get('pairs',0)} | {r['query_check']['status']}（{r['query_check'].get('queries',0)}） |")
    text=f'''# P5.2：执行语义修复与查询适配验收

新实现位于 `src/acverify_v3/`，版本为 `acverify-tick/0.3`，语义标识为 `acverify-six-phase/0.3`。旧 `src/acverify/`、P5.1 审核包和 P4 参考真值均保留。运行器已核对这些旧文件的摘要没有变化。

## 1. 完成内容

- 设备每个物理阶段前检查持续条件，包含接受反馈尚未到达的阶段。
- 故障选择覆盖每个在途报文，保留源采样时间、身份变换、FIFO 和全局故障预算。
- 外部替换检查资源冲突、活动请求、预留以及目的位置/设备组容量。
- 进入隔离后仍等待未结束的物理停止，根终态不提前结束。
- 增加交接阶段、实际支承、提交记录、完整停止证据和隔离前后事实检查；修正 V02/V03 触发点与三值观察。
- 查询适配独立处理 K、触发截止与检查终点；尾部新接受请求不污染本查询，截止 tick 的有效响应优先于超时。
- none、storage、portfolio 共用新语义；storage 使用独立复制器及较少边存储，portfolio 共用总搜索预算。未准入旧 clock/POR 归约。

新求解器不导入参考转换函数、参考性质检查器或真值证书；跨实现调用只存在于外部验收代码。语法/绑定仍使用冻结的原始输入辅助模块，不能称作解析器完全独立。

## 2. 全量映射与轨迹

| 检查 | 结果 |
| --- | --- |
| 原始案例/环境模型 | {summary['models']:,} |
| 共同查询绑定 | {summary['query_bindings']:,} |
| 输入与初态关系 | {summary['input_statuses']} |
| 父案例数 | {summary['parent_cases']} |
| 父案例正常区间端点轨迹 | {summary['trace_statuses']} |
| P5.1 的 10 个诊断配方 | {summary['probe_statuses']} |

输入映射本次包含完整可执行节点意义：条件表达式、分支方式、超时、策略、循环次数、解析后的动作参数和资源/能力模型。轨迹关系除物理世界，还覆盖活动请求、定时器、待执行设备工作、消息队列、保持反馈、epoch、授权和监视状态。

正常端点轨迹仍只是声明区间内的确定调度；`PREFIX_ONLY` 不算闭合，不用它推出全场景普遍结论。P5.1 的组件边界探针继续保留原有范围说明，不作为原语料错误率的分母。

## 3. 完整有限模型与逐查询结果

{chr(10).join(table)}

合计检查 {summary['finite_pairs']:,} 个可达状态对；{summary['diagnostic_queries']} 个诊断查询与独立参考图检查器结果对照。这些查询按 V01–V10b 和多个 K 展开，**不是原始 27,495 条查询的准确率实验**。

关系检查器对每个可达状态对分别枚举两侧全部合法后继，比较两个方向的对应集合，再检查所有匹配状态组合。预算或边界耗尽明确返回 LIMIT，不记成匹配。状态关系保留被执行规则读取的信息；额外查询历史是被动记录，不授权或改变设备执行。

重新引入撤销许可后继续动作、只选择队首报文、物理停止前终止这三种缺陷，检出 {summary['mutations_detected']}/{summary['mutation_tests']}。这些反向测试验证检查器能拒绝已知错误，不等于任意错误的完备检出证明。

## 4. 求解入口和验证

{test_note}

三个求解策略的同问题语义检查：`{summary['strategies_match']}`。它使用独立输入和查询，比较结论及见证重放，不报告耗时优势或全量准确率。资源耗尽保持 UNKNOWN。旧时钟商会遗漏新增的绝对时间和历史字段，在新证明完成前不启用。

新入口是 `tools/acverify_v3.py`，必须提供显式查询集合。结果保存查询 ID、模型/实现摘要、输入摘要、策略、限制、见证和重放回执。用法见 [README-reference-p52.md](../../README-reference-p52.md)。

## 5. 本阶段边界及后续

本阶段状态：`{gate['status']}`。实现修复和规定的验收已经完成，但 `eligible_for_full_corpus_accuracy=false`。

完整小模型检查证明其声明的有限诊断范围，不能直接推出任意大模型或整个 Python 实现的无界等价。状态/事件对应论证、适用契约与域限制见 [对应关系说明](../../docs/P5.2状态事件对应关系.md)，P5.3 还需结合源码摘要审核这份条件性论证及触发覆盖义务，然后单独签发共同评分范围。

P5.4 再冻结实验预算、源码、重复及执行顺序，重跑正式算法比较。当前没有 PLC 工具对比成绩，没有改写旧结果，也没有把有限诊断一致率当作论文准确率。
'''
    target=a.audit.parent/'P5.2执行语义验收报告.md';target.write_text(text,encoding='utf8')
    write(a.audit.parent/'report-metadata.json',dict(manifest_sha256=sha(a.audit/'manifest.json'),report_sha256=sha(target),script_sha256=sha(__file__)))
    print(str(target))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--audit',type=Path,required=True);main(p.parse_args())
