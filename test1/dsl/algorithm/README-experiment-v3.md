# 方法一实验 v3

本版本补充普遍性证明、本次证据冻结、有限并发/故障参考内核和多预算重复消融。使用与 v2 相同的 `method1-semantics/0.2`，未改写原数据集答案，也未把测试结果回填为参考标签。

- [改进方案](docs/改进方案与完整验证-v3.md)：三个问题、证明思路、整线闭合条件和审核门禁。
- [运行报告](artifacts/method1-v3/验证报告.md)：以实际输出为准的结果和限制。
- `experiments/method1-v3/core.json`：356 个案例的 659 条选定查询；按查询准入，不要求案例的所有性质都有答案。
- `experiments/method1-v3/evidence/`：本次重算的逻辑证书、计时见证和成功后态证明树。
- `experiments/method1-v3/coverage.json`：27,495 条声明查询在本版本中的准入状态。未准入不等于原先参考标签错误。
- `artifacts/method1-v3/plan.json`：1,080 项全量环境作业及 648 项重复消融，样本和顺序提前固定。
- `artifacts/method1-v3/audit.json`：独立复算后的门禁和计数。

成功后态抽象用于普遍性推导；它擦除等待并保守保留路径，不提供正向可达性证明。并发交接内核为有限且无时间的参考模型。它们都不能单独证明整线计时模型与实现等价。`whole_line_truth_complete` 和 `all_queries_decided` 必须按证据分别计算，不能因运行全部结束就设置为 true。

审核类型为 AI 技术审核。旧计时见证检查器中的 `human_review: pending` 是来源元数据，不是本版要求额外找人签字的审批条件；实际阻碍列在运行报告的剩余义务中。

在 algorithm 目录下复现：

```powershell
python -B -m unittest discover -s tests -v
python -B tools/build_experiment_v3.py --workspace . --output experiments/method1-v3
python -B tools/run_experiment_v3.py --workspace . --output artifacts/method1-v3-new
python -B tools/audit_experiment_v3.py --workspace . --definition experiments/method1-v3 --output artifacts/method1-v3-new
```

运行器使用独立子进程和检查点，可在输入、实现和计划不变时恢复。更改预算或代码需另开输出目录。full、compact、auto 是本算法消融，不能称为 PLC 方法对比。
