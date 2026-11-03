# R1 诊断与预算实验

本入口实施[下一轮方案](../docs/下一轮重点实验与PLC对比实施方案.md)中的输入冻结、独立剖析、多预算、开发集资源敏感性、现有规模分布和 K 诊断，以及已有 DSL/ST 配对候选的语法复验。新增受控节点/物料规模族及其独立证据、PLC 并发/故障对应程序和共同语义准入另列未完成义务；不能把这个批次完成写成所有 R1 要求通过。

从 algorithm 目录执行：

```powershell
python -B -X utf8 -m unittest discover -s tests/r1_experiment -p "test_*.py"
python -B -X utf8 tools/run_r1.py prepare --output datasets/ac-path-v1/experiments/next-round-v1
python -B -X utf8 tools/run_r1.py smoke --output datasets/ac-path-v1/experiments/next-round-v1
python -B -X utf8 tools/run_r1.py run --output datasets/ac-path-v1/experiments/next-round-v1
```

prepare 复查原准入门禁，只读原 P5 包；冻结所有 360 个语义案例的结构清单，复用 P5 的 24 个样本和实际 profile，补充缺失结构及 S04 原试点。正式预算作业为 24×3×4×3×3=2,592 项，搜索秒数上界 27,540（约 7.65 小时），另有剖析、资源敏感性、K 诊断、进程启动和重放开销；实际数以 plan.json 为准。

prepare 不读取参考标签内容，gold 仅保存摘要；worker 拒绝读取 oracle 和 gold/answers。源码、输入与计划摘要不匹配时拒绝续跑。作业顺序在预测前冻结，性能作业为单 worker。剖析使用相同引擎，仅在独立进程安装 cProfile/观察钩子；其计时和覆盖不作性能结论。阶段 yield 计数含上游组合，不是独立的分支倍数。

run 在原进程退出后可以续跑；活动 PID 存在时拒绝第二个 runner。完成作业不因效果重跑；非正常 attempt 保留，source/input drift 停止整个批次。运行前检查代码树安静，避免实验中修改固定源码。正式组内多条查询共用预算，Portfolio 的阶段也共用组预算。

progress.json 提供未读 gold 的完成数量、作业状态和剩余搜索预算。全部预测封存后自动连接独立 gold、生成逐查询/逐作业评分、三次一致的稳定覆盖、资源终止原因和预算曲线。报告在 artifacts/next-round-v1/。图表视觉检查、独立参考见证复核和核心机制决策不会被自动标记为通过。

当前工作站若缺少外部验证工具，plc-pilot/compatibility.json 如实记录工具 PATH 检查和已有候选 ST/功能块的 Open-Industry 编译回执。编译通过不表示扫描/时间/物料/资源/故障对应成立，也不能作为 B-STVerify 性能成绩。
