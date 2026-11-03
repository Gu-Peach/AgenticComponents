# P1 语义澄清与范围映射

本文件与 `property-spec.json`、`reference/properties.py` 共同定义 P1 的观察义务。它没有实现整线转换关系，也不为实际案例生成真值。

## 1. 权威规则与版本

原始候选程序、TaskSpec、设备契约和查询计划保留。通用整线参考以 `method1-semantics/0.2` 为目标语义；早期 `fixed-60hz@0.1` 中不同的阶段列表不能不经映射就视为同一规则。规范化库存同时保存原 profile_scope、完整 profile_id、参数摘要、语义摘要、性质版本及原始输入摘要。

P1 的完整性质版本为 `whole-line-properties/0.1`。试点使用单独的 `pilot-properties/0.1-normalized`：V05 只要求账本/holder 一致，V06 只要求容量，V08 保留原 writer/attention 范围。试点未声明 V02、V03、V10b，不能自动补上并算作原查询。升级性质需要新查询身份。

## 2. 已明确的规则

| 编号 | 规则 | 对实现的要求 |
| --- | --- | --- |
| P1-FEEDBACK | accepted/done/stop_ack 保持并逐周期由源重新采样 | 接收和重复不刷新 sample_tick；没有最终新鲜到达的额外公平性 |
| P1-IDENTITY | 请求身份包含 activation/request/device/subject/epoch | 资源 owner_ref 使用完整身份数组；裸请求名不能替代所有权身份 |
| P1-AGE | 证据必须满足 `0 <= now-sample_tick <= max_age` | 等于年龄上限仍有效；未来时间戳、错误类型、旧 epoch 均不能确认 |
| P1-CONSUME | V03 观察决定性证据消费 | 丢弃报文和读取后返回 U 不冒充成功消费；缺少来源信息返回 UNKNOWN |
| P1-LEDGER | V05 同时区分物理位置与业务账本 | 已放置但未提交时，physical/support 可以是目标，holder/ledger 仍在工具侧 |
| P1-COMMIT | V06 检查容量和有效提交次数 | 同一 activation/request 改写 payload 不能变成新事务；幂等重复调用不产生第二次有效提交 |
| P1-FAILURE | 失败处理本身不能回滚已发生的物料效果 | 对受影响物料的失败处理微步检查前后状态；不冻结其他设备或合法 plant 微步 |
| P1-GOAL | V09/V10a 使用独立 TaskSpec | 完整整线版本还要求无活动请求和无泄漏授权；候选程序自报 goal 不能替代 TaskSpec |
| P1-DEADLINE | 首次有效接受启动时钟，截止 tick 包含在窗口内 | 同 tick 的响应先处理再检查逾期；重复 accepted 不延长期限；迟到响应不消除既有违规 |
| P1-RESPONSE | 合格响应是确认成功/失败/取消或保留必要隔离的 attention | stopping、stop-command-sent、裸 fault 不算响应；确认必须有有效关联证据 |
| P1-VACUITY | 适用性与是否触发分开 | 删除调用的变体保留原适用义务，记录空真风险；不能为了减少分母改成 N/A |
| P1-BOUNDED | 局部/单轨迹结论不等于全模型结论 | SATISFIED、TRACE_SATISFIED 不可直接写入实际数据集作为 HOLDS；单轨迹未达不等于不可达 |

## 3. V05 的完整符号交接关系

下表使用“最后完成的物理/账本效果”，不直接使用控制器 requesting/stopping 等阶段名。故障后保留这个进展位置，不能把阶段重置为初态。

| 进展 | physical.region / support | held_by | holder / 唯一局部账本 |
| --- | --- | --- | --- |
| reserved | source / source | 空 | source_owner / source |
| captured | source / source | actor | source_owner / source |
| cleared | tool / tool | actor | actor / tool |
| placed | target / target | actor | actor / tool |
| released | target / target | 空 | actor / tool |
| committed | target / target | 空 | target_owner / target |

stable 适用于受支承且无交接中间状态的物料；unspawned 单列，要求无局部占用、无 holder、无夹持。尚未建模的飞行/掉落/连续接触状态不适用这张表，不得强套。夹紧、加工等能力的额外不变量仍由契约模型负责。

V08 帧是一次失败处理微步前后受影响物料的快照，不是跨多个物理步骤的长区间。已确认停止但交接尚未一致时，能力的 `release_requires` 同样禁止错误释放；P2 必须落实这条转换约束，不能仅依靠当前 V08 的停止未知触发器来证明所有失败路径安全。

## 4. 必须保留的映射项

### P1-PILOT-TIMING-BRIDGE：阻塞 160 条旧试点查询

五个动态试点案例合计有 160 条查询。原计划描述反馈与实际观测同步，仅给出 accept/phase/stop 区间；通用语义则包含源采样、交付和一个 tick 的可见性。这些区间究竟约束设备动作还是接收观察，不能仅凭同名 nominal/delayed 就假定一致。

P1 将这批查询标为 BLOCKED_MAPPING。P2 要给出显式的试点时序适配：保留旧试点语义单独实现，或建立到通用语义的对应关系。若改成通用语义的扩展实验，创建新查询身份并重建证据；不能直接沿用旧计时答案。阻塞不影响其余已规范化的通用查询开始构模。

### P1-TAIL-EXTENSION：2,485 条候选扩展，不自动准入

原通用查询的 tail_policy 是“只检查完整响应窗口并报告未覆盖尾部”。库存保留该口径；新方案的“覆盖 K 内全部触发，并延长到其期限”是不同查询范围。

`proposed-query-extensions.json` 为每条 V10b 生成不同身份的扩展候选：触发窗口仍是 K，检查上界至 K+D。环境必须明确延续原规则和全局故障预算；不能认为 K 之后停止确认自动恢复或不再发生故障。P2 完成环境延续映射、P3 构造证据前，扩展候选不进入真值分母。

其中 1,065 条旧查询的 K=1000、D=1800。初态没有已接受请求且首次进展在 tick 1，因此该边界无法覆盖任何新接受请求的完整期限。应报告未覆盖窗口/触发情况，不把“没有在 K 内观察到超时”算成有界响应已证明。

### P1-NO-SYNTACTIC-TRIGGER：217 条空真风险，不改适用性

31 个案例/性质组合、共 217 条查询在候选语法中已无相应调用。它们仍继承原任务的适用义务。P1 只登记 `syntactic_trigger_possible=false` 与 `vacuity_risk=true`，不把语法检查当作整线触发不可达证明；P2/P3 再确定触发可达性。

## 5. P2 的观察帧义务

`evaluate()` 输入一帧，`ResponseMonitor` 输入一条完整的事件轨迹。当前实现故意不读取被测执行器的内部状态，也不接受一个自报的 `property_ok` 字段。

- 所有帧包含 kind 与非负整数 tick；缺少关键字段为 UNKNOWN，非法类型为 INVALID_FRAME。
- request 含五个身份字段；grants 的 owner 是这五个字段组成的数组。expected 必须来自当时的注册/绑定上下文，不能从收到的报文反向填充。
- evidence 包含 provider、subject、epoch、sample_tick、valid、value，以及适用的 activation/request。expected 指定 bool/real/dint/reference 类型和当前身份。
- V06 的 effective_commits 记录真正改变账本的提交，而非收到 done 的次数。P2 应独立维护历史计数及冻结的事务参数。
- V09/V10a 的 task 参数从冻结的 TaskSpec 文件读取，world 的 active_requests/grants 不得使用默认空列表掩盖缺失数据。
- V10a 必须另传查询的 bound_ticks；完成时刻等于 K 可计入，大于 K 返回 OUTSIDE_QUERY_BOUND，不能充当该查询的可达见证。
- ResponseMonitor 要求 tick 严格递增，同 tick 的全部事件一次提交；P2/P3 必须证明未漏掉相关接受、响应和失败事件。
- 知道停止结果不等于知道交接一致。构造确认失败、取消或 attention 帧前，P2 必须应用对应契约的终态/隔离条件。

这些输入义务和模型到观察帧的对应关系属于 P2/P3 验收。P1 的边界测试通过，不代表这个对应关系已经证明。
