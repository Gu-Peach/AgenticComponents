# 现有实现边界与接入位置

本页按代码职责区分现有设备实验与工艺语言，避免把可导入的契约当作可运行流程。

| 范围 | 现有文件与能力 | DSL 尚需补齐 |
| --- | --- | --- |
| 设备契约 | [normalizeUnifiedDevice.ts](../../apps/src/domain/normalizeUnifiedDevice.ts) 接受 1.1/1.2/1.3，保留 DeviceSpec source；参数结构校验已存在 | 从完整 source 编译协议、资源、观测关联与服务依赖 |
| 条件 | [ConditionEvaluator.ts](../../apps/src/runtime/ConditionEvaluator.ts) 对缺键给 unknown，已有严格相等 | all/any/not、类型化来源、新鲜度、主体/请求、快照版本与持续监控 |
| 单行为预览 | [PreviewController.ts](../../apps/src/runtime/PreviewController.ts) 和 [动画接入指南](../../apps/docs/动画接入指南.md) 定义准备/运行/停止/证据路径 | 多设备共享世界与工艺运行器不能套用单预览会话 |
| 真实预览适配器 | [registerAgentAdapters.ts](../../apps/src/runtime/adapters/agent/registerAgentAdapters.ts) 注册入口为空 | 抓放、停止保持、跨设备物料/资源授权 |
| 物理实验 | [RuntimeKernel.ts](../../apps/src/runtime/engine/RuntimeKernel.ts)、[compileRuntimeScene.ts](../../apps/src/domain/runtime/compileRuntimeScene.ts) 支持受限单输送机/单物料，固定 1/60 s | 不可将单机自动停带等特例当作通用 with-control |
| 信号 | [SignalRegistry.ts](../../apps/src/runtime/engine/SignalRegistry.ts) 有效性/tick，允许 runTag/speedTag 输入和有限输出 | 多实例命名空间、完整协议投影、writer 仲裁及授权；不是完全没有信号代码 |
| 请求 | [ActionGateway.ts](../../apps/src/runtime/engine/ActionGateway.ts) 为单主体运输观察任务，重复请求抛错，依支承/出口观测给结果 | 幂等重发、摘要冲突、接受握手、停止确认、持久去重、资源释放；不能等同本文网关 |
| 模板注册 | [registerTemplates.ts](../../apps/src/runtime/templates/registerTemplates.ts) 仅注册 ConveyorTemplate | reserved 名称不是实现；机械臂/交接/载具仍待接入 |
| 历史场景 | [scene1](../docs/scene1/scene_document.json) 与其旧设备含 process_ports/事件信号 | 显式迁移；空间吸附不生成信号或授权 |
| PLC 参考 | [test.st](test.st) 有模板占位和项目特有 LADDER 文本 | 不是已展开或通过验证的 PLC 对照 |

本目录现在提供语言语义、EBNF、IR Schema、完整静态工艺及参考检查工具。参考工具能解析九种节点并生成 IR；不能称为生产编译器，也没有接入 apps 的静态绑定器或工艺运行器。当前源跨度输出以节点为单位；字段级诊断、request 引用支配关系、完整环境格式和服务契约验证仍属于正式编译器工作。

继续实现时先完成以下边界，不重复已有接触输送算法：

1. **静态编译器**：将参考前端移入可复用核心；类型系统、单位、条件必填、能力与执行器兼容、来源诊断、环境 Schema 和依赖锁定。拒绝反例而不是只接受本例。
2. **单动作协议**：接受/结果关联、重复/迟到/冲突、取消准备、停止确认、暂停恢复、未知结果隔离。现有 ActionGateway 的 cancel 不具备通用停止证据。
3. **组合与资源**：tick 顺序、控制退出、集中授权、跨控制源互锁、交接事务、par 失败传播和日志。物理位置仍由物理后端写入。
4. **闭环验收**：标定真实机器人/场景/载位；独立监测、错误轨迹和故障注入、固定种子重放。再评估可选 ST 后端。

语法/IR 设计与工具验证可以完成于设备接入之前；物理可执行性必须继续标记为未证实。
