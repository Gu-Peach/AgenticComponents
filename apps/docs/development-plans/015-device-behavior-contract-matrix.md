# 015 附表　设备行为、判定条件与信号接口

本表是十类设备初始模板的逐行为迁移依据。一个型号只启用选定行在该模式下已有的能力。同一行为 ID 出现多行时，按来源选择整行的条件和端口。托盘使用物料的可选承载属性，旧托盘协议列在兼容节。本文只确定契约与验收口径，执行器的现有可用范围单独标明。[回到开发计划](015-2026-11-24-device-contract-library.md)

## 怎么读这张表

- **输入与输出方向以设备为准。** 两列直接列出行为声明的逻辑端口 ID。各节先列端口的 PLC 类型。参数、命令载荷、空间端点、物理观测和资源授权各有独立来源。破折号表示该列无声明。具体 PLC 地址由设备实例映射。
- **前置、持续与完成分开判定。** 表内各登记条件默认要求为真，多项均须满足。表达式中的 ∧、∨、¬ 分别表示与、或、非，叶子 ID 对应来源契约的类型化绑定。缺失、过期或身份不匹配的证据不能放行。有限动作以与本次请求匹配的回执和已满足的完成条件结束。持续动作没有一次性终点，完成列列出的证据用来观测当前状态。
- **来源和实现范围。** “表达式”表示契约提供机器可读表达式，“原生”表示该条件需要由原生提供者判断，是否接入须核对对应场景，“登记”表示基础契约只登记条件键。观测定义中的 signal_refs 是依赖提示，具体求值以表达式或原生实现为准。每节标明已有候选场景真正调用的动作。单设备实验、工作台示意观测、被动服务以及待接入项按各自入口保留。
- **查找方式。** 来源栏与每节末尾的原始契约链接对应。多份声明在本表所列条件、直接 I/O、模式和配置门槛相同时合并列示。版本、执行器引用、参数和外部载荷定义以所选来源为准。[通用设备契约](../../../test1/docs/设备契约.md) · [条件表达式及绑定](../../../test1/docs/统一条件表达式.md)

## 各类型初始模板采用的口径

每种设备类型有一份 `contract.json`，`behavior.ts` 按行为 ID 与模式选择下列签名。现有可执行场景沿用对应行的全部门槛。声明型能力保留条件与端口，提供者和执行器接入后再允许调度。解析出现多个适用签名时报告型号修订和冲突行。

| 设备 | 初始模板的取值依据及适用模式 |
| --- | --- |
| [机械臂](#type-robot-arm) | 普通抓放和移动沿用 S01/02/06。双臂协作选 S04，焊枪加工选 S11，独立命令选 UR10。 |
| [传送带](#type-conveyor) | 整场景定位、受控停带及交付选实际场景配置，独立接触输送实验选 Conveyor_aankws。 |
| [旋转台](#type-rotary-table) | 已运行的带载分度选 S11。其他台面与暂停恢复能力按 S12／参考模板保留。 |
| [加工机床](#type-machine-tool) | 选 S06 定时加工，对同一受支承工件提交成品结果。 |
| [出料口](#type-material-source-station) | 保留标准六项供料声明。现有批次供应方式继续消费环境准入事件。 |
| [物料](#type-workpiece) | 被动工件按型号启用抓取、支承、加工观测与可选承载属性。普通刚体允许无行为与 I/O。 |
| [滑轨](#type-linear-rail) | 选 S07 轴运动和对位协议。 |
| [升降台](#type-lift-table) | S07 路线使用虚拟接放料与升降轴控制。横移链及恢复等选装能力使用参考升降模板的信号。 |
| [仓储柜](#type-storage-rack) | 选 S07 格位语义，保留六项声明及现有的请求级库存服务。 |
| [搬运人员](#type-human-operator) | 选 S11 手部吸附搬运，输入输出按人物契约。 |

兼容查阅　[旧托盘](#type-workpiece-carrier) · [实验工站](#experimental-station) · [旧公开示例](#legacy-examples)

<a id="type-robot-arm"></a>

## 机械臂　`robot_arm`

整场景抓放核对来源可取、目标可接、夹具为空和资源授权，放置回执须与同一工件的实际支承相符。S04 双臂交接要求工件正置在取件位、输送线停稳、两臂就绪。移交完成时接方持有同一件、供方已释放。接方倒置放置后须空手并得到出带支承。S04 的位姿请求绑定各臂 home。S11 的加工要求工件固定在加工侧、人员撤离、转台停稳、工具接口匹配。在枪尖与工件接口的距离和轴向误差满足容差期间累计工艺时间，退位并关联本次加工记录后完成。

**已接入候选场景的直接调用**　`move_to_pose`（S01、S02、S04、S06），`pick_and_handoff`（S04），`pick_and_place`（S01、S02、S06），`place_held_material`（S04），`process_material`（S11）。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `enableTag`、`gripperTag`、`in1Tag`、`in2Tag`、`in3Tag`、`in4Tag`、`pause_pick`、`reset`、`resume_pick`、`start_pick`、`start_process`<br>`DINT` `request_id`<br>`INT` `commandTag` |
| 输出 | `BOOL` `accepted`、`busy`、`done`、`error`、`holding_material`、`out1Tag`、`out2Tag`、`out3Tag`、`out4Tag`<br>`DINT` `result_id`<br>`INT` `error_code` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `move_to_pose` 移动<br>动作／可调度声明<br>S01、S02、S06（表达式） | 观测 `move_to_pose.pre_1` → `(¬move_to_pose.busy_run ∧ ¬move_to_pose.error_run ∧ move_to_pose.pose_plan_valid)` | 观测 `move_to_pose.sustaining` → `(move_to_pose.matching_accepted ∧ ¬move_to_pose.error_run ∧ move_to_pose.motion_integrity)` | 有限完成。实际 TCP 位置、所需姿态和速度满足阈值；IK 未收敛不算完成<br>观测 `move_to_pose.completion` → `(move_to_pose.matching_success ∧ (move_to_pose.tcp_position_error_m ≤ move_to_pose.ik_position_tolerance_m) ∧ (move_to_pose.max_joint_speed_rad_s ≤ move_to_pose.settle_speed_rad_s) ∧ move_to_pose.requested_orientation_satisfied)` | `commandTag`、`enableTag`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `move_to_pose` 移动<br>动作／可调度声明<br>S03、S05、S08、S09、S10、S12、参考模板（登记）<br>S04、S11（原生） | 观测 `move_to_pose.pre_1`。目标位置／姿态及关节限制合法、有可执行路径、使能有效 | 观测 `move_to_pose.sustaining`。持续条件与阶段身份 | 有限完成。实际 TCP 位置、所需姿态和速度满足阈值；IK 未收敛不算完成<br>观测 `move_to_pose.completion` | `commandTag`、`enableTag`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `move_to_pose` TCP位置移动<br>动作／可调度声明<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证<br>观测 `target_valid`。命令已通过帧、限位与IK预检查 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `move_to_pose.succeeded`。执行器实际完成观测 | `enableTag` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `pick_and_handoff` 抓取并双臂交接<br>复合／可调度声明<br>S04、S11（原生） | 观测 `pick_and_handoff.ready`。第一带停稳，瓶底有支承，供料位置、双臂可达性和两个夹持点兼容<br>授权 `pick_and_handoff.authorized`。原子预留同一物料、源和目标，双臂交接同时取得两台臂的控制权 | 观测 `pick_and_handoff.integrity`。交接前供方持续持有，接方在尾部对齐且相对速度满足阈值，交接失败时保留现有持有者 | 有限完成。同一物料在交接位由接方指定夹持点持有，供方释放并退出交接区域<br>观测 `pick_and_handoff.complete` | `commandTag`、`enableTag`、`pause_pick`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`holding_material`、`result_id` |
| `pick_and_place` 抓放<br>复合／可调度声明<br>S01、S02、S04、S06、S11（表达式） | 观测 `pick_and_place.pre_1` → `(¬pick_and_place.busy_run ∧ ¬pick_and_place.error_run ∧ ¬pick_and_place.holding_material_run ∧ pick_and_place.source_pickable ∧ pick_and_place.target_admissible)` | 观测 `pick_and_place.sustaining` → `(pick_and_place.matching_accepted ∧ ¬pick_and_place.error_run ∧ pick_and_place.phase_integrity)` | 有限完成。取料、移动、放置等子行为完成；实际物料交接成立<br>观测 `pick_and_place.completion` → `(pick_and_place.matching_success ∧ ¬pick_and_place.holding_material_request_subject ∧ pick_and_place.placement_confirmed)` | `commandTag`、`enableTag`、`pause_pick`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`holding_material`、`result_id` |
| `pick_and_place` 抓放<br>复合／可调度声明<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `pick_and_place.pre_1`。设备空闲、取料点有指定工件、夹具为空、未暂停接单、目标及资源合法 | 观测 `pick_and_place.sustaining`。持续条件与阶段身份 | 有限完成。取料、移动、放置等子行为完成；实际物料交接成立<br>观测 `pick_and_place.completion` | `commandTag`、`enableTag`、`pause_pick`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`holding_material`、`result_id` |
| `pick_and_place` 抓取放置<br>复合／可调度声明<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证<br>观测 `device_idle`。没有在途任务<br>观测 `tool_empty`。没有实际持有关系<br>授权 `source_authorized`。显式准备的单物料会话拥有源/目标操作权；不是自动调度器授权<br>授权 `target_reserved`。显式准备的单物料会话拥有源/目标操作权；不是自动调度器授权 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `pick_and_place.succeeded`。执行器实际完成观测 | `commandTag`、`enableTag`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `place_held_material` 放置已持有物料<br>复合／可调度声明<br>S04、S11（原生） | 观测 `place_held_material.ready`。本臂正从指定夹持点持有同一物料，目标带已停稳且接料空间空闲<br>授权 `place_held_material.authorized`。原子预留同一物料、源和目标，双臂交接同时取得两台臂的控制权 | 观测 `place_held_material.integrity`。翻转和下降时保持夹持，倒置到位后释放并核对实际支承 | 有限完成。按目标姿态释放后，实际检测到持续支承及到位姿态，夹具退出放置区<br>观测 `place_held_material.complete` | `commandTag`、`enableTag`、`pause_pick`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`holding_material`、`result_id` |
| `process_material` 焊枪对接加工<br>动作／可调度声明<br>S11（原生） | 观测 `process_material.ready`。工件处于加工侧且已固定，转台静止，人员撤离，工具与目标接口的工艺匹配。<br>授权 `process_material.authorized`。加工请求获准独占机器人、物料和转台工装。 | 观测 `process_material.sustaining`。工件保持约束，接触阶段焊枪尖与加工口的距离和轴向误差持续满足容差。 | 有限完成。同一工件在接口对准时完成加工周期并提交 finished，机械臂退位。<br>观测 `process_material.completion` | `request_id`、`start_process` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `execute_job` 执行预定义任务<br>复合／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 授权 `execute_job.pre_1`。设备可接受、未暂停接单、任务编号及参数有效、资源获准 | 观测 `execute_job.sustaining`。持续条件与阶段身份 | 有限完成。选定任务的必需子行为均成功，终态满足契约后报告本次 done<br>观测 `execute_job.completion` | `commandTag`、`enableTag`、`pause_pick`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`holding_material`、`result_id` |
| `execute_job` 执行任务<br>复合／可调度声明<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证<br>观测 `device_idle`。没有在途任务<br>观测 `target_valid`。命令已通过帧、限位与IK预检查 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `execute_job.succeeded`。执行器实际完成观测 | `commandTag`、`enableTag`、`request_id`、`start_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `grip` 抓取<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `grip.pre_1`。指定工件存在且归属本任务、夹具为空、物料和载荷兼容、接近／接触条件满足 | 观测 `grip.sustaining`。持续条件与阶段身份 | 有限完成。实际持有关系建立，holding_material 为真<br>观测 `grip.completion` | `gripperTag` | `accepted`、`busy`、`done`、`error`、`error_code`、`holding_material`、`result_id` |
| `grip` 建立物理抓取<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证<br>观测 `tool_empty`。没有实际持有关系<br>观测 `material_in_capture`。工具和物料捕获参考距离满足标定<br>观测 `payload_compatible`。指定物料类型和质量满足允许载荷<br>授权 `source_authorized`。显式准备的单物料会话拥有源/目标操作权；不是自动调度器授权 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `grip.succeeded`。执行器实际完成观测 | `enableTag` | `holding_material` |
| `hold_motion` 暂停在途运动<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `hold_motion.pre_1`。设备具有减速保持实现<br>观测 `hold_motion.pre_2`。当前任务、工件和资源继续保留 | 观测 `hold_motion.sustaining`。持续条件与阶段身份 | 有限完成。运动减速至保持状态，任务仍未终止<br>观测 `hold_motion.completion` | `enableTag` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `hold_motion` 减速保持<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `hold_motion.succeeded`。执行器实际完成观测 | — | — |
| `pause_pick_intake` 暂停接收抓取<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `pause_pick_intake.pre_1`。适用于当前接单模式<br>观测 `pause_pick_intake.pre_2`。不改变在途动作阶段 | 观测 `pause_pick_intake.sustaining`。持续条件与阶段身份 | 有限完成。阻止新抓取被接受；不宣称机械臂已经停稳<br>观测 `pause_pick_intake.completion` | `pause_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `pause_pick_intake` 暂停接单<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `pause_pick_intake.succeeded`。执行器实际完成观测 | — | — |
| `publish_robot_state` 发布动作与夹持状态<br>观测／非调度入口<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `publish_robot_state.pre_1`。状态来源与接口绑定有效 | 无附加检查 | 持续观测。更新 accepted/busy/done/error、holding_material 与阶段输出<br>观测 `publish_robot_state.completion` | — | `accepted`、`busy`、`done`、`error`、`error_code`、`holding_material`、`out1Tag`、`out2Tag`、`out3Tag`、`out4Tag`、`result_id` |
| `publish_robot_state` 发布机器人状态<br>观测／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证 | 无附加检查 | 持续观测。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表（checks 为空） | — | — |
| `release` 放置释放<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `release.pre_1`。当前持有指定物料、目标容量已预留、姿态及释放条件满足 | 观测 `release.sustaining`。持续条件与阶段身份 | 有限完成。工件与目标完成有效交接；夹具命令置零本身不足以证明成功<br>观测 `release.completion` | `gripperTag` | `accepted`、`busy`、`done`、`error`、`error_code`、`holding_material`、`result_id` |
| `release` 解除抓取并确认支承<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证<br>观测 `holding_material`。实际固定约束存在<br>观测 `release_pose_valid`。物料位于指定释放区域<br>授权 `target_reserved`。显式准备的单物料会话拥有源/目标操作权；不是自动调度器授权 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `release.succeeded`。执行器实际完成观测 | `enableTag` | `holding_material` |
| `resume_motion` 恢复在途运动<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 授权 `resume_motion.pre_1`。原任务有效、资源仍获准、故障条件已解除 | 观测 `resume_motion.sustaining`。持续条件与阶段身份 | 有限完成。继续原阶段，不重复已经完成的 grip/release<br>观测 `resume_motion.completion` | `enableTag` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `resume_motion` 恢复原运动<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `resume_motion.succeeded`。执行器实际完成观测 | — | — |
| `resume_pick_intake` 恢复接收抓取<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `resume_pick_intake.pre_1`。暂停锁存允许解除、没有冲突暂停输入 | 观测 `resume_pick_intake.sustaining`。持续条件与阶段身份 | 有限完成。允许新的抓取请求，原任务不重复执行<br>观测 `resume_pick_intake.completion` | `pause_pick`、`resume_pick` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `resume_pick_intake` 恢复接单<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `resume_pick_intake.succeeded`。执行器实际完成观测 | — | — |
| `set_output` 设置任务输出<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `set_output.pre_1`。输出已绑定、取值合法且由本任务拥有写入权 | 观测 `set_output.sustaining`。持续条件与阶段身份 | 有限完成。输出提交成功，状态按声明规则保持或清除<br>观测 `set_output.completion` | — | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `set_output` 设置输出<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `set_output.succeeded`。执行器实际完成观测 | — | — |
| `wait_signal` 等待外部信号<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `wait_signal.pre_1`。信号已绑定且类型正确、期望值和超时策略明确 | 观测 `wait_signal.sustaining`。持续条件与阶段身份 | 有限完成。实际信号满足期望；超时走失败分支<br>观测 `wait_signal.completion` | `in1Tag`、`in2Tag`、`in3Tag`、`in4Tag` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `wait_signal` 等待有效信号<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `wait_signal.succeeded`。执行器实际完成观测 | — | — |
| `wait_time` 定时等待<br>动作／可调度声明<br>S01、S02、S04、S06、S11（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `wait_time.pre_1`。时长合法且等待策略已配置 | 观测 `wait_time.sustaining`。持续条件与阶段身份 | 有限完成。按仿真时间达到有效等待时长；失能保持时按约定冻结计时<br>观测 `wait_time.completion` | — | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `wait_time` 仿真时间等待<br>动作／非调度入口<br>robot_UR10（登记） | 观测 `kinematics_ready`。运动学与参数已验证 | 无附加检查 | 有限完成。执行器按实际FK/约束/支承观测确认；请求参数及授权有效，详见005方案逐行为表<br>观测 `wait_time.succeeded`。执行器实际完成观测 | — | — |

**结构化条件中直接读取的信号。** 下列为表中表达式叶子到设备端口的实际绑定。run 表示当前运行，request_subject 同时核对请求与物料。数据应为有效且新鲜的采样。

| 条件表达式叶子 | 实际信号 | 采样范围 | 来源 |
| --- | --- | --- | --- |
| `move_to_pose.busy_run` | `busy` | `run` | S01、S02、S06 |
| `move_to_pose.error_run` | `error` | `run` | S01、S02、S06 |
| `pick_and_place.busy_run` | `busy` | `run` | S01、S02、S04、S06、S11 |
| `pick_and_place.error_run` | `error` | `run` | S01、S02、S04、S06、S11 |
| `pick_and_place.holding_material_request_subject` | `holding_material` | `request_subject` | S01、S02、S04、S06、S11 |
| `pick_and_place.holding_material_run` | `holding_material` | `run` | S01、S02、S04、S06、S11 |

**UR10 独立命令及步骤。** 顶层允许 move_joints、move_to_pose、execute_job、pick_and_place、grip、release。步骤允许 move_joints、move_to_pose、grip、release、wait_time、wait_signal、set_output。wait_signal 等待指定 in1Tag–in4Tag，set_output 选择 out1Tag–out4Tag。表内型号 I/O 是行为声明集合，运行时按命令载荷选择端口。S04 的交接以 start_pick 和 request_id 提交，协议中其他输入继续按对应信号所有者提供。

| 额外行为 | 前置／持续条件 | 完成证据 | 输入与载荷 | 输出 |
| --- | --- | --- | --- | --- |
| `move_joints`（单设备 API 或任务步骤） | 会话与机械臂匹配、请求号有效、已使能、无在途任务及故障，六个目标关节角均有限且在模型限位内。运行中未使能时执行减速保持 | 轨迹结束、各关节速度进入停稳阈值、最大关节角误差进入执行器容差。顶层任务通过账本按请求号完成 | `enableTag`。网关写 `start_pick`、`request_id` 握手，六个目标角由 API 载荷 `steps[].q` 传入 | `accepted`、`busy`、`done`、`result_id`、`error`、`error_code`。`holding_material` 为设备状态 |

[独立命令与步骤](../../src/contracts/robot-command.ts) · [任务网关和信号](../../src/runtime/programs/RobotProgram.ts) · [逐步到位判定](../../src/runtime/templates/robot/RobotJobRunner.ts)

原始契约　[S01](../../public/scene/S01/contracts/robot_arm.json) · [S02](../../public/scene/S02/contracts/robot_arm.json) · [S03](../../public/scene/S03/contracts/robot_arm.json) · [S04](../../public/scene/S04/contracts/robot_arm.json) · [S05](../../public/scene/S05/contracts/robot_arm.json) · [S06](../../public/scene/S06/contracts/robot_arm.json) · [S08](../../public/scene/S08/contracts/robot_arm.json) · [S09](../../public/scene/S09/contracts/robot_arm.json) · [S10](../../public/scene/S10/contracts/robot_arm.json) · [S11](../../public/scene/S11/contracts/robot_arm.json) · [S12](../../public/scene/S12/contracts/robot_arm.json) · [robot_UR10](../../public/modles/robot_UR10/schema.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/robot_arm.json)

<a id="type-conveyor"></a>

## 传送带　`conveyor`

定位输送要求指定主体、目标与输送路径有效，并满足本次配置的驱动组互锁。到位证据包括同一主体实际到达目标容差、目标支承、物料及输送设备停稳。出口交付还需接收方及对应收件回执。公共单带可按 runTag 与 speedTag 做接触输送。型号文件中声明的其他请求能力分别保留其既有接入状态。

**已接入候选场景的直接调用**　`release_material`（S01、S02、S04、S06、S07），`stop_conveying`（S01、S02、S04、S06、S07），`transport_to_exit`（S01、S07），`transport_to_position`（S01、S02、S04、S06）。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `execute`、`release_waiting_material`、`reset`、`runTag`<br>`DINT` `request_id`、`subject_id`<br>`INT` `behavior_code`、`target_location`<br>`REAL` `speedFpmTag`、`speedTag`、`target_distance` |
| 输出 | `BOOL` `accepted`、`blocked`、`busy`、`capacity_available`、`done`、`error`、`part_ready`、`pulseTag`、`runningTag`<br>`DINT` `result_id`<br>`INT` `error_code`<br>`REAL` `actual_speed`、`encoderTag`、`velocityTag` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `release_material` 出口交接<br>动作／可调度声明<br>S01、S02、S06（表达式） | 观测 `release_material.pre_1` → `(release_material.subject_at_exit ∧ release_material.receiver_admissible ∧ (¬release_material.release_history_exists ∨ (release_material.elapsed_since_release_s ≥ release_material.release_gap_s)))` | 观测 `release_material.sustaining` → `(release_material.matching_accepted ∧ release_material.release_waiting_material_run ∧ release_material.handoff_ownership_valid)` | 有限完成。物料离开本设备且下游确认接收，释放本设备占用<br>观测 `release_material.completion` → `(release_material.matching_success ∧ release_material.receiver_receipt ∧ ¬release_material.subject_on_device)` | `execute`、`release_waiting_material`、`request_id` | `accepted`、`busy`、`capacity_available`、`done`、`error`、`error_code`、`part_ready`、`result_id` |
| `release_material` 出口交接<br>动作／可调度声明<br>S03、S05、S08、S09、S10、S12、参考模板（登记）<br>S04、S07（原生） | 观测 `release_material.pre_1`。出口有指定物料、许可有效、下游容量已预留、放行间隔满足 | 观测 `release_material.sustaining`。持续条件与阶段身份 | 有限完成。物料离开本设备且下游确认接收，释放本设备占用<br>观测 `release_material.completion` | `execute`、`release_waiting_material`、`request_id` | `accepted`、`busy`、`capacity_available`、`done`、`error`、`error_code`、`part_ready`、`result_id` |
| `release_material` 出口交接<br>服务／可调度声明<br>Conveyor_aankws（登记） | 观测 `device_ready`。设备配置已解析、执行器已接入且无阻止动作的故障<br>观测 `subject_at_exit`。指定物料到达出口交接区<br>观测 `release_permission`。出口持续放行许可有效<br>授权 `downstream_reserved`。下游容量已为本任务有效预留<br>授权 `release_authorized`。本任务获得有效出口交接授权 | 观测 `release_permission`。出口持续放行许可有效<br>授权 `downstream_reserved`。下游容量已为本任务有效预留<br>授权 `release_authorized`。本任务获得有效出口交接授权 | 有限完成。指定物料离开本设备并由下游确认接收，之后释放本设备占用；仅离开画面或计时结束不算成功。<br>观测 `exit_handoff_confirmed`。物料离开且下游确认接收 | `behavior_code`、`execute`、`release_waiting_material`、`request_id`、`subject_id` | `accepted`、`busy`、`capacity_available`、`done`、`error`、`error_code`、`part_ready`、`result_id` |
| `stop_conveying` 受控停止<br>动作／可调度声明<br>S01、S02、S06（表达式） | 观测 `stop_conveying.pre_1` → `(stop_conveying.already_stationary ∨ stop_conveying.controlled_stop_supported)`<br>观测 `stop_conveying.pre_2` → `(stop_conveying.decel_time_s ≥ 0 s)`<br>观测 `stop_conveying.pre_3` → `stop_conveying.load_tracking_available` | 观测 `stop_conveying.sustaining` → `(stop_conveying.matching_accepted ∧ stop_conveying.stop_retains_loads)` | 有限完成。实际表面速度低于静止容差；已静止可幂等完成<br>观测 `stop_conveying.completion` → `(stop_conveying.matching_success ∧ (stop_conveying.max_drive_speed_mps ≤ stop_conveying.speed_tolerance_mps))` | `runTag`、`speedTag` | `accepted`、`actual_speed`、`busy`、`done`、`error`、`error_code`、`result_id`、`runningTag` |
| `stop_conveying` 受控停止<br>动作／可调度声明<br>S03、S05、S08、S09、S10、S12、参考模板（登记）<br>S04、S07（原生） | 观测 `stop_conveying.pre_1`。适用于运行中或已静止状态<br>观测 `stop_conveying.pre_2`。按配置执行减速<br>观测 `stop_conveying.pre_3`。保留仍在带上的物料 | 观测 `stop_conveying.sustaining`。持续条件与阶段身份 | 有限完成。实际表面速度低于静止容差；已静止可幂等完成<br>观测 `stop_conveying.completion` | `runTag`、`speedTag` | `accepted`、`actual_speed`、`busy`、`done`、`error`、`error_code`、`result_id`、`runningTag` |
| `stop_conveying` 受控停止<br>动作／非调度入口<br>Conveyor_aankws（登记） | 无附加检查 | 无附加检查 | 有限完成。实际速度低于静止容差，已静止时幂等完成；停止不释放在带物料和在途资源。<br>观测 `surface_stopped`。实际输送面速度已低于静止容差 | `runTag`、`speedTag` | `actual_speed`、`runningTag` |
| `transport_to_exit` 运输至出口<br>复合／可调度声明<br>S01、S02、S04、S06（表达式） | 观测 `transport_to_exit.pre_1` → `(transport_to_exit.subject_admitted ∧ transport_to_exit.exit_path_valid)`<br>观测 `transport_to_exit.pre_2` → `transport_to_exit.path_unblocked` | 观测 `transport_to_exit.sustaining` → `(transport_to_exit.matching_accepted ∧ ¬transport_to_exit.error_run ∧ transport_to_exit.transport_integrity)` | 有限完成。指定物料到达出口交接区并发布 part_ready；不等同于已交给下游<br>观测 `transport_to_exit.completion` → `(transport_to_exit.matching_success ∧ (transport_to_exit.target_error_m ≤ transport_to_exit.position_tolerance_m) ∧ transport_to_exit.target_supported ∧ transport_to_exit.subject_and_drives_stationary)` | `execute`、`request_id`、`runTag`、`speedTag` | `accepted`、`actual_speed`、`busy`、`done`、`error`、`error_code`、`part_ready`、`result_id`、`runningTag` |
| `transport_to_exit` 运输至出口<br>复合／可调度声明<br>S03、S05、S08、S09、S10、S12、参考模板（登记）<br>S07（原生） | 观测 `transport_to_exit.pre_1`。目标物料已被接收、方向及路径有效、所经分区允许推进<br>观测 `transport_to_exit.pre_2`。遇阻塞等待 | 观测 `transport_to_exit.sustaining`。持续条件与阶段身份 | 有限完成。指定物料到达出口交接区并发布 part_ready；不等同于已交给下游<br>观测 `transport_to_exit.completion` | `execute`、`request_id`、`runTag`、`speedTag` | `accepted`、`actual_speed`、`busy`、`done`、`error`、`error_code`、`part_ready`、`result_id`、`runningTag` |
| `transport_to_exit` 运输至出口<br>复合／可调度声明<br>Conveyor_aankws（登记） | 观测 `device_ready`。设备配置已解析、执行器已接入且无阻止动作的故障<br>观测 `subject_on_conveyor`。指定物料已经有效交接给本设备<br>观测 `transport_path_valid`。指定物料的整带运输路径有效<br>观测 `speed_setpoint_valid`。目标速度有限且符合单向与软件范围约束 | 观测 `run_permission`。持续运行许可有效 | 有限完成。指定物料到达出口交接区，发布本次到达结果和 part_ready；出口交接由 release_material 负责。<br>观测 `exit_arrival_confirmed`。本次运输的指定物料真实到达出口 | `behavior_code`、`execute`、`request_id`、`runTag`、`speedTag`、`subject_id` | `accepted`、`blocked`、`busy`、`done`、`error`、`error_code`、`part_ready`、`result_id` |
| `transport_to_position` 输送指定载荷至目标点并停稳<br>复合／可调度声明<br>S01、S02、S06（表达式） | 配置 `transport_mode = "continuous"`<br>观测 `transport_to_position.ready` → `((transport_to_position.transport_mode = "continuous") ∧ transport_to_position.target_and_subject_valid ∧ transport_to_position.environment_ready)`<br>授权 `transport_to_position.motion_authorized` → `(transport_to_position.resources_granted ∧ transport_to_position.motion_interlocks_clear)` | 观测 `transport_to_position.sustaining` → `(transport_to_position.matching_accepted ∧ transport_to_position.transport_integrity)` | 有限完成。指定主体参考点到达已解析的目标坐标，在有效支承上实际停稳；编码器行程和runTag不是位置完成证据<br>观测 `transport_to_position.completion` → `(transport_to_position.matching_success ∧ (transport_to_position.target_error_m ≤ transport_to_position.position_tolerance_m) ∧ transport_to_position.target_supported ∧ transport_to_position.subject_and_drives_stationary)` | `execute`、`request_id`、`runTag`、`speedTag`、`target_location` | `accepted`、`actual_speed`、`busy`、`done`、`encoderTag`、`error`、`error_code`、`result_id`、`runningTag` |
| `transport_to_position` 输送指定载荷至目标点并停稳<br>复合／可调度声明<br>S04（原生） | 配置 `transport_mode = "continuous"`<br>观测 `transport_to_position.ready`。指定主体的位置目标、支承、互锁及本次请求证据<br>授权 `transport_to_position.motion_authorized`。指定主体的位置目标、支承、互锁及本次请求证据 | 观测 `transport_to_position.sustaining`。指定主体的位置目标、支承、互锁及本次请求证据 | 有限完成。指定主体参考点到达已解析的目标坐标，在有效支承上实际停稳；编码器行程和runTag不是位置完成证据<br>观测 `transport_to_position.completion`。指定主体的位置目标、支承、互锁及本次请求证据 | `execute`、`request_id`、`runTag`、`speedTag`、`target_location` | `accepted`、`actual_speed`、`busy`、`done`、`encoderTag`、`error`、`error_code`、`result_id`、`runningTag` |
| `accept_material` 接收物料<br>动作／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 授权 `accept_material.pre_1`。入口可用、容量含预留仍有余量、物料类型和尺寸兼容、交接授权有效 | 观测 `accept_material.sustaining`。持续条件与阶段身份 | 有限完成。物料确实进入入口区，提交归属与占用<br>观测 `accept_material.completion` | `execute`、`request_id` | `accepted`、`busy`、`capacity_available`、`done`、`error`、`error_code`、`result_id` |
| `accept_material` 接收物料<br>服务／可调度声明<br>Conveyor_aankws（登记） | 观测 `device_ready`。设备配置已解析、执行器已接入且无阻止动作的故障<br>观测 `entry_capacity_available`。入口与含预留容量允许接收<br>观测 `subject_compatible`。指定物料类别、尺寸与支承条件兼容<br>授权 `handoff_authorized`。本任务获得有效入料交接授权 | 授权 `handoff_authorized`。本任务获得有效入料交接授权 | 有限完成。指定物料实际进入入口并完成交接，才更新归属和占用。<br>观测 `entry_handoff_confirmed`。指定物料真实进入入口且双方确认交接 | `behavior_code`、`execute`、`request_id`、`subject_id` | `accepted`、`busy`、`capacity_available`、`done`、`error`、`error_code`、`result_id` |
| `advance_to_next_stop_point` 区间推进<br>内部／非调度入口<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 配置 `transport_mode = "zoned"`<br>观测 `advance_to_next_stop_point.pre_1`。已启用分区模式<br>观测 `advance_to_next_stop_point.pre_2`。本区有料、下一区可接收、对应驱动许可有效 | 观测 `advance_to_next_stop_point.sustaining`。持续条件与阶段身份 | 持续观测。观测到物料进入下一检测区后更新两区占用；每次迁移可发事件<br>观测 `advance_to_next_stop_point.completion` | — | — |
| `meter_release` 出口间隔放行<br>内部／非调度入口<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 配置 `transport_mode = "zoned"`<br>观测 `meter_release.pre_1`。启用间隔放行<br>观测 `meter_release.pre_2`。有待放物料、放行许可有效、距上一件离开已达到间隔 | 观测 `meter_release.sustaining`。持续条件与阶段身份 | 持续观测。允许一件离开后更新放行计时；release_material 负责最终交接<br>观测 `meter_release.completion` | — | `blocked`、`part_ready` |
| `move_by_distance` 定距输送并停稳<br>复合／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 配置 `transport_mode = "continuous"`<br>观测 `move_by_distance.ready`。整带连续模式、定距与位置观测模块有效，距离速度合法，载荷快照及目标标定有效，设备实际停稳<br>授权 `move_by_distance.motion_authorized`。相关机械臂退位、夹具已空、入口供盘或排空状态成立、出口清空且参与载荷与目标空间获准 | 观测 `move_by_distance.sustaining`。本次请求及冻结载荷身份有效，运动区互锁、支承与允许载荷持续成立 | 有限完成。本次请求的表面行程达到目标距离且实际停稳，参与载荷的身份、实际目标位置与支承均确认；仅编码器到数不算完成<br>观测 `move_by_distance.completion` | `execute`、`request_id`、`runTag`、`speedTag`、`target_distance` | `accepted`、`actual_speed`、`busy`、`done`、`encoderTag`、`error`、`error_code`、`result_id`、`runningTag` |
| `publish_drive_feedback` 发布驱动反馈<br>观测／非调度入口<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `publish_drive_feedback.pre_1`。反馈字段已配置<br>观测 `publish_drive_feedback.pre_2`。由实际表面速度及仿真时间计算 | 无附加检查 | 持续观测。更新 runningTag、actual_speed 和启用的速度／编码反馈，无动作 done<br>观测 `publish_drive_feedback.completion` | — | `accepted`、`actual_speed`、`blocked`、`busy`、`capacity_available`、`done`、`encoderTag`、`error`、`error_code`、`part_ready`、`pulseTag`、`result_id`、`runningTag`、`velocityTag` |
| `publish_drive_feedback` 发布驱动反馈<br>观测／非调度入口<br>Conveyor_aankws（登记） | 观测 `device_ready`。设备配置已解析、执行器已接入且无阻止动作的故障 | 无附加检查 | 持续观测。由真实或明确声明的仿真观测更新驱动和占用反馈；无动作 done。（checks 为空） | — | `actual_speed`、`blocked`、`capacity_available`、`encoderTag`、`part_ready`、`pulseTag`、`runningTag` |
| `reverse_conveying` 反转<br>动作／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 配置 `allow_reverse = true`<br>观测 `reverse_conveying.pre_1`。设备和工艺允许反向<br>观测 `reverse_conveying.pre_2`。若为积放模式<br>观测 `reverse_conveying.pre_3`。其规则必须支持反向 | 观测 `reverse_conveying.sustaining`。持续条件与阶段身份 | 有限完成。先减速至零，再达到反向速度；第一版单向积放拒绝该请求<br>观测 `reverse_conveying.completion` | `runTag`、`speedTag` | `accepted`、`actual_speed`、`busy`、`done`、`error`、`error_code`、`result_id`、`runningTag` |
| `set_speed` 调整速度<br>动作／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `set_speed.pre_1`。只有一个速度来源、数值有限且在允许范围、运行模式有效 | 观测 `set_speed.sustaining`。持续条件与阶段身份 | 有限完成。实际速度在允许误差内达到新设定；受阻或禁用时不伪报到速<br>观测 `set_speed.completion` | `speedTag` | `accepted`、`actual_speed`、`busy`、`done`、`error`、`error_code`、`result_id`、`runningTag` |
| `set_speed` 调整速度<br>动作／非调度入口<br>Conveyor_aankws（登记） | 观测 `device_ready`。设备配置已解析、执行器已接入且无阻止动作的故障<br>观测 `run_permission`。持续运行许可有效<br>观测 `speed_setpoint_valid`。目标速度有限且符合单向与软件范围约束<br>授权 `drive_authorized`。本任务取得整条输送面驱动控制权 | 观测 `run_permission`。持续运行许可有效<br>授权 `drive_authorized`。本任务取得整条输送面驱动控制权 | 有限完成。实际表面速度在容差内达到已接受目标；状态反馈不占用离散任务 done。<br>观测 `target_speed_reached`。实际速度已在容差内达到当前冻结目标 | `runTag`、`speedTag` | `actual_speed` |
| `start_conveying` 连续运行<br>动作／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 观测 `start_conveying.pre_1`。运行许可和速度设定有效<br>观测 `start_conveying.pre_2`。允许空转<br>观测 `start_conveying.pre_3`。启用积放时服从各区门控 | 观测 `start_conveying.sustaining`。持续条件与阶段身份 | 持续观测。持续发布实际速度；无单次 done，停止由 stop_conveying 判断<br>观测 `start_conveying.completion` | `runTag`、`speedTag` | `actual_speed`、`done`、`runningTag` |
| `start_conveying` 连续运行<br>动作／非调度入口<br>Conveyor_aankws（登记） | 观测 `device_ready`。设备配置已解析、执行器已接入且无阻止动作的故障<br>观测 `run_permission`。持续运行许可有效<br>观测 `speed_setpoint_valid`。目标速度有限且符合单向与软件范围约束<br>授权 `drive_authorized`。本任务取得整条输送面驱动控制权 | 观测 `run_permission`。持续运行许可有效<br>授权 `drive_authorized`。本任务取得整条输送面驱动控制权 | 持续观测。持续发布实际速度；允许空转，无单次 done。停止由 stop_conveying 的速度观测确认。（checks 为空） | `runTag`、`speedTag` | `actual_speed`、`blocked`、`runningTag` |
| `zone_accumulation` 分区积放<br>内部／非调度入口<br>S01、S02、S04、S06、S07（原生）<br>S03、S05、S08、S09、S10、S12、参考模板（登记） | 配置 `transport_mode = "zoned"`<br>观测 `zone_accumulation.pre_1`。启用独立分区驱动及检测<br>观测 `zone_accumulation.pre_2`。产品尺寸与区间配置兼容 | 观测 `zone_accumulation.sustaining`。持续条件与阶段身份 | 持续观测。按占用与下区状态持续更新各区速度和 blocked，无全局 done<br>观测 `zone_accumulation.completion` | — | `blocked`、`capacity_available`、`done`、`runningTag` |

**结构化条件中直接读取的信号。** 下列为表中表达式叶子到设备端口的实际绑定。run 表示当前运行，request_subject 同时核对请求与物料。数据应为有效且新鲜的采样。

| 条件表达式叶子 | 实际信号 | 采样范围 | 来源 |
| --- | --- | --- | --- |
| `release_material.release_waiting_material_run` | `release_waiting_material` | `run` | S01、S02、S06 |
| `transport_to_exit.error_run` | `error` | `run` | S01、S02、S04、S06 |

原始契约　[S01](../../public/scene/S01/contracts/conveyor.json) · [S02](../../public/scene/S02/contracts/conveyor.json) · [S03](../../public/scene/S03/contracts/conveyor.json) · [S04](../../public/scene/S04/contracts/conveyor.json) · [S05](../../public/scene/S05/contracts/conveyor.json) · [S06](../../public/scene/S06/contracts/conveyor.json) · [S07](../../public/scene/S07/contracts/conveyor.json) · [S08](../../public/scene/S08/contracts/conveyor.json) · [S09](../../public/scene/S09/contracts/conveyor.json) · [S10](../../public/scene/S10/contracts/conveyor.json) · [S12](../../public/scene/S12/contracts/conveyor.json) · [Conveyor_aankws](../../public/modles/Conveyor_aankws/schema.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/conveyor.json)

<a id="type-rotary-table"></a>

## 旋转台　`rotary_table`

S11 在装卸侧和加工侧间正向分度。准入检查同一载荷已固定、转台停稳、人物和机械臂已退位。完成检查实测到角、停稳、保有工件及本请求的分度记录。S12 和参考模板中的台面输送、暂停、恢复另有声明。

**已接入候选场景的直接调用**　`rotate_to_station`（S11）。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `enableTag`、`reset`、`rotate_to_station`、`transfer_enable`<br>`DINT` `request_id`<br>`INT` `target_station`<br>`REAL` `angleTag`、`speedFpmTag`、`speedTag` |
| 输出 | `BOOL` `accepted`、`at_station`、`busy`、`done`、`error`、`occupied`、`rotating`<br>`DINT` `result_id`<br>`INT` `error_code`<br>`REAL` `actual_angle` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `rotate_to_station` 带载转位<br>动作／可调度声明<br>S11（原生） | 观测 `rotate_to_station.ready`。本件已固定于唯一工装，转台静止，人员撤离，机器人退位。<br>授权 `rotate_to_station.authorized`。请求已获得转台及其载荷的控制权。 | 观测 `rotate_to_station.sustaining`。载荷固定于同一工装，人员和机器人持续位于转位区外。 | 有限完成。同件载荷仍在工装上，实际角度进入目标容差并停稳。<br>观测 `rotate_to_station.completion` | `angleTag`、`request_id`、`rotate_to_station` | `accepted`、`actual_angle`、`at_station`、`busy`、`done`、`error`、`occupied`、`result_id`、`rotating` |
| `rotate_to_station` 工位<br>动作／可调度声明<br>S12、参考模板（登记） | 观测 `rotate_to_station.pre_1`。新请求、设备可接受、工位或角度有效、使能和旋转区域许可有效 | 观测 `rotate_to_station.sustaining`。持续条件与阶段身份 | 有限完成。实际角度及角速度满足阈值，at_station 有效并报告本次 done<br>观测 `rotate_to_station.completion` | `enableTag`、`request_id`、`rotate_to_station`、`target_station` | `accepted`、`actual_angle`、`at_station`、`busy`、`done`、`error`、`error_code`、`result_id`、`rotating` |
| `accept_material` 接收物料<br>动作／可调度声明<br>S12、参考模板（登记） | 授权 `accept_material.pre_1`。转台停稳且与来源对齐、容量可用、交接授权有效 | 观测 `accept_material.sustaining`。持续条件与阶段身份 | 有限完成。物料进入支承区域并完成归属转移<br>观测 `accept_material.completion` | — | `accepted`、`actual_angle`、`busy`、`done`、`error`、`error_code`、`occupied`、`result_id`、`rotating` |
| `convey_on_deck` 台面输送<br>动作／可调度声明<br>S12、参考模板（登记） | 配置 `transfer_module = true`<br>观测 `convey_on_deck.pre_1`。配置实际输送模块、台面停稳、转台与目标对齐、输送许可有效 | 观测 `convey_on_deck.sustaining`。持续条件与阶段身份 | 持续观测。发布输送状态；物料交接由 release_material 确认，无独立全局 done<br>观测 `convey_on_deck.completion` | `speedTag`、`transfer_enable` | `done`、`occupied`、`rotating` |
| `hold_rotation` 减速保持<br>动作／可调度声明<br>S12、参考模板（登记） | 观测 `hold_rotation.pre_1`。支持在途保持<br>观测 `hold_rotation.pre_2`。支承物料和相关资源继续有效 | 观测 `hold_rotation.sustaining`。持续条件与阶段身份 | 有限完成。实际转动降至静止阈值，原定位任务仍未完成<br>观测 `hold_rotation.completion` | `enableTag` | `accepted`、`actual_angle`、`busy`、`done`、`error`、`error_code`、`result_id`、`rotating` |
| `publish_turntable_state` 发布角度与占用<br>观测／非调度入口<br>S12、参考模板（登记） | 观测 `publish_turntable_state.pre_1`。从实际角度、速度和支承区域观测状态 | 无附加检查 | 持续观测。更新 actual_angle、rotating、at_station、occupied 和任务结果<br>观测 `publish_turntable_state.completion` | — | `accepted`、`actual_angle`、`at_station`、`busy`、`done`、`error`、`error_code`、`occupied`、`result_id`、`rotating` |
| `release_material` 出料交接<br>动作／可调度声明<br>S12、参考模板（登记） | 观测 `release_material.pre_1`。台面停稳、出口对齐、下游及容量预留有效 | 观测 `release_material.sustaining`。持续条件与阶段身份 | 有限完成。下游确认接收指定物料后更新 occupied<br>观测 `release_material.completion` | — | `accepted`、`actual_angle`、`busy`、`done`、`error`、`error_code`、`occupied`、`result_id`、`rotating` |
| `resume_rotation` 恢复转动<br>动作／可调度声明<br>S12、参考模板（登记） | 授权 `resume_rotation.pre_1`。原目标有效、故障解除、所需资源仍获准 | 观测 `resume_rotation.sustaining`。持续条件与阶段身份 | 有限完成。继续向保留目标转动；最终结果由 rotate_to_station 判断<br>观测 `resume_rotation.completion` | `enableTag` | `accepted`、`actual_angle`、`busy`、`done`、`error`、`error_code`、`result_id`、`rotating` |

原始契约　[S11](../../public/scene/S11/contracts/rotary_table.json) · [S12](../../public/scene/S12/contracts/rotary_table.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/rotary_table.json)

<a id="type-machine-tool"></a>

## 加工机床　`machine_tool`

S06 的工位只有一个。同一 raw 工件在加工点稳定支承、机器人空手归位且资源获准后开始。加工期间持续复核支承与退位，完成时检查对应请求的加工记录和 finished 状态。停止时尚未完成的工件保留 raw。

**已接入候选场景的直接调用**　`machine_material`（S06）。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `execute`<br>`DINT` `request_id`、`subject_id` |
| 输出 | `BOOL` `accepted`、`busy`、`done`、`error`<br>`DINT` `result_id` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `machine_material` 加工指定物料<br>动作／可调度声明<br>S06（原生） | 观测 `machine_material.ready`。指定毛坯在加工点稳定支承，机床空闲，机械臂空手且已归位。<br>授权 `machine_material.authorized`。本请求独占机床、工位、物料及必要的机械臂互锁资源。 | 观测 `machine_material.sustaining`。指定物料由加工点持续支承，机械臂保持退位。 | 有限完成。同一物料完成加工周期，实际状态已成为 finished，并仍由加工点支承。<br>观测 `machine_material.completion` | `execute`、`request_id`、`subject_id` | `accepted`、`busy`、`done`、`error`、`result_id` |

原始契约　[S06](../../public/scene/S06/contracts/machine_tool.json)

<a id="type-material-source-station"></a>

## 出料口　`material_source_station`

已有六个候选场景通过环境按身份准入和生成交付回执。下表保留出料设备各动作的契约。环境准入的成功仅证明该次物料供应。

**已接入候选场景的直接调用**　无。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `produce_request`、`reset`、`runTag`<br>`DINT` `request_id` |
| 输出 | `BOOL` `accepted`、`busy`、`done`、`empty`、`error`、`material_available`<br>`DINT` `countTag`、`result_id`<br>`INT` `buffer_count`、`error_code` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `pause_production` 暂停生产<br>动作／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S05、S11、参考模板（登记） | 观测 `pause_production.pre_1`。适用于有无在途任务<br>观测 `pause_production.pre_2`。拒绝新请求<br>观测 `pause_production.pre_3`。保留已接受任务和预留 | 观测 `pause_production.sustaining`。持续条件与阶段身份 | 有限完成。停止周期推进，不删除已有物料，也不把暂停当作生产完成<br>观测 `pause_production.completion` | `runTag` | `accepted`、`buffer_count`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `present_material` 呈现<br>动作／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S05、S11、参考模板（登记） | 授权 `present_material.pre_1`。缓冲区有指定物料、出口空间可用、交接授权和可配置下游联锁有效 | 观测 `present_material.sustaining`。持续条件与阶段身份 | 有限完成。物料到达出口并可取，更新 material_available；取走后再释放相应占用<br>观测 `present_material.completion` | `runTag` | `accepted`、`buffer_count`、`busy`、`done`、`error`、`error_code`、`material_available`、`result_id` |
| `produce_material` 生产物料<br>动作／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S05、S11、参考模板（登记） | 观测 `produce_material.pre_1`。生产许可有效、未暂停、产品及参数合法、缓冲容量含预留足够<br>观测 `produce_material.pre_2`。按需为新请求<br>观测 `produce_material.pre_3`。节拍为计时到期 | 观测 `produce_material.sustaining`。持续条件与阶段身份 | 有限完成。实际生成成功，更新缓冲数量并且仅计数一次；不是仅发出 spawn 请求<br>观测 `produce_material.completion` | `produce_request`、`request_id`、`runTag` | `accepted`、`buffer_count`、`busy`、`countTag`、`done`、`error`、`error_code`、`result_id` |
| `publish_source_state` 发布源端状态<br>观测／非调度入口<br>S01、S02、S04、S06、S07（原生）<br>S05、S11、参考模板（登记） | 观测 `publish_source_state.pre_1`。统计来自实际成功生成和实际缓冲占用 | 无附加检查 | 持续观测。更新 countTag、buffer_count、empty、material_available 及任务结果<br>观测 `publish_source_state.completion` | — | `accepted`、`buffer_count`、`busy`、`countTag`、`done`、`empty`、`error`、`error_code`、`material_available`、`result_id` |
| `resume_production` 恢复生产<br>动作／可调度声明<br>S01、S02、S04、S06、S07（原生）<br>S05、S11、参考模板（登记） | 观测 `resume_production.pre_1`。原任务或生产模式有效、设备无阻止恢复的故障、资源状态允许 | 观测 `resume_production.sustaining`。持续条件与阶段身份 | 有限完成。继续保留的周期；重复恢复不新建同一生产任务<br>观测 `resume_production.completion` | `runTag` | `accepted`、`buffer_count`、`busy`、`done`、`error`、`error_code`、`result_id` |
| `schedule_production_cycle` 固定<br>内部／非调度入口<br>S01、S02、S04、S06、S07（原生）<br>S05、S11、参考模板（登记） | 观测 `schedule_production_cycle.pre_1`。启用节拍模式、周期正且有限<br>观测 `schedule_production_cycle.pre_2`。随机策略使用可复现随机源 | 观测 `schedule_production_cycle.sustaining`。持续条件与阶段身份 | 持续观测。按节拍生成内部生产请求；暂停时冻结剩余时间，不补发停机欠账<br>观测 `schedule_production_cycle.completion` | `runTag` | `buffer_count`、`countTag` |

原始契约　[S01](../../public/scene/S01/contracts/material_source_station.json) · [S02](../../public/scene/S02/contracts/material_source_station.json) · [S04](../../public/scene/S04/contracts/material_source_station.json) · [S05](../../public/scene/S05/contracts/material_source_station.json) · [S06](../../public/scene/S06/contracts/material_source_station.json) · [S07](../../public/scene/S07/contracts/material_source_station.json) · [S11](../../public/scene/S11/contracts/material_source_station.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/material_source.json)

<a id="type-workpiece"></a>

## 物料　`workpiece`

工件由抓取、输送、加工、释放等外部动作驱动。下表的观测随物理状态更新。独立 engine_block 声明为被动刚体，其行为与逻辑端口列表都为空。带承载属性的物料另见旧托盘兼容节。

**已接入候选场景的直接调用**　无。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | — |
| 输出 | `BOOL` `carried`、`picked`、`placed`<br>`DINT` `holder_id`、`location_id` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `be_carried` 被携带<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S03、S04、S05、S07、S08、S09、S10、S11、S12、参考模板（登记） | 观测 `be_carried.pre_1`。有效持有关系仍成立<br>观测 `be_carried.pre_2`。身份与任务关联一致 | 观测 `be_carried.sustaining`。持续条件与阶段身份 | 持续观测。按声明持有模型更新姿态；持续过程无本体任务 done<br>观测 `be_carried.completion` | — | `carried`、`holder_id`、`location_id` |
| `be_conveyed` 被输送<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S03、S04、S05、S07、S08、S09、S10、S11、S12、参考模板（登记） | 观测 `be_conveyed.pre_1`。物料与输送面具有有效接触／支承<br>观测 `be_conveyed.pre_2`。不被冲突执行器独立驱动 | 观测 `be_conveyed.sustaining`。持续条件与阶段身份 | 持续观测。实际位置及工艺区域更新；目标到达由外层运输任务确认<br>观测 `be_conveyed.completion` | — | `location_id` |
| `be_picked` 被抓取<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S03、S04、S05、S07、S08、S09、S10、S11、S12、参考模板（登记） | 观测 `be_picked.pre_1`。物料存在且可抓、几何可接触、无冲突持有或预留、夹具及载荷兼容 | 观测 `be_picked.sustaining`。持续条件与阶段身份 | 有限完成。实际持有关系建立，发布 picked 并更新 carried/holder_id<br>观测 `be_picked.completion` | — | `carried`、`holder_id`、`picked` |
| `be_placed` 被放置<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S03、S04、S05、S07、S08、S09、S10、S11、S12、参考模板（登记） | 观测 `be_placed.pre_1`。目标兼容、容量可用、支承和位置满足要求<br>观测 `be_placed.pre_2`。can_stack=false 时禁止把堆叠当合法目标 | 观测 `be_placed.sustaining`。持续条件与阶段身份 | 有限完成。实际放置和交接成立，更新 placed/location_id<br>观测 `be_placed.completion` | — | `location_id`、`placed` |
| `be_released` 被释放<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S03、S04、S05、S07、S08、S09、S10、S11、S12、参考模板（登记） | 授权 `be_released.pre_1`。释放者确为持有者且获准<br>观测 `be_released.pre_2`。按放置或自由释放模式检查条件 | 观测 `be_released.sustaining`。持续条件与阶段身份 | 有限完成。清除持有关系；自由释放不自动等于稳定放置成功<br>观测 `be_released.completion` | — | `carried`、`holder_id`、`placed` |
| `publish_material_state` 发布物料状态<br>观测／非调度入口<br>S01、S02、S06（原生）<br>S03、S04、S05、S07、S08、S09、S10、S11、S12、参考模板（登记） | 观测 `publish_material_state.pre_1`。来源有效<br>观测 `publish_material_state.pre_2`。区分持续状态与一次通知 | 无附加检查 | 持续观测。更新 picked/carried/placed、holder_id、location_id 和事件关联<br>观测 `publish_material_state.completion` | — | `carried`、`holder_id`、`location_id`、`picked`、`placed` |
| `respond_to_physics` 响应重力与接触<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S03、S04、S05、S07、S08、S09、S10、S11、S12、参考模板（登记） | 观测 `respond_to_physics.pre_1`。已配置实际物理执行<br>观测 `respond_to_physics.pre_2`。质量、形状和约束有效 | 观测 `respond_to_physics.sustaining`。持续条件与阶段身份 | 持续观测。刚体位置、接触和支承按物理结果更新，无本体任务 done<br>观测 `respond_to_physics.completion` | — | `location_id` |

**工作台示意观测 `observe_material`。** 前置条件为空，完成检查读取 `observation.completed == true`。输入与输出信号均为空。它属于预览模板。生产场景使用实际物料状态或承载占用证据。[模板生成器](../../src/domain/catalog.ts)

原始契约　[S01](../../public/scene/S01/contracts/workpiece.json) · [S02](../../public/scene/S02/contracts/workpiece.json) · [S03](../../public/scene/S03/contracts/workpiece.json) · [S04](../../public/scene/S04/contracts/workpiece.json) · [S05](../../public/scene/S05/contracts/workpiece.json) · [S06](../../public/scene/S06/contracts/workpiece.json) · [S07](../../public/scene/S07/contracts/workpiece.json) · [S08](../../public/scene/S08/contracts/workpiece.json) · [S09](../../public/scene/S09/contracts/workpiece.json) · [S10](../../public/scene/S10/contracts/workpiece.json) · [S11](../../public/scene/S11/contracts/workpiece.json) · [S12](../../public/scene/S12/contracts/workpiece.json) · [engine_block](../../public/modles/engine_block/schema.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/material.json)

<a id="type-linear-rail"></a>

## 滑轨　`linear_rail`

S07 按具名设备或槽位计算轴目标，检查实际限位、带载路径与升降台组合状态。到位以实测位置、停稳和匹配请求为证。设备另发布 actual_position、actual_speed 供观测。

**已接入候选场景的直接调用**　`move_to_location`（S07）。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `enable`、`execute`、`stop`<br>`DINT` `request_id`<br>`REAL` `target_position` |
| 输出 | `BOOL` `accepted`、`busy`、`done`、`error`<br>`DINT` `error_code`、`result_id`<br>`REAL` `actual_position`、`actual_speed` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `move_to_location`<br>动作／可调度声明<br>S07（原生） | 观测 `move_to_location.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `move_to_location.authorized`。本请求获得运动、工件及端点资源 | 观测 `move_to_location.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `move_to_location.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `move_to_position`<br>动作／可调度声明<br>S07（原生） | 观测 `move_to_position.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `move_to_position.authorized`。本请求获得运动、工件及端点资源 | 观测 `move_to_position.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `move_to_position.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `stop_motion`<br>动作／可调度声明<br>S07（原生） | 观测 `stop_motion.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `stop_motion.authorized`。本请求获得运动、工件及端点资源 | 观测 `stop_motion.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `stop_motion.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |

**S07 原生条件的逐动作判据。** 上表保留原契约条件键，准备阶段结合安装关系和请求参数解析以下物理证据。到位或交接结果均须与本次请求匹配。

| 行为 | 准入检查 | 完成证据 |
| --- | --- | --- |
| `move_to_location` | 轴组停稳，具名工位可解析，目标合法，带载路径通过检查 | 轨道在解析出的目标轴坐标到位并停稳 |
| `move_to_position` | 轴组停稳，米制位置有限且在行程内，带载路径可通过 | 轨道在请求的数值位置到位并停稳 |
| `stop_motion` | 有效的停止请求，当前轴状态可读 | 制动后轨道速度降至停稳阈值 |

原始契约　[S07](../../public/scene/S07/contracts/linear_rail.json)

<a id="type-lift-table"></a>

## 升降台　`lift_table`

S07 对具名目标、数值高度和保持请求分别核对行程及制停状态。接放料须核对指定物料归属、源支承、目的地容量／预留、轴对位及路径。交接成功以同件在目标支承且归属变更为证。actual_height、moving、at_level 属于设备级反馈。单行动作直接端口见表。

**已接入候选场景的直接调用**　`accept_material`（S07），`lift_to_location`（S07），`release_material`（S07）。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `enableTag`、`execute`、`popupTag`、`reset`<br>`DINT` `request_id`<br>`INT` `target_level`<br>`REAL` `move_to_level`、`speedFpmTag`、`speedTag` |
| 输出 | `BOOL` `accepted`、`at_level`、`busy`、`done`、`error`、`moving`、`transfer_ready`<br>`DINT` `result_id`<br>`INT` `error_code`<br>`REAL` `actual_height` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `accept_material`<br>动作／可调度声明<br>S07（原生） | 观测 `accept_material.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `accept_material.authorized`。本请求获得运动、工件及端点资源 | 观测 `accept_material.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `accept_material.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `accept_material` 接收物料<br>动作／可调度声明<br>参考模板（登记） | 授权 `accept_material.pre_1`。平台停稳、来源接口高度匹配、平台容量可用、交接权限有效 | 观测 `accept_material.sustaining`。持续条件与阶段身份 | 有限完成。物料稳定进入平台并完成归属转移<br>观测 `accept_material.completion` | — | `accepted`、`actual_height`、`at_level`、`busy`、`done`、`error`、`error_code`、`moving`、`result_id` |
| `lift_to_location`<br>动作／可调度声明<br>S07（原生） | 观测 `lift_to_location.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `lift_to_location.authorized`。本请求获得运动、工件及端点资源 | 观测 `lift_to_location.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `lift_to_location.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `release_material`<br>动作／可调度声明<br>S07（原生） | 观测 `release_material.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `release_material.authorized`。本请求获得运动、工件及端点资源 | 观测 `release_material.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `release_material.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `release_material` 释放物料<br>动作／可调度声明<br>参考模板（登记） | 观测 `release_material.pre_1`。平台停稳且目标高度匹配、下游可接收并已预留 | 观测 `release_material.sustaining`。持续条件与阶段身份 | 有限完成。下游确认接收后释放平台占用<br>观测 `release_material.completion` | — | `accepted`、`actual_height`、`at_level`、`busy`、`done`、`error`、`error_code`、`moving`、`result_id` |
| `hold_lift`<br>动作／可调度声明<br>S07（原生） | 观测 `hold_lift.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `hold_lift.authorized`。本请求获得运动、工件及端点资源 | 观测 `hold_lift.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `hold_lift.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `hold_lift` 减速保持<br>动作／可调度声明<br>参考模板（登记） | 观测 `hold_lift.pre_1`。设备声明可保持在途动作<br>观测 `hold_lift.pre_2`。载荷和资源继续保留 | 观测 `hold_lift.sustaining`。持续条件与阶段身份 | 有限完成。实际速度降至静止阈值并保持；上层升降任务尚未完成<br>观测 `hold_lift.completion` | `enableTag` | `accepted`、`actual_height`、`busy`、`done`、`error`、`error_code`、`moving`、`result_id` |
| `lift_to_level`<br>动作／可调度声明<br>S07（原生） | 观测 `lift_to_level.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `lift_to_level.authorized`。本请求获得运动、工件及端点资源 | 观测 `lift_to_level.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `lift_to_level.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `lift_to_level` 升降定位<br>动作／可调度声明<br>参考模板（登记） | 授权 `lift_to_level.pre_1`。新请求、设备可接受、使能有效、层号存在或高度在行程内、平台资源获准 | 观测 `lift_to_level.sustaining`。持续条件与阶段身份 | 有限完成。实际高度误差和速度满足阈值，报告本次 done<br>观测 `lift_to_level.completion` | `enableTag`、`execute`、`move_to_level`、`request_id` | `accepted`、`actual_height`、`at_level`、`busy`、`done`、`error`、`error_code`、`moving`、`result_id` |
| `lower_transfer_chains` 下降辅助链条<br>动作／可调度声明<br>参考模板（登记） | 配置 `transfer_module = true`<br>观测 `lower_transfer_chains.pre_1`。启用横移模块<br>观测 `lower_transfer_chains.pre_2`。物料已满足支承／交接条件<br>观测 `lower_transfer_chains.pre_3`。下降不会破坏持有关系 | 观测 `lower_transfer_chains.sustaining`。持续条件与阶段身份 | 有限完成。辅助机构实际到达下位<br>观测 `lower_transfer_chains.completion` | `popupTag` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id`、`transfer_ready` |
| `raise_transfer_chains` 抬升辅助链条<br>动作／可调度声明<br>参考模板（登记） | 配置 `transfer_module = true`<br>观测 `raise_transfer_chains.pre_1`。启用独立横移模块<br>观测 `raise_transfer_chains.pre_2`。主平台停稳、辅助行程及资源允许 | 观测 `raise_transfer_chains.sustaining`。持续条件与阶段身份 | 有限完成。辅助机构实际到达上位，不仅按计时推断<br>观测 `raise_transfer_chains.completion` | `popupTag` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id`、`transfer_ready` |
| `resume_lift` 恢复升降<br>动作／可调度声明<br>参考模板（登记） | 授权 `resume_lift.pre_1`。原任务有效、故障条件解除、资源仍获准、目标未被覆盖 | 观测 `resume_lift.sustaining`。持续条件与阶段身份 | 有限完成。进入原任务执行阶段；最终到位由 lift_to_level 判断<br>观测 `resume_lift.completion` | `enableTag` | `accepted`、`actual_height`、`busy`、`done`、`error`、`error_code`、`moving`、`result_id` |
| `transfer_material`<br>动作／可调度声明<br>S07（原生） | 观测 `transfer_material.ready`。目标有效、相关轴静止、来源与接收端可用<br>授权 `transfer_material.authorized`。本请求获得运动、工件及端点资源 | 观测 `transfer_material.sustaining`。本轮运行和在途交接持续有效 | 有限完成。按本次请求核对实际位姿、支承与归属<br>观测 `transfer_material.completion`。本次请求得到物理完成证据 | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`result_id` |
| `transfer_material` 横向输送<br>动作／可调度声明<br>参考模板（登记） | 配置 `transfer_module = true`<br>观测 `transfer_material.pre_1`。主平台停稳、辅助机构到所需位置、transfer_ready、路径及下游可用 | 观测 `transfer_material.sustaining`。持续条件与阶段身份 | 有限完成。指定物料交接完成；停机仅反馈静止，不自动算交接成功<br>观测 `transfer_material.completion` | `popupTag`、`speedTag` | `accepted`、`busy`、`done`、`error`、`error_code`、`result_id`、`transfer_ready` |

**S07 原生条件的逐动作判据。** 上表保留原契约条件键，准备阶段结合安装关系和请求参数解析以下物理证据。到位或交接结果均须与本次请求匹配。

| 行为 | 准入检查 | 完成证据 |
| --- | --- | --- |
| `lift_to_location` | 轴组停稳，能从目标工位解算升降高度，检查行程和带载路径 | 平台在该工位对应的高度到位并停稳 |
| `lift_to_level` | 轴组停稳，请求高度及单位有效，折算出的轴位移在限位内，路径可通过 | 平台到达请求高度并停稳 |
| `hold_lift` | 有效的保持请求，当前平台位置可读 | 升降轴停稳并保持当前位置 |
| `accept_material` | 指定工件在已声明来源稳定支承，平台已对接且可接件，路径与承载条件有效 | 同件抵达平台、建立承载绑定，完成归属交接 |
| `release_material` | 平台持有同件、已对接目的地，支承、容量、预留和路径满足条件 | 同件在目标实际支承，平台解除占用，提交目的地交接 |
| `transfer_material` | 按载荷解析来源与目标，路线受支持，核实来源归属、目的地可用与轴组对位 | 同一物料在解析后的目标得到支承，交接服务提交本次结果 |

原始契约　[S07](../../public/scene/S07/contracts/lift_table.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/lift_transport.json)

<a id="type-storage-rack"></a>

## 仓储柜　`storage_rack`

S07 在升降台的实际交接中调用库存服务。按槽位和请求预留，物理交接确认后提交 stored 或 retrieved，取消时释放本请求的预留。表中服务声明与这条内部调用路径分别验收。

**已接入候选场景的直接调用**　无。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `cancel_reservation`、`release_request`、`reserve_request`、`reset`、`store_request`<br>`DINT` `material_id`、`owner_task_id`、`request_id`<br>`INT` `cell_id` |
| 输出 | `BOOL` `accepted`、`busy`、`cell_available`、`cell_full`、`done`、`error`、`released`、`reservation_granted`、`stored`<br>`DINT` `reservation_id`、`result_id`<br>`INT` `error_code`、`free_cells` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `cancel_cell_reservation` 取消预留<br>服务／可调度声明<br>S07、参考模板（登记） | 观测 `cancel_cell_reservation.pre_1`。预留属于当前任务、无不可撤销交接、没有必须保留的真实占用 | 观测 `cancel_cell_reservation.sustaining`。持续条件与阶段身份 | 有限完成。只撤销指定预留，不修改物料位置或其他任务<br>观测 `cancel_cell_reservation.completion` | `cancel_reservation`、`cell_id`、`owner_task_id`、`request_id` | `accepted`、`busy`、`cell_available`、`done`、`error`、`error_code`、`free_cells`、`reservation_granted`、`result_id` |
| `publish_storage_state` 发布仓储状态<br>观测／非调度入口<br>S07、参考模板（登记） | 观测 `publish_storage_state.pre_1`。实际占用、预留与执行反馈已对齐<br>观测 `publish_storage_state.pre_2`。异常期间保留未知或在途状态 | 无附加检查 | 持续观测。更新 cell_available、cell_full、free_cells、结果及错误<br>观测 `publish_storage_state.completion` | — | `accepted`、`busy`、`cell_available`、`cell_full`、`done`、`error`、`error_code`、`free_cells`、`released`、`reservation_granted`、`reservation_id`、`result_id`、`stored` |
| `query_cell_state` 查询库位<br>服务／可调度声明<br>S07、参考模板（登记） | 观测 `query_cell_state.pre_1`。查询编号与状态版本有效 | 观测 `query_cell_state.sustaining`。持续条件与阶段身份 | 有限完成。返回确认过的占用、预留和任务关联信息<br>观测 `query_cell_state.completion` | `cell_id` | `accepted`、`busy`、`cell_available`、`cell_full`、`done`、`error`、`error_code`、`free_cells`、`reservation_granted`、`reservation_id`、`result_id` |
| `release_from_cell` 出库交接<br>服务／可调度声明<br>S07、参考模板（登记） | 授权 `release_from_cell.pre_1`。库位存在指定物料、任务获出库权限、接收方和目标可用 | 观测 `release_from_cell.sustaining`。持续条件与阶段身份 | 有限完成。物料离开并由接收方确认后释放占用，发布 released<br>观测 `release_from_cell.completion` | `cell_id`、`material_id`、`owner_task_id`、`release_request`、`request_id` | `accepted`、`busy`、`cell_available`、`cell_full`、`done`、`error`、`error_code`、`free_cells`、`released`、`result_id` |
| `reserve_cell` 预留库位<br>服务／可调度声明<br>S07、参考模板（登记） | 观测 `reserve_cell.pre_1`。库位有效、实际容量及已有预留允许、物料兼容、任务身份有效 | 观测 `reserve_cell.sustaining`。持续条件与阶段身份 | 有限完成。原子建立预留，返回 reservation_granted 和 reservation_id<br>观测 `reserve_cell.completion` | `cell_id`、`material_id`、`owner_task_id`、`request_id`、`reserve_request` | `accepted`、`busy`、`cell_available`、`done`、`error`、`error_code`、`free_cells`、`reservation_granted`、`reservation_id`、`result_id` |
| `store_to_cell` 入库交接<br>服务／可调度声明<br>S07、参考模板（登记） | 观测 `store_to_cell.pre_1`。任务持有目标预留、搬运方拥有物料、尺寸及载荷条件满足 | 观测 `store_to_cell.sustaining`。持续条件与阶段身份 | 有限完成。实际放置与交接确认后，预留转为占用，发布 stored<br>观测 `store_to_cell.completion` | `cell_id`、`material_id`、`owner_task_id`、`request_id`、`store_request` | `accepted`、`busy`、`cell_full`、`done`、`error`、`error_code`、`free_cells`、`result_id`、`stored` |

原始契约　[S07](../../public/scene/S07/contracts/storage_rack.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/storage_rack.json)

<a id="type-human-operator"></a>

## 搬运人员　`human_operator`

S11 要求机器人退位、转台静止在装卸侧、指定来源和目标有效。搬运期间检查吸附归属，放到目标后核实支承，手部撤回且空手，才提交本次物料、来源及目标的移交记录。

**已接入候选场景的直接调用**　`carry_material`（S11）。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | `BOOL` `execute`<br>`DINT` `request_id` |
| 输出 | `BOOL` `accepted`、`busy`、`done`、`error`、`holding_material`<br>`DINT` `result_id` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `carry_material` 吸附搬运<br>动作／可调度声明<br>S11（原生） | 观测 `carry_material.ready`。指定物料位于来源且已支承，目标可用，转台处于装卸位且机器人已退位。<br>授权 `carry_material.authorized`。请求已获得人员、物料与装卸位的互斥资源。 | 观测 `carry_material.sustaining`。吸附期间保持当前物料身份，装卸转台持续停稳。 | 有限完成。同一物料在目标完成交接，人员已释放物料并撤离。<br>观测 `carry_material.completion` | `execute`、`request_id` | `accepted`、`busy`、`done`、`error`、`holding_material`、`result_id` |

原始契约　[S11](../../public/scene/S11/contracts/human_operator.json)

<a id="type-workpiece-carrier"></a>

## 旧托盘兼容　`workpiece_carrier`

旧声明均没有行为输入端口。预留、取消和装载确认在兼容层保留原来的服务语义。承载、解绑、随盘移动和发布占用转为物料的承载服务与被动观测。新类型目录只有 workpiece。

**已接入候选场景的直接调用**　无。

**端口字典**　同一行内的端口共用列出的 PLC 类型。

| 方向 | PLC 类型与端口 ID |
| --- | --- |
| 输入 | — |
| 输出 | `BOOL` `in_transport`、`loaded`、`slot_available`、`unloaded`<br>`DINT` `holder_id`<br>`INT` `free_slots`、`load_count` |

| 行为与适用来源 | 前置条件及型号门槛 | 持续条件 | 完成条件或持续观测 | 输入信号 | 输出信号 |
| --- | --- | --- | --- | --- | --- |
| `be_transported_loaded` 整托搬运<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S10、参考模板（登记） | 观测 `be_transported_loaded.pre_1`。载具可被该执行器搬运、整托质量及外形满足限制、装载关系有效 | 观测 `be_transported_loaded.sustaining`。持续条件与阶段身份 | 持续观测。载具及装载物按一致语义移动；外部运输任务确认到达<br>观测 `be_transported_loaded.completion` | — | `holder_id`、`in_transport` |
| `cancel_carrier_reservation` 取消槽位预留<br>服务／可调度声明<br>S01、S02、S06（原生）<br>S10、参考模板（登记） | 观测 `cancel_carrier_reservation.pre_1`。预留属于本任务、物料尚未交接到该槽位 | 观测 `cancel_carrier_reservation.sustaining`。持续条件与阶段身份 | 有限完成。删除指定未完成预留，不把真实装载清空<br>观测 `cancel_carrier_reservation.completion` | — | `free_slots`、`slot_available` |
| `carry_material` 随动承载<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S10、参考模板（登记） | 观测 `carry_material.pre_1`。物料已归属载具<br>观测 `carry_material.pre_2`。或采用明确的物理支承关系 | 观测 `carry_material.sustaining`。持续条件与阶段身份 | 持续观测。按选定模型更新物料与载具相对姿态；持续过程无本体任务 done<br>观测 `carry_material.completion` | — | `holder_id`、`in_transport` |
| `confirm_load` 确认装载<br>服务／可调度声明<br>S01、S02、S06（原生）<br>S10、参考模板（登记） | 观测 `confirm_load.pre_1`。槽位可用或为本任务预留、无物料归属冲突、类型和声明载荷上限满足 | 观测 `confirm_load.sustaining`。持续条件与阶段身份 | 有限完成。物料实际位于槽位并完成交接，预留转占用，增加 load_count<br>观测 `confirm_load.completion` | — | `free_slots`、`load_count`、`loaded`、`slot_available`、`unloaded` |
| `publish_carrier_state` 发布载具状态<br>观测／非调度入口<br>S01、S02、S06（原生）<br>S10、参考模板（登记） | 观测 `publish_carrier_state.pre_1`。实际占用与预留已区分<br>观测 `publish_carrier_state.pre_2`。身份与状态版本有效 | 无附加检查 | 持续观测。更新 loaded/unloaded、load_count、free_slots、slot_available、in_transport、holder_id<br>观测 `publish_carrier_state.completion` | — | `free_slots`、`holder_id`、`in_transport`、`load_count`、`loaded`、`slot_available`、`unloaded` |
| `release_material` 卸载确认<br>被动／非调度入口<br>S01、S02、S06（原生）<br>S10、参考模板（登记） | 授权 `release_material.pre_1`。指定物料属于本载具、目标可用、任务有权限 | 观测 `release_material.sustaining`。持续条件与阶段身份 | 有限完成。物料转移给接收方后减少 load_count 并释放槽位<br>观测 `release_material.completion` | — | `free_slots`、`load_count`、`loaded`、`unloaded` |
| `reserve_carrier_slot` 预留槽位<br>服务／可调度声明<br>S01、S02、S06（原生）<br>S10、参考模板（登记） | 观测 `reserve_carrier_slot.pre_1`。槽位有效且可用、物料类型兼容、任务身份有效<br>观测 `reserve_carrier_slot.pre_2`。累计预留不超容量 | 观测 `reserve_carrier_slot.sustaining`。持续条件与阶段身份 | 有限完成。原子建立带任务身份的槽位预留；不增加实际 load_count<br>观测 `reserve_carrier_slot.completion` | — | `free_slots`、`load_count`、`slot_available` |

**工作台示意观测 `observe_slots`。** 前置条件为空，完成检查读取 `observation.completed == true`。输入与输出信号均为空。它属于预览模板。生产场景使用实际物料状态或承载占用证据。[模板生成器](../../src/domain/catalog.ts)

原始契约　[S01](../../public/scene/S01/contracts/workpiece_carrier.json) · [S02](../../public/scene/S02/contracts/workpiece_carrier.json) · [S06](../../public/scene/S06/contracts/workpiece_carrier.json) · [S10](../../public/scene/S10/contracts/workpiece_carrier.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/pallet.json)

<a id="experimental-station"></a>

## 旧实验工站　`processing_station`

S05、S08、S09、S12 的实验工站使用 request_v1，保留实验声明与原有准入诊断。它的装夹配方协议与 S06 机床、S11 机械臂的加工动作分别登记。以下条件直接给出比较式。前缀 signal、observation、authorization、parameter 分别表示逻辑信号、观察结果、授权和参数。

每个动作继承同一请求协议。公共输入 `enable`、`request_id`、`command_code`、`execute`、`cancel`。公共输出 `accepted`、`accepted_id`、`busy`、`done`、`result_id`、`error`、`error_code`、`cancelled`、`stop_ack_id`、`stopped`。站级额外输出为 `fixture_closed`、`process_ready`、`interlock_ok`、`cycle_finished`。旧定义以证据条件关联阶段，没有为每个动作另存直接输出数组。下表给出各自的命令绑定及读取的设备输出。

| 行为 | 前置条件 | 持续条件 | 完成证据 | 动作命令输入 | 条件直接读取的输出 |
| --- | --- | --- | --- | --- | --- |
| `clamp` 装夹工件<br>S05、S08、S09、S12、参考模板 | `signal.busy = false`<br>`signal.error = false`<br>`signal.enable = true`<br>`authorization.operation_allowed = true`<br>`observation.subject_present(material) = true`<br>`observation.material_mass(material) ≤ parameter.max_payload_kg` | `signal.enable = true`<br>`authorization.operation_allowed = true` | `observation.subject_clamped(material) = true` | `command_code = 1`<br>`material_id = argument.material` | `busy`、`error` |
| `process_material` 按配方加工工件<br>S05、S08、S09、S12、参考模板 | `signal.busy = false`<br>`signal.error = false`<br>`signal.enable = true`<br>`authorization.operation_allowed = true`<br>`observation.subject_present(material) = true`<br>`observation.material_mass(material) ≤ parameter.max_payload_kg`<br>`observation.subject_clamped(material) = true`<br>`observation.recipe_available(material,recipe) = true`<br>`signal.process_ready = true`<br>`signal.interlock_ok = true` | `signal.enable = true`<br>`authorization.operation_allowed = true`<br>`observation.subject_clamped(material) = true`<br>`signal.interlock_ok = true` | `signal.cycle_finished = true`<br>`observation.operation_recorded(material,recipe) = true`<br>`observation.process_stopped = true` | `command_code = 2`<br>`material_id = argument.material`<br>`recipe_id = argument.recipe` | `busy`、`cycle_finished`、`error`、`interlock_ok`、`process_ready` |
| `unclamp` 松夹工件<br>S05、S08、S09、S12、参考模板 | `signal.busy = false`<br>`signal.error = false`<br>`signal.enable = true`<br>`authorization.operation_allowed = true`<br>`observation.subject_present(material) = true`<br>`observation.material_mass(material) ≤ parameter.max_payload_kg`<br>`observation.process_stopped = true` | `signal.enable = true`<br>`authorization.operation_allowed = true` | `observation.subject_unclamped(material) = true`<br>`observation.subject_present(material) = true` | `command_code = 3`<br>`material_id = argument.material` | `busy`、`error` |

原始契约　[S05](../../public/scene/S05/contracts/processing_station.json) · [S08](../../public/scene/S08/contracts/processing_station.json) · [S09](../../public/scene/S09/contracts/processing_station.json) · [S12](../../public/scene/S12/contracts/processing_station.json) · [参考模板](../../../test1/dsl_new/asset_contracts/assets/processing_station.json) · [request_v1 协议定义](../../../test1/dsl_new/legacy/pre-device-spec/asset_contracts/shared/protocols.json)

<a id="legacy-examples"></a>

## 旧公开示例与实际运行检查

四份旧示例保留导入兼容。旧文件在行为级保存输入、控制、输出及部分文本描述。下表的空项明确指原文件未给出。文本效果只作历史描述，统一导入器的旧格式分支生成空完成检查。旧 flow_input／flow_output 属于工艺口。

| 旧示例与行为 | 前置（旧文本） | 完成或效果（旧文本） | 输入 | 控制 | 输出 |
| --- | --- | --- | --- | --- | --- |
| [carrier_tray_1](../../public/catalog/examples/carrier_tray_1.json) `carry_material` | — | — | — | — | `loaded` |
| [carrier_tray_1](../../public/catalog/examples/carrier_tray_1.json) `release_material` | — | — | — | — | `unloaded` |
| [conveyor_1](../../public/catalog/examples/conveyor_1.json) `accept_material` | `capacity_available == true`、`entry_stop_point_available == true` | — | — | — | `stop_point_occupied` |
| [conveyor_1](../../public/catalog/examples/conveyor_1.json) `advance_to_next_stop_point` | — | — | — | — | `stop_point_occupied`、`stop_point_released` |
| [conveyor_1](../../public/catalog/examples/conveyor_1.json) `transport_to_exit` | — | — | — | — | `part_ready`、`done`、`stop_point_released` |
| [conveyor_1](../../public/catalog/examples/conveyor_1.json) `release_material` | — | — | `release_waiting_material` | — | — |
| [robot_arm_1](../../public/catalog/examples/robot_arm_1.json) `pick_and_place` | `fsm_state == idle`、`material_at(input_process_port)`、`gripper.empty == true`、`pause_pick.active != true` | `material_at(output_process_port)`、`emit done` | `start_pick`、`resume_pick` | `pause_pick` | `busy`、`done`、`error` |
| [workpiece_1](../../public/catalog/examples/workpiece_1.json) | — | 无行为条目 | — | — | — |

**执行验收。** 对已接入的六个候选场景，准备阶段按声明检查行为、命令载荷、端点角色和可用条件提供者。运行阶段核对同一 run、请求和物料的物理证据。S01 类定位条件可读取请求账本、位置误差、支承和停稳，S04 的交接、S07 的仓储、S06 的机床、S11 的分度与工具加工还依赖相应原生实现。设备可以额外发布状态，例如升降台的 actual_height 或机械臂的 error_code。行为行以该版契约列出的直接输出为准。

条件与执行出处　[结构化条件的数据源](../../src/runtime/assembly/SceneConditionBindings.ts) · [双臂交接](../../src/runtime/assembly/HandoffRuntimeAssembler.ts) · [仓储转移](../../src/runtime/assembly/WarehouseRuntimeAssembler.ts) · [装载与机床](../../src/runtime/assembly/LoadingRuntimeAssembler.ts) · [人物、转台和工具加工](../../src/runtime/assembly/IndexedProcessingRuntimeAssembler.ts)
