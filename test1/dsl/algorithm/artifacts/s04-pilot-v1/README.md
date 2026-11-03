# S04-P01 参考检查结果

本报告来自实际参考检查器输出；检查对象是 `s04-pilot-timed-microsteps/0.1`，不是三维运行器或完整 PLC。

- 8 个输入案例，3 个在结构/绑定阶段拒绝。
- 5 个合法结构 × 3 个环境 = 15 次模型探索。
- 每次检查 8 项性质/目标，共 120 项查询结果。
- 各探索累计访问 37,253 个状态；不同环境/案例可能重复，不是独立样本数。
- 本轮所有探索均在 256 tick、200000 状态预算内闭合。

| 案例 | 正常/延迟环境 | C1 停止确认丢失 |
| --- | --- | --- |
| S04-P01 | 成功达到独立目标 | 实际可停稳但保留 writer，attention_required |
| DS01 | 语法错误 | 未进入求解 |
| DS02 | 名义类型错误 | 未进入求解 |
| DS03 | 未知能力 | 未进入求解 |
| DV01 | bridge 门控超时，物料仍在 C1.entry | 尚未启动输送，仍因门控超时结束 |
| DV02 | 已到 C2.exit，但错请求使 verify 超时 | 停止确认未知，保留隔离 |
| DV03 | 冗余复查删除后仍成功，受保护负对照 | 停止确认未知，保留隔离 |
| DV04 | 报成功但仅到 C2.entry，V09 反例 | 停止确认未知，保留隔离 |

## 关键反例

见 [DV04 正常环境反例](S04-P01-DV04/nominal/V09.trace.json)。该程序完成 bridge 后，只核对 holder=C2 就结束。末态为 `terminal=succeeded`、`region=C2.entry`、`holder=C2`；独立任务要求 `region=C2.exit`，因此 V09 失败。

见 [DV02 等待超时轨迹](S04-P01-DV02/nominal/terminal_failed.trace.json)。物料到终点并不意味着工艺正确终止；C2 的到达检查不能用 arrive_1 的 C1 出口证据替代。

见 [停止未知轨迹](S04-P01/stop_unknown_c1/terminal_attention_required.trace.json)。设备实际 stopped 与控制器确认已停稳分开，未收到证据时保留控制许可。


## 复核与限制

JSON 汇总见 [summary.json](summary.json)，环境与工具版本见 [experiment.json](experiment.json)。每案例还有 IR、源码映射、模型指令及逐性质结果；每条轨迹附原 DSL 的行列来源，已重放通过。

全量回归为 13 项 pilot 测试；共享基础模型另有 8 项测试。手工推导预期与求解输入分离，尚无独立后端交叉证明。

`PROVED_ON_CLOSED_PILOT` 仅针对这份封闭有限模型。V09 在根成功从未发生时可能空泛成立，必须结合 V10a 和触发覆盖判断。V02/V03/通用 V10b、并行、循环、暂停、任意反馈失效、几何与物理均不在本轮结论内。

