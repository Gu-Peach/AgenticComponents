# 方法一：契约驱动的工艺执行路径验证

当前实现为 `acverify 0.2.0`，代码在 `src/acverify/`。它读取已给定的 DSL、设备/能力契约、符号场景、初态、环境及独立任务规格，构造转换模型并检查执行路径。结果写入 artifacts，不修改 oracle 标签。

本版本不生成 PLC/ST、不进行工艺规划或优化派工，也不运行三维物理。

## 已实现的链路

```text
case + DSL + contracts + initial + environment + independent task
                  ↓
       解析 / 名义绑定 / 引用与输入锁检查
                  ↓
    控制节点 × 请求协议 × 设备阶段 × 资源/物料状态
                  ↓
   显式搜索 / 等价状态约简 / 有限图 SMT 查询交叉检查
                  ↓
      逐性质结论 / 来源映射 / 反例与成功路径重放
```

模块职责：

| 模块 | 内容 |
| --- | --- |
| `frontend.py` | 复用已有 DSL 文法和类型检查；读取实际契约、场景、目标，检查消费输入的依赖锁 |
| `model.py` | 九种节点、激活/迭代身份、同 tick 观察快照、顺序仲裁、停止清理与非确定阶段响应 |
| `plant.py` | 契约资源申请、容量预留、取放/输送/加工/转位/升降效果，保留失败后的真实抽象状态 |
| `expressions.py` | T/F/U、完成请求关联、当前物料/支承/归属观测、独立任务目标 |
| `properties.py` | V01–V10 的实际检查、触发覆盖、容量/归属/资源不变量 |
| `backends.py` | 有预算的完整搜索、见证搜索，以及基于已构造有限图的 Z3 查询 |
| `reduction.py` | 已结束激活的状态压缩、受限时间平移商、契约依赖清单 |
| `diagnostics.py` | 来源定位、路径恢复、完整模型重放及输入/模型摘要校验 |
| `pipeline.py` / `cli.py` | check、build、verify、replay、benchmark；输入错误、模型缺口和性质结论分开 |

这些模块按当前规模集中实现，原方案目录中的直接符号编码、通用性质切片、局部摘要和增量求解不是空壳“已实现”功能。

build 导出用于复核的模型快照；重放仍读取原始案例及其依赖锁，不把该 JSON 当作脱离实现即可运行的通用模型交换格式。

## 使用

在 `dsl/algorithm/` 执行。已验证环境为 Python 3.10、jsonschema 4.23.0。Z3 4.16.0 安装在本地隔离 `.deps/`，已被 Git 忽略，不改全局 Python。

```powershell
# 只做输入检查
python -B tools/acverify.py check datasets/ac-path-v1/cases/S04-P01/case.json

# 导出本次转换模型、目标、控制与资源关系
python -B tools/acverify.py build datasets/ac-path-v1/cases/S04-P01/case.json --output artifacts/model.json

# 完整检查；auto 在满足条件时采用时间平移商
python -B tools/acverify.py verify datasets/ac-path-v1/cases/S04-P01/case.json --bound 256 --reduction auto --output artifacts/method1-run

# 独立目标不随弱化后的程序改变，可发现 DV04 假成功
python -B tools/acverify.py verify datasets/ac-path-v1/cases/S04-P01-DV04/case.json --bound 256 --backend z3-graph --output artifacts/method1-dv04

# 多物料/并行场景：先寻找一条成功或违例见证
python -B tools/acverify.py verify datasets/ac-path-v1/cases/S12-P03/case.json --bound 3000 --search witness --output artifacts/method1-parallel

# 重放，profile 必须与生成轨迹时一致
python -B tools/acverify.py replay datasets/ac-path-v1/cases/S04-P01-DV04/case.json --trace artifacts/method1-dv04/S04-P01-DV04/V09.trace.json

# 批量检查；默认一组指定环境/界限，不自动运行 query-plan 的全部笛卡尔积
python -B tools/acverify.py benchmark datasets/ac-path-v1/manifest.json --profile nominal --bound 256 --seconds 1 --states 20000 --quiet --summary-only --output artifacts/method1-batch
```

可选：`python -m pip install -e ".[smt]"` 后直接使用 `acverify` 入口。源目录运行无需安装本包。

`--profile nominal/delayed/fault` 用于普通 corpus；原 pilot 数据使用 `nominal/delayed/stop_unknown_c1`。同一命令只检查指定 profile，其他环境需要分别运行。

`--summary-only` 仍在内存中重放找到的见证，但只保存汇总和完整结果列表，避免为全量案例复制大量轨迹。需要单条证据时使用单案例 verify。

## 搜索与结论

- `--search complete`：搜索到闭合、界限或预算；适合性质验证。
- `--search witness`：优先向深处寻找成功或违例，找到后提前结束；其他未证明性质保持 UNKNOWN。
- `--reduction full`：不作状态约简的对照基线。
- `--reduction compact`：删除已结束激活不再读取的内部字段，保留失败/隔离状态。
- `--reduction clock`：在无绝对时刻外部事件且采用完整 BFS 时，按相对期限、消息年龄和仲裁次序合并时间平移等价状态。
- `--reduction auto`：满足条件时选 clock，否则选 compact；报告保留实际选择。

时间平移商不删除活跃截止时间、阶段年龄、接受时间或资源竞争顺序；带外部定时事件的模型不能套用。其适用性基于当前注册语义，不是对任意插件的通用等价证明。测试比较了 full/compact/clock 的结果与见证。

`VIOLATED_IN_MODEL` 必须有可重放路径。`GOAL_REACHABLE_WITHIN_BOUND` 只是存在性结论。`PROVED_ON_FINITE_MODEL` 只有在当前抽象状态空间闭合且未触及界限/预算时出现。超时、内存/状态预算用尽不算安全；有界响应的未覆盖尾窗单独标记。

触发从未出现的蕴含性质标记 vacuous。根成功从未发生时，V09 可以空泛成立，仍必须查看 V10a。合法等待、故障后的隔离和任务成功不是同一个结论。

## 请求、物料和异常语义

设备可以在控制器尚未观察到接受确认时执行，模型不会把 requesting 当作“肯定未执行”。完成消息在接受证据前到达时先关联缓存，只有接受、提供者/代次、主体和有效性都匹配才用于完成判断。过期、旧请求、异源消息被忽略。

反馈在源端保持，并按周期重新采样；已接收的有效确认成为协议状态，重复采样不重置时钟。FIFO 交付、时效、代次变更及有限枚举交叉检查见 [实验 v2](README-experiment-v2.md) 和 specs/method1-semantics-v2.json。

成功事实和当前物料状态分开。取料、移离、支承、释放、提交是不同阶段；失败不把物料恢复到作者初态。停止未知、夹持后中断或释放但未提交时保留隔离。实际停稳和停止确认是不同事件。

资源申请整组原子完成；同一配置的多个控制作用域拥有不同激活身份。跟踪能力只继承被驱动契约允许的 writer。补充检查时发现环线契约遗漏了 `circulate_once` 的授权，现已补齐为显式允许列表，未修改案例程序或独立目标。

全局故障会关闭新提交并清理在途分支。已有并行、循环、分支、有限外部事件和换盘效果；外部事件不会自动使条件成功。未知初态字段不填 true。

## 本版本的边界

1. 验证对象是声明的符号设备/协议模型。几何可达、连续运动、碰撞、加工质量和真实设备接入未验证。
2. 世界观测按 tick 读取同步当前状态；反馈消息有时延、身份、代次和年龄。未实现任意异步传感器提供者、实时墙钟或单动作暂停/恢复插件。
3. 九种控制节点已支持；当前输入适配针对项目已有的观察提供者与能力参数。新来源、结构化 Pose 参数、非顺序能力阶段或回滚策略必须先补模型，不能默认为支持。
4. 初态是无活动协议、驱动静止的新运行；已有夹紧工件可建模。从运行中/未知驱动或在途请求恢复需要额外模型。
5. V02/V03/V07 的部分保障来自受信任的控制器构造规则，不能据此声称检出了任意第三方控制器实现缺陷。
6. `z3-graph` 对已显式构造的有限图做 SMT 可达性查询，包含路径距离约束。它是编码交叉检查，**不是直接对契约变量做符号 BMC，也不作为可扩展性优势的证据**。不完整图上的 UNSAT 不会被报告为安全证明。
7. 反例重放与搜索共用转换语义。手写边界测试和双后端检查可以发现部分错误，仍不是独立工业真值。不会把本算法输出回填为数据集标准答案。
8. 通用性质驱动切片、局部摘要、增量缓存及直接符号 SMT 后端仍是后续优化。方法二的 PLC 生成/等价和方法三的优化派工不在本实现内。

只有已形式化的目标、条件和约束会被检查。任务标题中的“先加工 A 再加工 B”不会被猜测成一个额外约束，须在契约或性质中明确表达。

## 验证

```powershell
python -B tests/test_method1.py
```

测试覆盖三态条件、精确时钟、零时长、重复激活身份、并行取消、互斥分支、等待超时、物料归属、资源冲突、接受前物理副作用、停止确认丢失、提供者重启、授权缺口、输入完整性、预算、反例篡改、约简和 SMT 结果一致性。

测试使用的固定短时序夹具与数据集正常/延迟/故障环境分开。单机烟测耗时不是论文性能结论；正式对比需要固定机器、预算、输入、环境和后端，并报告 UNKNOWN 与支持范围。

当前规范为 method1-semantics/0.2。新增的核心集、压力集和独立协议测试见 [实验 v2](README-experiment-v2.md)。旧一次性反馈实验保留为历史记录，不与新语义混算。
