# 九类统一实验资产契约

本契约以行为为中心，明确动作参数、逻辑命令端口、前置条件、持续条件、完成证据与停止规则。不同外观的同类资产使用同一个版本化定义，由实例适配器连接具体信号和几何。

## 资产目录

| 资产 | 定义 | 主要能力与职责 |
| --- | --- | --- |
| 机械臂 | [robot_arm.json](assets/robot_arm.json) | 空载定位、取料、放料、完整搬运 |
| 传送带 | [conveyor.json](assets/conveyor.json) | 指定物料输送到出口并停稳、持续运行 |
| 托盘 | [pallet.json](assets/pallet.json) | 被动装卸交接和槽位占用观测 |
| 物料 | [material.json](assets/material.json) | 被抓取、被放置、被输送和携带状态观测 |
| 出料口／供料台 | [material_source.json](assets/material_source.json) | 有限库存供料，或被动台座的物料就绪观测 |
| 仓储柜 | [storage_rack.json](assets/storage_rack.json) | 被动库位、存取交接和库存观测 |
| 升降台／运输机 | [lift_transport.json](assets/lift_transport.json) | 按启用能力进行垂直定位或水平运输 |
| 加工设备 | [processing_station.json](assets/processing_station.json) | 装夹、按配方加工、松夹 |
| 旋转台 | [rotary_table.json](assets/rotary_table.json) | 定角转位、台面槽位观测 |

完整行为、条件和证据列表见 [资产行为目录](docs/资产行为目录.md)。`assets/*.json` 是权威定义；修改行为时应同步更新该目录。

## 建模信息如何组织

| 信息 | 字段 | 作用 |
| --- | --- | --- |
| 工艺语义 | id、label、description、category | 说明资产角色与适用范围 |
| 运动与物理参数 | parameters | 速度、行程、载荷、容量和容差，含类型与单位 |
| 信号 | signal_ports、protocol_imports | 逻辑命令和反馈，方向以设备为参照 |
| 物理接口 | spatial_interfaces | 安装、工具、支承、交接区域的逻辑角色 |
| 执行条件 | behaviors.preconditions / sustaining_conditions | 当前行为启动与持续运行的条件 |
| 完成证据 | behaviors.completion | 当前请求结束所需的实际观测 |
| 行为能力 | behaviors | 参数、命令绑定、能力开关、执行器引用与预期效果 |

这里统一字段结构和解释规则，不把被动物体变成主动设备。托盘、物料、仓储柜没有自主 execute/busy/done；它们的 passive 行为描述外部执行器造成的状态变化，observer 行为提供事实，均不可作为 DSL 的生产调用。

## 条件到信号的明确绑定

每项检查含 `left`、`operator` 和 `right`。引用来源限定为：

- `signal`：本资产的显式反馈，或导入的公共协议端口。
- `parameter`：本实例的固定参数。
- `argument`：当前行为的调用参数。
- `observation`：具名派生事实，由明确的提供者计算。
- `authorization`：明确的资源或事务授权。
- `context`：当前运行、实例和请求身份，用于比较值或命令映射。

例如机械臂的载荷检查比较 `material_mass(material)` 与 `max_payload_kg`；搬运完成检查目标支承、夹具释放和本次交接提交。它们都具有确定来源，不把复杂事实压成没有含义说明的 ready 位。

具名事实的 `arguments` 与 `argument_types` 给出完整签名，条件中的 `bindings` 将该签名映射到当前行为参数。物料、位置、槽位和配方都是不同名义类型。`provider` 的职责见 [runtime-semantics.json](shared/runtime-semantics.json)。派生事实的中文描述是执行器实现义务，校验器不会执行描述文本或替代其实现。

同一阶段的条件为 AND。仅支持 eq/ne/lt/le/gt/ge 比较；本版不引入完整谓词语言。缺失、过期、无效、错物料或错代次的观测为 unknown。前置 unknown 阻止启动；持续条件失效按公共停止协议处理。

前置条件在该行为准备执行时检查。后续动作可以依靠前面动作建立条件，不要求整条工艺的所有条件在初态同时为真。资源许可在检查与提交间复核，防止把过期检查结果当作当前许可。

## 请求、连续行为与停止

[protocols.json](shared/protocols.json) 集中定义主动请求协议及被动观测规则。主动实例一次只处理一个顶层请求；请求含运行、实例和请求身份，行为命令码在单类资产内唯一。

控制器写入参数与 command_code，保持 execute 直到匹配的 accepted_id；接受后冻结参数。离散成功需要已保存的接受回执、当前请求 result_id、有效 done 以及全部业务完成证据。`busy=false`、旧 done 或写入了目标参数均不足以成功。

重复的同身份同载荷请求不重复执行。共享协议只描述一次顶层动作，机械臂完整搬运中的内部抓取和放置不再申请顶层请求。

传送带 run 是 continuous 作用域，没有自然完成点。作用域退出通过 cancel 取消原请求，必须等待匹配 stop_ack_id、实际 stopped 和 scope checks。`transport_to_exit` 是独立的离散任务，自行控制输送并以目标物料出口到位及停稳结束；两者不并发控制同一电机。

取消是优先控制通道，不是必须等待 idle 才能开始的另一条生产任务。停止未知时保留实际物料状态和必要隔离。运动停止不意味着可以清空夹持、占用或全部资源；操作许可和物理占用分别由相应服务处理。

被动交接证据关联外部 transaction_id 与当前主体，避免把上一次交接当作本次成功。纯 observer 返回快照，不产生设备任务结果。

## 固定契约与实例差异

同一类资产的行为 ID、逻辑端口和证据含义在十二个场景中保持一致。实验需要登记契约版本与统一参数配置，实例通过以下映射接入：

1. 稳定 instance_id 与 contract_id/version。
2. 启用的 features 与明确参数；缺少能力的实例不能启用对应行为。
3. 逻辑信号到具体驱动、仿真字段或 PLC 变量的适配。
4. 逻辑接口到实例坐标系、区域、支承面和 TCP 的几何映射。
5. 事实和授权提供者，以及本次运行的物料、位置、槽位登记。

设备定义不写死另一个场景的设备名称或 PLC 地址。例如 source、target 是行为参数，场景才能把它们绑定为具体输送机入口或托盘位。信号方向以资产为参照：input 是控制器写、资产读；output 是适配器写、控制器读。

出料口 `controlled_feeding=false` 时，屏蔽 request_v1 与 material_id 输入，仅保留被动台座观测。升降／运输资产至少启用垂直或水平能力之一；未启用轴的行为不可调用。旋转台本版采用有限展开角区间，不默认无限旋转。

所有默认速度、载荷、容量和时间配置都是实验参数，不能当成 GLB 对应真实设备的额定值。所有角度使用 rad、长度 m、质量 kg、时间 s。物料标识保持名义类型；后续 PLC 映射如使用整数，应有独立的稳定编号表。

## 当前交付与后续接入

所有资产的 `implementation_status` 为 `contract_only`。本包包含机器可读契约、Schema、跨引用检查与负例测试。`executor_ref` 是接入要求，未因存在该字段而声明已注册对应执行器。机械臂几何可达、碰撞和加工质量仍由明确外部模型/假设负责。

`expected_effects` 是描述性后态义务，不是直接修改物料位置或账本的代码。独立任务验收仍需读取实际观测；不能由程序自行写一个成功标志替代。

后续按“实例绑定 → 单行为驱动与反馈验收 → 多设备场景 DSL”接入。九类资产合同结构已固定，场景工艺不再复制另一份行为定义。

## 校验

在本目录运行：

```powershell
python -B tools/validate_contracts.py
python -B -m unittest discover -s tests -p "test_*.py"
```

依赖 Python 3.10+ 与 jsonschema 4.x。Schema 检查字段和类型，跨引用检查器检查端口方向、条件来源、命令参数、事实签名、协议与能力开关。检查结果不替代事实提供者实现、参数标定或实际闭环测试。

## 输送托盘的扩展

conveyor 0.2.0新增受carrier_indexing开关控制的index_carriers(plan: transport_plan_ref)，支持对整线托盘及装载物的显式运动计划。计划必须覆盖全部在线载具、原位、目标、顺序、间距和载荷，并可由共同驱动实现；未知或不兼容计划拒绝。默认开关关闭，S02显式开启。完成需全部目标位置证据、支承保持和实际停稳。该扩展不提供独立分区能力，计划注册和运动适配器仍待实现。

## 单托盘工位定位接口

conveyor 0.3.0新增transport_carrier_to(carrier: pallet_ref, target: location_ref)，由DSL传入本次目标。行为绑定carrier_id、target_position及统一carrier_speed_mps，检查当前载具、可达目标、运动区清空和实际载荷，以本次托盘到位、实际停稳、支承保持作为完成证据。底层计划是执行层根据现场状态派生的结果，不是生产批次中的工序定义。原index_carriers保留用于S02的整线多载具协调。两个接口均需实际执行器接入。
