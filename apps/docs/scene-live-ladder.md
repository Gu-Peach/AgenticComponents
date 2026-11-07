# 场景条件引擎与实时工步梯形图

PLC 面板在选中场景包时默认显示由 DSL 与行为契约生成的只读工步梯形图。设备接口详情仍可切换查看，两个视图共享同一 SceneRuntimeController 会话。

## 使用

选中已导入的 S01 → PLC → 准备候选仿真 → 运行。需要更多显示空间时使用“最大化底部面板”。每次 invoke 独立成梯级，同设备的抓放、回位和不同工步不合并为一个设备块。

- 前置、资源授权、持续和完成条件分别显示。串联是 AND，分支触点是 OR；DSL 的 par 单独表示并发分发，后面是本轮全部分支的 AND 汇合。
- “判定 @…”和“输入帧 @…”来自调度器实际求值。前置条件保留准入时的结果；设备当前端口另列，不能把后续抓取导致的夹具状态变化反向套入历史准入判断。
- 点击“判定证据”查看叶子读数、单位、质量、样本 tick、来源及未知原因。缺失、过期、断连和身份错误均不会被 NOT 转成可放行的 true。
- 循环卡片显示迭代与主体。选择激活时检查整条循环祖先链；下一轮尚未创建某动作时，不显示上一轮的 Done。
- “信号事件记录”读取真实 SignalRegistry 事件；例如接受脉冲已经恢复 false，仍可看到它实际出现的 tick、请求和激活 ID。保留最近 60 条协议事件供浏览，底层信号环容量 10000；淘汰时明确显示保留序号。条件转换环容量 512，丢失数量单独显示。
- 切换接口详情、滚动或展开条件不推进仿真。暂停冻结逻辑 tick，当前会话的请求和证据保留；重置会创建新的 runId。

若已有运行会话是在升级前准备的，先停止并重置，再刷新页面重新准备。无需为本次代码升级修改 DSL 或设备点位；若导入包本身早于 009-A 的契约迁移，仍需重新导入新包。

## 同一份条件负责执行与显示

```text
DSL / 设备契约
    ↓
compileConditions ──→ compileSceneLadder ──→ 静态梯级与来源
    ↓
ProcessScheduler.checks
    ↓
ConditionEvaluator + SceneConditionBindings
    ↓
实际判定 / ConditionTrace ──→ 同一次判定的触点、连线与证据
    ↓
现有请求网关 → 设备适配器 → 单一 Jolt 世界 → 下一完整反馈帧
```

`assembleSceneRuntime` 默认选择 `conditionMode=expression`。`compare` 使用表达式结果控制执行，同时计算原生条件用于差异审计；原生结果不参与放行。`legacy` 只保留为回归路径，正常界面不提供静默回退。结构化条件只接受明确注册且类型、单位、设备类别匹配的提供者。

作者文件中的 `execution_mode=declaration_only` 表示文件本身不授权或证明执行能力；本次准备显式选择已实现的运行 profile，并完成实例绑定。模板中的 pending 绑定说明不被当作有效反馈，也不自动写回 implemented。未知版本、悬空引用、错误单位、缺少实现、自触发前置和 Done 完成循环仍然拒绝。

opaque 只委托已经注册的原生提供者；显示为不可展开的条件块，不推测内部触点。独立批次目标、停止确认等原生检查也在实际执行时记录，不从界面重算。

## 实现文件

| 位置 | 责任 |
| --- | --- |
| `src/contracts/condition-expression.ts` | 表达式、绑定、判定与轨迹的数据结构 |
| `src/domain/runtime/compileConditions.ts` | 严格解析及类型/单位/上下文/防循环检查 |
| `src/runtime/assembly/SceneConditionBindings.ts` | 读取冻结信号、物理观测、参数、资源与请求账本 |
| `src/runtime/signals/ConditionEvaluator.ts` | 三值求值，每个绑定在一次条件求值中读取一次，记录所有叶子 |
| `src/runtime/signals/ConditionTrace.ts` | 最近判定、有界转换记录、对照计数；不让连续数值变化淹没事件环 |
| `src/runtime/scheduler/ProcessScheduler.ts` | 在真正的前置/授权/持续/完成/停止/终验位置提供上下文和记录 |
| `src/domain/runtime/compileSceneLadder.ts` | 从控制树生成梯级；S01 为 22 个梯级，无场景 ID 特判 |
| `src/domain/runtime/selectSceneActivation.ts` | 选择当前循环祖先下的激活，拒绝上一轮状态串入 |
| `src/features/plc/ladder/` | SVG 条件网络、只读工步块、并发/汇合、实时读数和证据表 |

输送适配器新增实际 drive_state 观测；机械臂新增物理放置证据、目标误差、速度与阶段完整性观测。放置证据在实际支承/持有检查成立时保存，后续交接移除物料不会抹掉本次已确认的证据；下一请求会重置它。

所有运行条件读取同一完整输入帧。signal 的质量沿用信号定义：持续许可输入保持到下一次命令，不因三 tick 没有重复写入就过期；采样型输出继续检查反馈时效。请求的接受/成功来自 RequestBook，不能使用上一请求的 Done 代替。

停止监控分别展示物理条件和请求停止确认。即使物理已停稳，也仍需匹配回执；持料时不能自动丢弃约束、释放资源或宣称交接完成。

## 验证

完整对照中，S01 三盘 36 件成功交付、三盘退出，耗时 44,874 逻辑 tick；85,285 次表达式与原生条件结果比较均一致，双臂 busy 重叠 31,263 tick。证据见 [009 条件对照](development-plans/evidence/009-condition-comparison.json)。这证明当前 S01 流程的运行一致性，不替代对所有可能输入或实体硬件的验证。

新增测试覆盖三值真值表、未知取反、重复引用单次读取、声明错误、单位/类型错误、错误 run/request/activation/subject、过期反馈与保持输入、旧 Done、事件环淘汰、循环切换前的旧状态隔离及短接受脉冲。原有资源争抢、分支冲突、超时与受控停止测试继续执行。

```powershell
node node_modules/vitest/vitest.mjs run
python -B -m unittest discover -s scripts/tests
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/next/dist/bin/next build

# 可选：对照与证据导出。比较结果不参与实际放行。
$env:AC_CONDITION_MODE = 'compare'
$env:AC_SCENE_REPORT = "$env:TEMP/ac-condition-comparison.json"
node node_modules/vitest/vitest.mjs run tests/assembly/s01-integration.test.ts
```

本界面是工艺及条件的只读梯形图监视，不是可下载到硬件的 PLC 程序。ST/LD 导出、全连杆碰撞规划和 S02–S12 整场验收仍有各自的能力与验证边界。本次未修改 public 下的契约、DSL、模型节点或坐标。


## 本次实施记录

最终默认 expression 模式通过 197 项 TypeScript 测试及正式三盘 36 件验收，31 项 Python 契约/编译测试通过；类型检查、lint 和生产构建通过。对照模式只增加比较记录，不参与放行，85,285 次比较零差异。完整记录分别为 [默认表达式运行](development-plans/evidence/009-expression-runtime.json)和[验证汇总](development-plans/evidence/009-runtime-verification.json)。

浏览器验证了准备、运行、暂停、触点/比较块着色、证据展开、短脉冲记录及视图切换不重建会话。最终[截图](development-plans/evidence/009-live-ladder.jpg)暂停在 tick 35483，显示第三盘 P03 的 request 125、准入判定 tick 29849 和实际读数；它不代替整批自动化验收。控制台未发现 error/warn。

DSL branch 当前以策略、子支路和调度器实际选择结果展示；设备的结构化条件展开为触点/比较网络。opaque 只委托已注册提供者，未使用或未实现的其他行为不会因此自动获得执行能力。
