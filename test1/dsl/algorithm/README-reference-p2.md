# P2 独立整线参考模型

参考模型采用独立的事件安排与控制 token 解释，读取原 DSL、契约、任务和环境；不调用被测 `acverify` 的转换或搜索实现。

入口说明见 [模型与转换对应](docs/P2参考模型与转换对应.md)，实际验证结果见 [P2 验收报告](artifacts/reference-p2/P2验收报告.md)。

## 文件与能力

| 文件 | 职责 |
| --- | --- |
| `reference/frontend.py` | 复用独立解析帮助器，验证参数/阶段/资源与 profile |
| `reference/state.py` | 初态、激活身份、请求关联、终态字段管理 |
| `reference/control.py` | 顺序、并发、分支、循环、调用、驱动作用域、等待和失败 |
| `reference/plant.py` | 9 个声明动作模板的谓词、物理效果、授权与账本 |
| `reference/channel.py` | 保持信号、逐周期采样、绝对交付日期和 FIFO |
| `reference/environment.py` | 外部变化、完整载具静止条件、有预算的故障选择 |
| `reference/observations.py`、`monitors.py` | 当前事实、P1 观察帧、独立目标与响应期限 |
| `reference/transition.py` | 六阶段 tick 组合 |
| `reference/enumerate.py` | 朴素枚举与参考轨迹重放 |
| `tools/check_reference_graphs.py` | 独立于枚举循环检查完整小模型图 |

本轮没有启用时钟归约、偏序归约或直接符号后端，也没有给实际案例生成 HOLDS/UNREACHABLE 等标准答案。参考模型仍受显式状态空间规模限制。

## 试点与原范围

旧试点同步微步与六阶段语义不直接视为等价。`artifacts/reference-p2/mapping/pilot-migration.json` 为 160 条旧查询保存不同身份的迁移目标；旧 P1 库存和答案均保留，新查询需 P3 证据准入。

诊断配置、单条合法路径和原时延区间的完整枚举分别保存。报告里的 MODEL_CONSTRUCTED 只表示装载/初态检查完成；具体路径结束也不表示全状态空间闭合。

## 运行

从 algorithm 目录运行：

```powershell
python -B -m unittest discover -s tests/reference -v
python -B tools/build_p2_mapping.py --workspace . --output artifacts/reference-p2-new/mapping
python -B tools/run_reference_p2.py --workspace . --output artifacts/reference-p2-new/validation --seconds 6
python -B tools/check_reference_graphs.py artifacts/reference-p2/validation/graphs/single.json
python -B tools/report_reference_p2.py --workspace . --validation artifacts/reference-p2-new/validation --mapping artifacts/reference-p2-new/mapping --test-log artifacts/reference-p2/tests.log --output artifacts/reference-p2-new
```

`--seconds` 是每项原区间枚举的搜索预算；样例默认 K=256、30,000 状态、512 MiB 的采样 RSS/序列化状态限制，另有父进程 watchdog。RSS 不是硬隔离峰值保证。报告逐项保留超时和限制状态。

下一步是 P3：为实际查询构造并检查见证、反例、闭合或保持性证书；同时处理模型语义对应项。不能把当前轨迹或图的摘要直接当作标准答案。
