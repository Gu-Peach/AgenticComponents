# S04-P01 与七个变体：如何运行与理解结果

这一批包含 1 个父案例、3 个结构变体、4 个语义变体。使用现有 ac-process/0.1 的 Lisp 语法和前端，绑定到 `ac-path-v1/shared` 的实验契约。原有 `dsl/examples/t0-two-robot` 和正式设备契约保持独立。

## 本轮打通的链路

```text
case.json → 工艺解析/名义绑定 → 共享动作阶段与 S04 关系
          → 有限时序微步模型 → BFS 路径探索
          → 逐性质结果 + 目标/反例/异常轨迹 → 轨迹重放
```

父案例的输入文件在 `datasets/ac-path-v1/cases/S04-P01/`：

- `process.acp`：上料、C1 输送停稳、复查、跨带搬运、C2 输送停稳、最终核验。
- `environment.json`：设备/位置/物料别名、控制作用域、60Hz 配置和实验策略。
- `initial-state.json`：M1 初始在 S.work，夹具空、两带静止、无活动请求和许可。
- `task-spec.json`：独立目标是 M1 在 C2.exit、归属 C2、支承成立、设备停稳且许可清理完成。
- `property-set.json`：本轮支持的 V01/V04/V05/V06/V07/V08/V09/V10a。
- `query-plan.json`：三种明确环境、256 tick 界限、200000 状态预算。
- `dependencies.lock.json`：实际语义输入、前端/schema 与参考检查工具的哈希。

变体只有候选程序和变异说明不同；初态、环境、性质及独立目标引用父案例同一份文件。每个变体有自己的输入描述和依赖锁。

## 案例含义

| ID | 修改 | 正常/延迟环境下应观察到的区别 |
| --- | --- | --- |
| S04-P01 | 正常父案例 | 存在满足独立目标的成功路径 |
| DS01 | 删除闭括号 | 语法错误，禁止进入路径求解 |
| DS02 | 把物料引用传给 source | 名义类型错误 |
| DS03 | 调用不存在的能力 | 未知能力 |
| DV01 | bridge 提前到 feed_1 之前 | M1 尚在 C1.entry，门控超时；没有完成任务的路径 |
| DV02 | C2 出口证据关联 arrive_1 | 物料已到目标，但错请求导致 verify 等待超时 |
| DV03 | 删除 recheck_1 | 其他契约仍保护流程，是合法负对照 |
| DV04 | 删去末段输送并弱化最终条件 | 程序报成功而 M1 仍在 C2.entry，违反独立目标 V09 |

这些后缀均位于 `S04-P01-<后缀>` 文件夹。DV04 是一个“错误的工艺后缀替换”变异，包含删除 feed_2 和改写相应终止判断两个关联编辑，不是两个独立缺陷样本。

第三种环境专门丢失 C1 的停止确认：物理抽象状态可以已经 stopped，但没有可用停稳证据时仍需保留 writer 和 attention_required。它是有意选择的受控故障，不要求该环境下完成生产任务。

## 运行

从 `dsl/algorithm/` 执行。需要 Python 3.10+ 和现有 DSL 前端依赖 `jsonschema`。

```powershell
python -B tools/validate_foundation.py datasets/ac-path-v1
python -B tools/pilot_verify.py --output artifacts/s04-pilot-v1
python -B tools/test_pilot.py
```

只检查一个案例：

```powershell
python -B tools/pilot_verify.py --case S04-P01-DV04 --output artifacts/s04-pilot-single
```

输入或检查器修改后，默认因哈希变化拒绝运行。确认变更后显式更新锁，再运行检查：

```powershell
python -B tools/freeze_pilot.py --write
```

`artifacts/s04-pilot-v1/summary.json` 为汇总；每案例 `result.json` 为逐环境/性质结果；`nominal/V09.trace.json` 等包含逐 tick 的完整状态与事件。每条保存轨迹已通过同一完整参考模型的重放。重放验证轨迹内部一致性，不构成独立语义 oracle。

## 结论范围

这里实现的是 **S04 单物料、顺序工艺的参考检查器**，不是通用 DSL 验证算法或完整运行器。它实际读取 DSL、绑定、共享动作阶段/效果、场景资源、初态、独立目标和环境，并对每个阶段的允许整数响应时间进行非确定探索；不是根据 case_id 直接返回预设标签。

支持 seq、invoke、with-control、await；支持固定 M1、搬运与输送、原子资源授权、预留/占用/holder、控制写入和停稳。每条微步至少占一个 tick；终态不再产生业务变化。模型与完整 ac-process 运行时之间的精确模拟关系尚未证明，故结论使用 `*_PILOT` 标识。

本轮环境将观测提供者设为同步、新鲜且许可不变。停带故障模型单独使完成证据缺失，不能据此声称覆盖任意事实时延、旧 epoch、重连、重复反馈。V02、V03 和通用 V10b 未作为已实现性质报告。

接受和动作执行上界在绑定阶段检查，超出当前策略预算时返回 UNSUPPORTED_MODEL；尚未实现通用在途超时/暂停/取消清理。门控失败与 await 超时只支持无活动控制/动作的站点，其他清理路径明确不支持。没有为凑齐支持范围而默认成功。

`PROVED_ON_CLOSED_PILOT` 只在当前有限模型队列耗尽、没有触及时间/状态预算时使用；界限不足返回有界结论或 UNKNOWN。触发未出现的安全性质标记 vacuous；V09 空泛成立不等于工艺能完成。目标可达与根成功正确性分别检查。

共享父目标完全独立于候选程序的 goal 声明。预期分析放在 `oracle/S04-P01/manual-expectations.json`，参考求解不读取它；这是作者推导、待人工复核的预期，不冒充外部工具真值。当前测试验证了这组预期与工具观测一致，后续研究仍需更独立的模型/后端交叉检查。

## 接下来扩大范围时

先保持本批作为开发回归集，再实现通用 TransitionIR、并行/循环、事实有效期、协议故障和完整停止清理。其余场景与七十二父案例不能因为本批通过就标成已支持。正式设备契约迁移仍按既有清单逐项核对。

全量数据已扩展到 576 个候选输入。pilot 工具默认仍只运行具有 `s04-pilot-timed-microsteps/0.1` 标记的原八个案例；其余使用 [全量构造与检查流程](README-corpus.md)，不能直接用 pilot 的受限结论替代通用路径验证。
