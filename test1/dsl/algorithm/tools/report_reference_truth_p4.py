"""Report reference coverage; do not label it solver accuracy."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from certification.io import read, write, sha


def table(headers, values):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] +
                     ['| ' + ' | '.join(str(x) for x in row) + ' |' for row in values])


def main(a):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    package = a.package
    summary = read(package / 'summary.json')
    p3 = a.workspace / 'datasets/ac-path-v1/oracle/whole-line-p3-v1'
    old = read(p3 / 'summary.json')
    answers = [json.loads(line) for line in (package / 'answers.jsonl').read_text(encoding='utf8').splitlines()]
    original = [r for r in answers if r['query_set'] == 'original']
    extended = [r for r in answers if r['query_set'] == 'extended_response']
    view = read(package / 'benchmark-view.json')
    applicable = len(original) - sum(r['truth_status'] == 'NOT_APPLICABLE' for r in original)
    a.output.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})
    fig, axes = plt.subplots(1, 2, figsize=(12.5, 4.8), gridspec_kw={'width_ratios': [1, 1.65]})
    certified = [old['counts']['CERTIFIED'], sum(r['truth_status'] == 'CERTIFIED' for r in original)]
    unresolved = [applicable - v for v in certified]
    ax = axes[0]
    ax.bar(['P3', 'P4'], certified, color='#247b89', label='Certified')
    ax.bar(['P3', 'P4'], unresolved, bottom=certified, color='#e2a552', label='Unresolved')
    for i, value in enumerate(certified):
        ax.text(i, value / 2, f'{value:,}\n{value/applicable:.2%}', ha='center', va='center', color='white', fontweight='bold')
        ax.text(i, value + unresolved[i] / 2, f'{unresolved[i]:,}', ha='center', va='center', fontsize=9)
    ax.set_title(f'Original applicable queries (N={applicable:,})')
    ax.set_ylabel('Queries')
    ax.set_ylim(0, applicable * 1.06)
    ax.legend(loc='upper left', bbox_to_anchor=(-.08, -.12), ncol=2, frameon=False)
    props = sorted({r['property_id'] for r in original})
    cert_prop, unresolved_prop = [], []
    for pid in props:
        subset = [r for r in original if r['property_id'] == pid and r['truth_status'] != 'NOT_APPLICABLE']
        yes = sum(r['truth_status'] == 'CERTIFIED' for r in subset)
        cert_prop.append(100 * yes / len(subset))
        unresolved_prop.append(len(subset) - yes)
    ax = axes[1]
    ax.barh(props, cert_prop, color='#247b89')
    for i, (percentage, remaining) in enumerate(zip(cert_prop, unresolved_prop)):
        ax.text(percentage + 1, i, f'{percentage:.1f}%' + (f' ({remaining:,} open)' if remaining else ''), va='center', fontsize=9)
    ax.invert_yaxis()
    ax.set_xlim(0, 137)
    ax.set_xticks([0, 25, 50, 75, 100])
    ax.set_xlabel('Certified / applicable original queries (%)')
    ax.set_title('P4 coverage by property')
    fig.suptitle('Reference truth coverage — not algorithm accuracy', fontsize=14, fontweight='bold')
    fig.text(.5, .018, 'Original windows retained. Extended response queries are reported separately. N/A excluded.', ha='center', fontsize=9, color='#555555')
    fig.tight_layout(rect=(0, .07, 1, .94))
    fig.savefig(a.output / 'p4-coverage.png', dpi=180)
    fig.savefig(a.output / 'p4-coverage.svg')
    plt.close(fig)
    def counts(rs):
        c = Counter(r['truth_status'] for r in rs)
        denominator = len(rs) - c['NOT_APPLICABLE']
        return [len(rs), c['CERTIFIED'], c['UNRESOLVED'], c['NOT_APPLICABLE'], f"{c['CERTIFIED']/denominator:.2%}" if denominator else '—']
    original_count = Counter(r['truth_status'] for r in original)
    window_missing = [r for r in answers if r.get('unresolved_reason') == 'NO_FULL_RESPONSE_WINDOW']
    other_missing = [r for r in answers if r['truth_status'] == 'UNRESOLVED' and r not in window_missing]
    certified_rows = [r for r in answers if r['truth_status'] == 'CERTIFIED']
    proof_classes = Counter(r.get('proof_class', r.get('evidence_kind', 'P3 evidence')) for r in certified_rows)
    nonvacuous = sum(r.get('vacuous') is False for r in certified_rows)
    vacuous = sum(r.get('vacuous') is True for r in certified_rows)
    unknown_trigger = sum(r.get('vacuous') is None for r in certified_rows)
    by_id = {r['query_id']: r for r in answers}
    view_rows = [by_id[q] for q in view['query_ids']]
    residual = read(package / 'residual-graph-attempts.json') if (package / 'residual-graph-attempts.json').exists() else []
    graph_table = table(['剩余项完整图', '环境', '状态', '边', '闭合'], [
        [r['case_id'], r['profile'], r['enumeration']['states'], r['enumeration']['edges'], r['enumeration']['finite_model_closed']] for r in residual])
    validation = read(a.output / 'validation.json') if (a.output / 'validation.json').exists() else None
    test_note = (f"规则、准入与正式包完整性测试：{validation['tests_run']} 项，失败 {validation['failures']}、错误 {validation['errors']}、跳过 {validation['skipped']}。"
                 if validation else '测试结果请核对同目录 tests.log；本次报告未绑定测试计数。')
    report = f'''# P4 整线参考真值覆盖验收

P4 已处理 {summary['cases']} 个语义案例、{summary['model_groups']:,} 个案例/环境组合。保留 P3 的全部原查询，同时接纳 P1 预先登记的 V10b 扩展窗口查询。新增证据经过单独进程复查和独立汇总，未发现冲突。

这是参考真值覆盖报告，**不是被测算法准确率或 PLC 对比实验结果**。所有答案的 `sut_comparison_eligible` 仍为 false。

## 1. 查询范围与覆盖

{table(['范围', '总查询', '已认证', '未决', '不适用', '适用查询真值确定率'], [
    ['P3 原始范围', old['queries'], old['counts']['CERTIFIED'], old['counts']['UNRESOLVED'], old['counts']['NOT_APPLICABLE'], f"{old['counts']['CERTIFIED']/applicable:.2%}"],
    ['P4 同一原始范围', *counts(original)],
    ['P4 新增扩展窗口', *counts(extended)],
    ['P4 合计（两种范围）', *counts(answers)],
    ['建议评价视图（已改变窗口）', *counts(view_rows)]])}

同一原始范围新增认证 {original_count['CERTIFIED'] - old['counts']['CERTIFIED']:,} 条。{len(window_missing):,} 条旧 V10b 查询的 K 小于完整响应窗口 D，保留 `NO_FULL_RESPONSE_WINDOW`。其他原因未决 {len(other_missing)} 条。不能据扩展窗口有答案就回填旧查询。

建议评价视图仅将 {len(view['replacements']):,} 条窗口不足查询替换为明确检查到 K+D 的新查询，仍保留旧档案和映射。该视图总数为 {len(view_rows):,}，但与原范围不是同一问题集合；被测算法和基线必须先适配相同尾部检查、触发范围及故障预算。

![参考真值覆盖](p4-coverage.png)

## 2. 按性质划分（仅原查询）

{table(['性质', '已认证', '未决', '不适用'], [[pid, *[sum(r['truth_status']==s for r in original if r['property_id']==pid) for s in ('CERTIFIED','UNRESOLVED','NOT_APPLICABLE')]] for pid in props])}

## 3. 空真、触发和结论

全部已认证查询中：非空真 {nonvacuous:,}、空真 {vacuous:,}、空真状态尚未确定 {unknown_trigger:,}。最后一类已有性质证明，但尚无足以决定触发可达性的证据；不能把它们当作实际触发覆盖。可达性性质按自身语义单独处理，不能从安全性质 HOLDS 推出工艺成功。

{table(['结论', '查询数（原始及扩展合计）'], sorted(summary['verdicts'].items()))}

{table(['代表证据类别', '已认证查询数'], sorted(proof_classes.items()))}

V02/V03/V07 等结论含参考执行协议的构造保证；其他条件归纳结论依赖固定模板、初态、资源隔离和容量前提。这些结论没有证明任意 PLC 实现会遵守协议，不能直接作为错误控制器的检出率。分类依据代表证据，其他辅助证据仍保存在逐查询引用中。

延迟/故障环境存在合法的“接受反馈新鲜，但结果/停止反馈每次到达时都陈旧”的调度，因此部分 V10b 被判为 VIOLATED。保持型反馈每周期重新采样并不保证送达时仍新鲜。该结果来自固定环境与时间预算，不能为得到正例而事后调宽窗口或改写环境。

## 4. 证据审查与复现

- 新增 {summary['new_evidence_rechecked']:,} 份证据全部重新检查。
- 复用 {summary['inherited_sealed_evidence']:,} 份 P3 已封存证据；先核对 P3 整包、内核和证据摘要，本阶段未重新逐步执行所有旧轨迹。
- 重新绑定全部模型和查询，核对原查询 ID/内容、扩展查询来源、输入与依赖锁；结束时再次检查输入文件。
- 独立汇总与构造器标签差异 {summary['independent_aggregation_differences']}，证据冲突 {summary['conflicts']}。
- 规则测试涵盖真实互锁/容量反例、模板变化、并发投影拒绝、循环前序写入、短窗口、FIFO/时间戳/边界篡改及准入冲突。

{test_note}

对首轮规则仍不能决定的非窗口查询，另外尝试完整参考图。以下图的每个状态和所有合法后继在准入时重新核对；闭合证明覆盖分支不调用动作的情况，不能用一条没有请求的轨迹代替。

{graph_table}

新增证据复查耗时 {summary['elapsed_recheck_seconds']:.1f} 秒。这是单次参考证据构造流程的运行记录，不是算法对比中的配对效率或加速比。

{table(['新增证据类型', '文件数'], sorted(summary['evidence_kinds'].items()))}

正式数据：`datasets/ac-path-v1/oracle/whole-line-p4-v1/`。其中 `coverage.json` 给出性质、环境、场景和查询集合计数；`construction-features.json` 登记每个组合的控制结构、外部事件、反馈与故障预算；`remaining-obligations.json` 保留未决查询与跨阶段义务；`manifest.json` 绑定文件和代码。

## 5. 验收边界与 P5 输入

P4 的覆盖扩展、证据准入及范围登记已完成。**原查询范围仍未闭合**：窗口不足查询不被删除。建议评价视图必须被明确采纳并与被测语义对齐，才能作为另一版本的评价范围。

此外，{unknown_trigger:,} 个已认证条目的空真状态待定，不能用“所有性质都有答案”替代“所有义务都实际触发”。P3 中 85 个案例的 `required_environment_gates` 元数据范围说明继续保留，未将其解释为额外时序目标。

P5 需要完成参考与被测系统的接受身份、反馈采样/新鲜度、停止与隔离、并发和窗口映射，区分协议构造保证与可检错性质，再在共同范围重跑算法/基线。真实 PLC 映射、几何可达性和设备合规性不在本次结果内。

这些查询按性质、K 和环境展开，且原查询与扩展查询共享案例，不能把 {len(answers):,} 条记录当作独立样本。后续统计推断和数据划分应保留场景/父案例分组，避免同源变体跨集合泄漏。

审核属于 AI 技术审核。条件证明模式已给出论证、实例前提与反例测试，但不是证明助手对 Python 内核的全语义证明。详见 [P4 证明边界](../../docs/P4覆盖扩展与证明边界.md)。
'''
    (a.output / 'P4验收报告.md').write_text(report, encoding='utf8')
    write(a.output / 'report-metadata.json', {'source_manifest_sha256': sha(package / 'manifest.json'),
        'script_sha256': sha(__file__), 'kind': 'reference_truth_coverage_not_solver_accuracy',
        'original_counts': dict(original_count), 'proposed_view_scope_changed': True,
        'outputs': {name: sha(a.output / name) for name in ('P4验收报告.md', 'p4-coverage.png', 'p4-coverage.svg')}})
    print(json.dumps({'report': str(a.output / 'P4验收报告.md'), 'original': dict(original_count),
                      'new_extension': counts(extended), 'proposed_view': view['counts']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, default=BASE)
    main(parser.parse_args())
