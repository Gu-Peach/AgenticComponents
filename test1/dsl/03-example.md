# 完整工艺示例：输送到出口、停带、抓放到托盘

本例的“完整”指工艺文本、IR、绑定设计、异常路径和验收要求齐全。它是 **design_only**，不是已通过物理闭环的演示。运行入口应返回未接入能力清单，不得用 Mock 或位置插值代替缺失的机械臂、交接服务。

## 1 文件与目标

| 文件 | 内容 |
| --- | --- |
| [process.acp](examples/pick-place/process.acp) | 可由参考前端解析的工艺文本 |
| [process.ir.json](examples/pick-place/process.ir.json) | 由文本生成的完整 ProcessIR，无省略字段 |
| [process.map.json](examples/pick-place/process.map.json) | 每个节点到源文本的字节/行列映射 |
| [cell.design.json](examples/pick-place/cell.design.json) | 所有别名、策略、登记表、控制/服务提案与执行阻塞项 |
| [robot.design.json](examples/pick-place/robot.design.json) | 抓放能力的 DeviceSpec 草稿；pending_adapter，无真实模型/执行器 |

目标：将预先放置在 conveyor_1 带面上的 workpiece_1 运到出口，停止带面后由 robot_1 放入 tray_1/slot_01。任务只处理一件物料，不生成工件、不自动挑选槽位、不复制 GLB。载具是被动接收对象，交接服务管理预留/归属。

实际已有输送契约引用 [Conveyor_aankws](../modles/Conveyor_aankws/schema.json)，当前为 1.3 / 0.6.0；transport_to_exit 的动作参数是 subject_id 正整数。示例不复制其参数与条件。新机器人草稿借用 [行为规范](../docs/schema.md) 的 pick_and_place 含义，但 subject_id/target_slot_id 的整数接口是本示例明确提出的设计，不是旧 scene1 机械臂已有接口。未来换成真实设备定义必须重新绑定。

## 2 初始状态与场景义务

| 对象 | 必须确认的状态 |
| --- | --- |
| conveyor_1 | 具有已标定带面/出口检测区；唯一 runTag/speedTag 写入者；实际初始停止 |
| workpiece_1 | 唯一 ID，正质量和有效碰撞体；物理支承在带面；业务 holder 为 conveyor_1 |
| robot_1 | 已标定关节、TCP、工具与路径；夹具空；能受控停止和保留在途物料 |
| tray_1/slot_01 | 真实载位几何可达、空闲、载荷与物料尺寸兼容；没有其他任务预留 |
| transfer_zone | 已定义几何版本，仲裁与实际占用检测来源已登记 |
| 全局 | 固定 1/60 s；外部输入记录；只有一个物料位姿写入者；所有 provider 明确有效性 |

本例环境仅登记 ID 和配置，没有填入猜测的场景坐标/机器人标定。真实 SceneDocument、物理初态、质量、支承与路径必须单独供给，清单中的 pending 状态不能改个名字便绕过验证。`0.2 m/s`、30 s 等为设计测试值，不是硬件安全上限或实测性能。

## 3 正常流程

```text
main: seq
  feed: with-control feed_drive
    transport: conveyor.transport_to_exit(subjects[workpiece_1])
  still_at_exit: await 最新的本物料出口观测
  transfer: robot.pick_and_place(subjects[workpiece_1], slots[tray_1/slot_01])
  verify_loaded: await 本次抓放的载位承载/归属确认
```

1. feed 获得 conveyor_command 写入许可，原子提交 speedTag=0.2 m/s、runTag=true。收到同控制代次的写入确认后激活 transport。带面由接触机制驱动物料，任务只跟踪指定主体。
2. transport 的本次请求接受、实际主体到出口、契约完成检查全部成立后成功。资源管理器释放跟踪任务许可，物料仍由传送带持有；到出口不意味着下游已接收。
3. feed 子节点结束后写 runTag=false，等待实际 surface_stopped 和本次退出写入确认。确认前作用域不成功、不释放 writer，也不启动机械臂。零速度命令和实际停稳是两个事实。
4. still_at_exit 读取最新有效、匹配 material 和 transport 请求的出口观测。减速后若物料越过区域，不会沿用先前成功结果；2 s 内未满足则停止整个工艺。提供者必须能为已完成跟踪请求关联的主体重新采样，不能把旧完成事件重新打上新时间戳。
5. transfer 一次性申请 robot_motion、material_claim、target_slot、transfer_zone，授权后复核源物料、夹具、载位和版本。受控停止后的 conveyor_command 已退出，禁止其他写入者在机器人取料期间重启带面：这一跨设备互锁由 transfer 的持续条件/授权服务维护，不能仅凭之前的 await。
6. composite 在同一请求上下文内进行两次交接。先将 conveyor_owned 变为 gripper_owned，保留目标载位预留；实际放置、夹具释放和载位服务确认后，原子提交 tray_slot_owned，将预留转换为占用。没有第二个外部 execute_job 请求。
7. transfer 只有实际交接和夹具释放证据满足才成功。verify_loaded 再由 handoff 服务核验本请求/本物料/本载位。独立监测器还需直接核对物理支承和容量，不能只相信同一 done。
8. 根成功后确认无活动请求、控制已退出、执行许可已清理；tray 的实际占用保留。保持物料在托盘上，不恢复预览初态。

第 5 步的互锁是本示例所需但未实现的服务能力：资源管理器应将机器人取料区域占用与输送许可互斥，或由同一提供者实施等效互锁。既不能把停止过一次当成永久停止，也不能在控制作用域退出后失去对其他控制源的约束。环境中此关系以 transfer_zone 与 conveyor_command 的冲突表声明。

## 4 期望事件顺序

下表是协议验收的偏序要求，未运行仿真，不含虚构的测量时长。a、b 等为实际事件 tick；后继最早下一 tick 提交，组合自身转换也占 tick。

| 顺序 | 事件与证据 | 必须保持的不变量 |
| --- | --- | --- |
| a | feed writer grant、enter write、ack | 无第二 writer |
| b > a | transport request/accept | 参数身份为 subjects[workpiece_1]=1 |
| c >= b | 实际出口观测、transport result | 结果关联已接受请求；holder 仍是 conveyor |
| d > c | feed exit write；随后实际 stopped | 未停稳不得激活抓放 |
| e > d | still_at_exit 成功，transfer grant/request/accept | target_slot 只预留一次；占用尚未增加 |
| f > e | conveyor→gripper 交接提交 | 物料唯一 holder；槽位仍是预留 |
| g > f | gripper→tray 交接提交 | 预留减 1，占用加 1；夹具不再持有 |
| h >= g | transfer result、verify_loaded 与根成功 | 最终目标真实成立；许可清理不删除槽位占用 |

## 5 故障与边界

| 注入 | 预期结果 |
| --- | --- |
| 启动时初始 Idle=true / 残留 done=true | 没有本次接受证据，不推进 transport |
| 出口事实未知或过期 | await 等待；到期报告条件未知，不抓取 |
| 减速过程中掉落或离开出口 | feed 仍需确认停止；后续物料条件失败，保留实际归属/隔离 |
| 另一个任务抢同一物料/载位/区域 | 集中仲裁只授予一方；另一方等待至 gate deadline |
| 其他控制源试图在取料期间重启输送带 | 冲突互锁拒绝授权；若违反，持续条件触发受控停止并报告故障 |
| 接受回复丢失、设备可能已经移动 | 不新建请求重试；进入停止/查询，不能释放物料 |
| grip 后失败 | 保留 gripper_owned 与相关隔离；不能把物料逻辑归还传送带 |
| 放置完成反馈迟到 | 原请求未终态时可按证据核验；终态后记录迟到/矛盾，不重复装载 |
| stop 超时 | 保持 stopping＋attention_required，无虚假的 cancelled 与资源空闲 |
| 暂停/恢复 | 同一 request_id、同一物料/预留，继续原阶段，不重新 grip |
| 动画走完但物料没落槽 | transfer 不成功，独立监测器发现实际结果不符 |
| 契约/登记表/场景变更 | 旧绑定及验证失效，启动前重新检查 |

## 6 并行、分支与重复如何扩展

生产示例只用当前任务必要的组合，不为展示语法并发操作同一物料。参考工具测试包含 seq/par/branch/repeat/await/delay/invoke/with-control/fail 的结构覆盖；以下是扩展规则：

- 第二条独立产线可作为 par 的另一分支。不同设备/物料仍可能共享 transfer_zone，资源管理器按固定顺序排队。任意分支失败后其他在途分支先停止确认，再确定父终态。
- 缺陷分拣使用 branch，所有条件来自同快照；exclusive 多真立即失败，未知不进 else。分支选择不代表目标槽位已授权。
- repeat 适合有限重复的检查或明确可重入动作。本例绑定同一物料和槽位，不能包一层 repeat 便声称处理多件。多件任务需显式枚举不同绑定；动态选择物料是后续类型化服务扩展。

## 7 本地复核

在 `test1/dsl` 运行（Python 3.10+，需要 `jsonschema`）：

```powershell
python tools/check_design.py
python -m unittest discover -s tools -p "test_*.py"
```

有意修改文本后用 `python tools/check_design.py --write` 更新派生 IR 与 source map；默认检查不写文件。工具检查正式输送 DeviceSpec 的参数和事实键，以及本例机器人草稿。它不执行 apps、不生成 BoundProcess、不驱动模型；输出始终明确 `Executable: false`。

接入顺序：正式绑定器与诊断 → 请求/停止网关 → 控制写入与持续监控 → 资源/交接服务 → 机器人真实执行器与场景标定 → 工艺运行器 → 独立监测及故障注入。可并行开发模块，但真实闭环验收必须满足全部依赖。PLC 后端不在本轮设计实现范围内。
