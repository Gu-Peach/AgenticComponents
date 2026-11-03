# T0 双机械臂双输送带的正式 Lisp 工艺

本例将 [方法一的 T0](../../method.md) 落实为现有 ac-process/0.1 源码和可复核设计产物。源文件可以被参考工具解析、降级并做有范围的绑定检查；环境固定 design_only，不能提交真实运行。

## 1 阅读入口

| 文件 | 用途 |
| --- | --- |
| [process.acp](process.acp) | 正式 Lisp 风格工艺；不是之前的缩进伪代码 |
| [cell.design.json](cell.design.json) | 场景别名、实际 DeviceSpec 引用、位置、主体登记表、控制、资源及提供者 |
| [transfer.adapter.json](transfer.adapter.json) | transfer_material 业务能力如何引用机器人 1.4 的 pick_and_place；补充条件与结构化载荷生成蓝图 |
| [process.ir.json](process.ir.json) | 从文本生成的 9 个节点 ProcessIR |
| [process.map.json](process.map.json) | 节点到源码 UTF-8 字节范围和行列的映射 |
| [process.binding.json](process.binding.json) | 具体参数、底层能力、条件/完成义务、资源及依赖哈希；明确 executable=false |

## 2 场景与工艺对应

| 源码引用 | 含义 |
| --- | --- |
| r1 / r2 | 正式 robot_UR10 的 R1 / R2 实例，基于同一设备定义分别绑定 |
| c1 / c2 | 正式 Conveyor_aankws 的 C1 / C2 实例 |
| material | 唯一物料 M，引用实际 engine_block 定义；不是对图片瓶状物料已完成标定的声明 |
| source_station | S 的取料位置，名义类型 location；台座不是自动出料设备 |
| c1_entry / c1_exit / c2_entry / c2_exit | 输送面入口/出口位置，属于 location，不伪装成 slot 或空间吸附接口 |

位置引用具有 owner_ref、geometry_ref、frame_ref 和标定状态。输送机区域 ID 与现行 observation_regions 校对；S 的支承和所有场景抓放坐标仍需准备。图片不提供机器人可达性或放置位姿证明。

```text
main
  load       R1 把 M 从 S 转移到 C1.in
  feed_1     取得 C1 writer 并启动；arrive_1 跟踪指定 M 到出口
             子节点结束后撤销 run，确认实际停稳，再退出作用域
  recheck_1  重新检查本物料/本运输请求的出口事实及 C1 停稳
  bridge     R2 把 M 从 C1.out 转移到 C2.in
  feed_2     取得 C2 writer 并启动；arrive_2 跟踪 M，退出时确认停稳
  verify     最新出口/支承/归属事实、两夹具空和两带静止均成立
```

外层 seq 有 6 个子节点；加上根和两个内部运输节点共 9 个。request 引用使用 arrive_1、bridge、arrive_2 的本次已接受身份，不能沿用上一轮或未来节点的结果。

## 3 工艺正文如何保持简洁

```lisp
(invoke load r1 transfer_material
  (args
    (material (binding material))
    (source (binding source_station))
    (target (binding c1_entry)))
  (policy normal))
```

这是正式 invoke 节点片段。material/source/target 为业务适配器声明的名义引用，运行时不将它们直接作为机器人原生参数。底层 robot_UR10 的 arguments_schema 保持原样，结构载荷仍由 robot-command@1 单独校验。

`transfer_material` 并不是现有 DeviceSpec 偷加的 implemented 行为。它是 [CapabilityAdapter Schema](../../capability-adapter.schema.json) 定义的版本化设计扩展，当前固定 pending_adapter。参考检查器验证原生定义 ID、契约/定义版本、template_ref、payload_contract_ref、基础行为及载荷蓝图的抓放顺序，并把基础条件与附加义务分别列出。

位姿组装器未来根据 location 框架、TCP、抓取偏移和实际持有偏移，生成具体 move_to_pose/grip/release/retreat steps。必须同时通过原生 RobotCommand 校验和实际路径预检查；目前的 payload_recipe 含 target_role 等设计字段，本身不是合法的原生命令，不得直接提交。

## 4 连续输送的处理

```lisp
(with-control feed_1 c1_drive (policy normal)
  (invoke arrive_1 c1 transport_to_exit
    (args (subject_id (index subjects material)))
    (policy normal)))
```

c1_drive 原子进入写入 runTag=true、speedTag=0.2 m/s，退出写 runTag=false；实际 surface_stopped 和同控制代次的退出写入确认共同决定作用域结束。持续监控、writer 仲裁和退出行为仍需实现。

transport_to_exit 使用设备实际声明的正整数 subject_id，subjects 将 M 映射为 1。跟踪动作只声明 material_claim 和父驱动依赖，不重写带速、不单独移动物料，也不重复申请父 writer。

资源冲突显式登记：C1 writer 与 R1/R2 取放区冲突，C2 writer 与 R2 取放区冲突；所有控制源均需经过同一授权服务。停止过一次不构成永久互锁。

## 5 身份、效果和证据

工艺身份是 run/node/activation/request；后端机器人需要正 DINT requestId。适配器要保留映射和参数摘要，重复发送不新建身份。物料 M 保持同一 ID，不创建替代箱体。

handoff 服务的 source_ready、target_accepting、transfer_interlock_valid 和 transfer_committed 均按同一请求/主体提供证据。holder_matches_target 是对当前 ledger 与该请求冻结目标的重新核对；supported_at_target 是当前真实支承，不是给旧 done 更新一个时间戳。

both_tools_empty 来自两台机器人当前有效持有状态。正式机器人 observation_definitions 有些条目只有 producer/meaning，尚无本 DSL 所需的完整类型/作用域元信息；不得静默假设所有原生事实都有请求范围。本例将此桥接列为运行阻塞项，不修改正式设备文件冒充已完成。

business holder 由交接服务维护，位置由共享物理世界维护。取走和放入是两次交接；预留、实际占用和持有约束分别核验。失败后保留真实物料状态，不逆向套用成功效果。

## 6 参考检查与产物更新

在 test1/dsl 目录运行（Python 3.10+，依赖 jsonschema）：

```powershell
python tools/check_design.py --example t0-two-robot
python tools/check_design.py --example all
python -m unittest discover -s tools -p "test_*.py"
```

源码、契约或检查工具有意修改后，显式更新派生产物：

```powershell
python tools/check_design.py --example t0-two-robot --write
```

默认命令只比较，不自动覆盖。依赖报告锁定源码、环境、Schema、参考绑定工具、适配器和实际 DeviceSpec 的文件哈希；变更后旧报告必须失效。验证报告本身不包含自身哈希，避免循环依赖。默认 project-root 为 AgenticComponents，允许显式引用其 test1 和 apps 下的项目文件；绝对引用和已有项目外文件被拒绝。

参考检查覆盖解析/IR、保守请求支配、显式条件键、参数名义类型、登记表、原生契约版本、位置归属/区域、输入方向/单位/限幅、实际停止规则及匹配驱动作用域。它没有完整 Environment/服务 Schema，也未完成提供者新鲜度、协议执行、物理可达或全局死锁验证。

## 7 运行门槛

process.binding.json 是 ProcessBindingReport，不是已可执行 BoundProcess。它同时列出声明和从实际依赖派生的阻塞项：共享世界、台座/抓放位置标定、原生载荷组装、生产停止保持、持续控制网关、新鲜关联事实、集中资源/交接服务、工艺运行器和独立监测。

机器人已有实验停止/重置会恢复作者基线，需要另接保留在途物料的生产 hold/stop；输送机离散行为仍标记 pending_adapter。不能修改 mode/implemented 标志或删掉 blockers 就开放运行。真实执行要由正式绑定器对能力与证据逐项验证。
