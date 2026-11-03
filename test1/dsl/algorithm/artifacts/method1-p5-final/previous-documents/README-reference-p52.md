# P5.2：版本化执行语义修复

新包 `src/acverify_v3/` 实现 `acverify-tick/0.3`。它修复 P5.1 的 10 个诊断差异，增加状态/事件观察与显式查询时间适配。旧 `src/acverify/`、P4 真值和 P5.1 审核包保留。

- [验收报告](artifacts/reference-p52/P5.2执行语义验收报告.md)
- [状态、事件与查询对应关系](docs/P5.2状态事件对应关系.md)
- `artifacts/reference-p52/validation-v1/`：全量输入绑定、端点轨迹、有限双向关系、诊断查询、反向突变与新 gate。

P5.2 实现验收不等于整个原语料的无界等价证明。新 gate 保留 P5.3 的对应论证/触发覆盖审查与 P5.4 的实验冻结，尚不发布全范围准确率或 PLC 工具成绩。

## 运行

在 `dsl/algorithm` 执行 Python 3.10+：

```powershell
python -B -X utf8 -m unittest discover -s tests/alignment_p52 -v
python -B -X utf8 tools/acverify_v3.py --workspace . --case S10-P03-DV04 --profile nominal --queries artifacts/reference-p5/alignment-v2/evaluation-scope.json --optimization storage --seconds 2 --output artifacts/v03-example
python -B -X utf8 tools/run_p52_validation.py --workspace . --output artifacts/p52-recheck/validation-v1
python -B -X utf8 tools/report_p52_validation.py --workspace . --audit artifacts/p52-recheck/validation-v1
```

输出目录必须是新的。新 CLI 必须提供逐查询范围；不能把旧 verify 的一个 `--bound` 当作触发范围和响应尾部的替代。`--optimization` 支持 none、storage、portfolio；它们共用执行语义。暂不提供未经重新证明的 clock/POR 归约。

项目原来的 `acverify` 命令仍指向旧 v0.2，未被静默替换。使用新版本请明确调用 `tools/acverify_v3.py`。

| 模块 | 职责 |
| --- | --- |
| `model.py` | 控制扫描、激活、取消/停止、根终态与字段退役 |
| `events.py` | 全故障选择域、外部事件和设备阶段调度 |
| `channel.py` | 保持反馈、源采样、日期选择、FIFO 和有效消费 |
| `plant.py` | 实际物料效果、交接阶段和提交记录 |
| `monitor.py` | 被动性质监视、三值目标与响应历史 |
| `query.py` | 查询范围校验、按 K/C/E 过滤与保守结论 |
| `search.py` / `pipeline.py` | 同语义搜索策略、资源限制、见证和重放 |
| `alignment_p52/` | 外部输入/状态对应、完整有限检查、旧诊断重放与反向测试 |

被测引擎不导入 `reference`、`certification*` 或 `alignment_*`。原始 DSL 语法/绑定仍由冻结的辅助模块处理；这是共享输入边界，不是调用参考求解器。诊断输入收窄、测试预算以及有限证明范围均保存在验收包中。
