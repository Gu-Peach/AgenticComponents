# 求解器优化实验 v4

本轮按《改进方案与完整验证-v3》的 O0 → O1 → O2 顺序推进，保持 `method1-semantics/0.2`、候选程序、任务目标、故障范围和 v3 参考答案不变。

## 实现范围

- **O0**：增加 `tools/profile_solver.py`，对状态构造、故障、消息与设备阶段的搜索开销进行剖析。剖析数据只用于诊断，不作为正式效率数据。
- **O1（部分）**：增加 `state_store.clone_state`，专门复制 JSON 形状的状态，保留可变容器别名和循环引用；非支持类型委托标准 deepcopy。规范化键仍采用 JSON，未启用未经测量的元组键替换。显式搜索可只保存见证父边，只有图导出/SMT 后端保留全部边。
- **O2（部分）**：增加目标性质选择；portfolio 在共享搜索预算内用最多 15% 运行见证搜索，再将剩余预算交给完整搜索。只有具体见证的存在性/违规结论可以提前决定，其他性质保持未决。

`none` 仍是默认实现路径；`storage` 和 `portfolio` 必须显式选择。portfolio 可能因预算分配而退化，其结果单独报告，不预设优于 storage。

O1 的持久化检查点和不可变分块、O2 的生产侧证明预处理，以及 O3–O6 的消息、时间、偏序与直接符号后端均未在本轮实现。当前搜索没有为了加速减少允许的反馈或故障分支。

## 代码与证据

| 文件 | 用途 |
| --- | --- |
| `src/acverify/state_store.py` | 状态复制及容器引用关系保持 |
| `src/acverify/query_plan.py` | 逐性质见证与共享预算的组合搜索 |
| `src/acverify/model.py`、`reduction.py` | 可选复制器接入，保持转换语义 |
| `src/acverify/backends.py` | 可选图边存储、目标性质、搜索统计 |
| `src/acverify/pipeline.py`、`cli.py` | 优化开关、证据合并与重放 |
| `tests/test_solver_optimization.py` | 与冻结 v3 的完整小模型状态图对照、别名/循环/隔离、定向搜索边界 |
| `baselines/solver-v3/` | 优化前的源码和语义规范快照，供独立进程重跑 |
| `tools/run_solver_ablation.py` | 冻结样本、预算、顺序与源码后执行配对实验 |
| `tools/report_solver_ablation.py` | 参考一致性、跨方法一致性、摘要与图表审核 |

结果见 [实验报告](artifacts/solver-v4/run/实验报告.md)；剖析记录在 `artifacts/solver-v4/profile-baseline.json` 和 `profile-optimized.json`。

## 实验范围

共 1,248 项：

1. 360 个语义案例 × baseline/storage × nominal、0.5 秒：720 项。
2. 沿用 v3 的 24 个案例 × baseline/storage/portfolio × 0.5/2 秒 × 3 次重复：432 项。
3. 同一批 24 个案例 × delayed/fault × baseline/storage × 0.5 秒：96 项；试点使用其原有强制停止丢失 profile 名称。

baseline 从快照独立进程运行，正式计时不启用剖析。搜索预算在方法间一致，另报模型构造、见证重放和 worker 总耗时。使用 v3 的 659 条查询计算全量 nominal 正确性；抽样消融只使用其中适用于样本的 35 条查询。压力组不冒充完整整线故障准确率。

## 使用与复现

在 algorithm 目录运行：

```powershell
python -B tools/acverify.py verify datasets/ac-path-v1/cases/S04-P01/case.json --workspace . --bound 3000 --seconds 2 --reduction auto --optimization storage --output artifacts/storage-example
python -B tools/acverify.py verify datasets/ac-path-v1/cases/S04-P01/case.json --workspace . --bound 3000 --seconds 2 --reduction auto --optimization portfolio --output artifacts/portfolio-example
python -B -m unittest discover -s tests -v
python -B tools/run_solver_ablation.py --workspace . --output artifacts/solver-v4-new
python -B tools/report_solver_ablation.py --workspace . --output artifacts/solver-v4-new
```

单独的 `--search witness` 模式可增加 `--target-properties V10a`；组合策略当前固定优先寻找 V09/V10a 的见证，完整组合搜索使用显式后端。仅保存父边的图不能交给 `graph_bmc`，代码会明确拒绝；通过 pipeline 请求 `z3-graph` 时自动保留边，portfolio 暂不与图 SMT 组合。

`whole_line_truth_complete` 仍为 false。求解优化不替代整线独立计时参考模型和精化证明。历史 v3 运行的源码摘要指向优化前实现，不能要求它与现在的源码相同；快照用于恢复历史实现，而不是重新填写旧摘要。
