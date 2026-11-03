# P5：共同评价范围与语义准入

P5.1 的范围/差异审核已完成；P5.2 已新增独立 v0.3 执行包、查询适配和有限范围验收，见 [P5.2 实现说明](README-reference-p52.md)。下文保留 P5.1 的复现入口与旧版本门禁。P5 整体尚未全部完成。

- [分步执行与修复方案](../docs/P5逐步执行与语义对齐方案.md)
- [P5.1 审核报告](artifacts/reference-p5/P5.1范围与语义审核报告.md)
- `artifacts/reference-p5/alignment-v2/`：当前冻结范围、源文件摘要、诊断证据、检查结果与评分门禁；v1 保留为相对路径入口修复前的审核记录。

当前 `eligible_for_accuracy=false`。输入投影一致及正常路径一致不足以证明转换语义和性质一致；参考答案不能直接用于重算旧 v3/v4 准确率。

## 复现

在 `dsl/algorithm` 目录运行 Python 3.10+：

```powershell
python -B -X utf8 -m unittest discover -s tests/alignment_p5 -v
python -B -X utf8 tools/run_p5_alignment.py --workspace . --output artifacts/p5-recheck/alignment-v2
python -B -X utf8 tools/report_p5_alignment.py --audit artifacts/p5-recheck/alignment-v2
python -B -X utf8 tools/check_p5_gate.py --workspace . --audit artifacts/p5-recheck/alignment-v2
```

运行器要求新的输出目录。审计在发现差异后正常结束，保存证据；门禁检查在当前不具备可比性时退出码为 2，这是预期的拒绝，不是检查器崩溃。不得仅修改 gate 文件中的布尔值绕过检查。

| 文件 | 职责 |
| --- | --- |
| `alignment_p5/models.py` | 两侧各自解析原始案例，声明诊断环境修改 |
| `alignment_p5/projection.py` | 公共状态投影、唯一调度对照与合法边重放 |
| `alignment_p5/diagnostics.py` | 持续条件、故障域、事件守卫、监视器与响应窗口探针 |
| `alignment_p5/scope.py` | 新旧查询映射、分母和未完成义务 |
| `alignment_p5/gate.py` | 语义、性质、窗口、来源等门禁 |
| `tools/run_p5_alignment.py` | 全量绑定核查、固定样例与诊断证据 |
| `tools/check_p5_gate.py` | 实验前检查，摘要或语义条件不满足即拒绝 |
| `tests/alignment_p5/` | 可重放差异、标签/状态篡改、范围遗漏与门禁回归 |

P5.1 未修改旧被测引擎，旧 gate 继续对应 v0.2。P5.2 的新 v0.3 和状态关系另行版本化；后续 P5.3 审核条件性论证与触发范围，再签发评分资格。合成边界探针不算作原语料错误案例，匹配轨迹不算作无界等价证明。
