# 工艺语言 0.1：语法与语义

本文固定 `ac-process/0.1` 的文本和行为含义，完整文法见 [language.ebnf](language.ebnf)。[README](README.md) 保留架构与研究要求；本页及 [IR 规范](02-ir.md) 将其中的拟议结构具体化。这是项目自定义语言，不是 ST、Lisp 的通用解释器或 IEC 标准实现。

## 1 范围与输入

一个文件定义一个有限工艺。关键字为 `process/environment/profile/conditions/condition/body/seq/par/branch/case/else/repeat/await/delay/invoke/args/policy/timeout/with-control/fail/is/all/any/not/parameter/observation/authorization/subject/slot/request/binding/index/q/ordered/exclusive/s/ms`。保留字不能作未加引号的 ID。显示名和外部 ID 使用字符串，不猜测名称。

源文件引用一个本地环境清单，清单绑定场景、设备定义、身份登记表、控制配置和超时策略。文件相对路径以工艺文件目录解析；导入器只允许项目目录内的文件，禁止网络导入、绝对路径和逃逸。图形编辑器直接产生同样的 ProcessIR，不把图形布局编码成控制依赖。

首期提供九种节点：seq、par、branch、repeat、await、delay、invoke、with-control、fail。不提供任意赋值、goto、递归、无界循环、自动重试、异常后继续生产或用户脚本。`on_failure` 固定为停止整个工艺；未来恢复子图必须升级语言版本，不能把恢复行为藏在字符串里。

## 2 词法与类型

UTF-8，允许文件头 BOM；换行接受 LF/CRLF。空格、制表符、换行分隔 token。`;` 注释至行末；字符串内的分号不是注释。括号为语法标点。字符串采用 JSON 双引号和转义规则，不允许未转义换行、控制字符和孤立代理项。无 quote、宏、点对或插值。

标识符为 `[A-Za-z_][A-Za-z0-9_-]*`，区分大小写。数字采用 JSON 数字词法，禁止 NaN/Infinity、十六进制、前导加号和前导零。整数 token 没有小数点或指数，范围为有符号 32 位；`1.0` 不隐式成为整数。实数采用有限 binary64；溢出和非零下溢为零报错。数值零规范化为正零。字符串逐码点相等，不做大小写、Unicode 或空白归一化。

| 类型 | 表达式 | 检查 |
| --- | --- | --- |
| boolean / integer / number / string | `true`、`3`、`0.2`、`"A"` | 精确类型；允许 integer 显式适配到无量纲 number，必须记录适配 |
| quantity | `(q 0.2 "m/s")` | 数值有限、单位严格相同；0 也必须带单位 |
| 名义引用 | `(binding material)` | 环境指定 device/material/slot 等类型与存在性；不同类型不互换 |
| 登记表索引 | `(index subjects material)` | material 的名义类型与登记表键类型一致；取得唯一正 DINT |

本版没有算术、数组、可变集合、null、结构字面量或动态对象创建；因此无除零、下标访问及空集合求值。需要 Pose/集合的能力在绑定时拒绝，不能将 JSON 字符串当成结构。后续 Pose 必须规定 frame、m、四元数顺序及变换来源。不存在的 ID 不是空值。绑定是 run 启动时冻结的常量，不会“自动选择下一件物料”；repeat 重用同一绑定，业务上取下一件应生成明确的新节点/新绑定或升级语言。

设备参数遵循 [参数契约](../docs/参数契约.md)：合法默认值 → 实例覆盖 → 条件必填/跨字段校验。动作 arguments 仅按该行为的 arguments_schema 解析，不自动用同名设备参数填充。未知参数、重复参数、越界、单位错误均报错。`stopped_only` 描述作者参数修改许可，不意味着同一行为每次调用不得有不同目标。

身份登记表是后端边界。现有 Conveyor_aankws `transport_to_exit` 接收 `subject_id: integer`，因此使用 `(index subjects material)`；不能传 `material_id: string`。映射以 registry ID＋版本＋内容哈希锁定，正数范围 1..2147483647，0 保留无主体；一轮运行不能重排或复用索引。

## 3 条件

`(is (observation conveyor "subject_at_exit" (subject material)) true)` 是类型化相等判断。read 的 owner 是环境中的设备/服务别名；key 必须登记在相应 runtime_contract 或场景服务契约。`parameter` 只读已解析作者参数；`authorization` 只读授权服务，不能由工艺写 true。单个 read 可按 subject、slot、request 顺序附加关联限制；重复限定、来源不支持的限定和错误类型均拒绝。

`(request transfer)` 表示本次激活路径上 transfer 节点唯一的已接受请求。同一 repeat 的当前轮次与祖先路径用于解析；不能跨不确定的分支、引用未来请求或沿用上一轮的结果。条件声明可以预先定义，但每个使用点必须做支配和作用域检查。`await` 中引用自身尚未创建的请求非法。设备契约里的本请求条件由绑定器注入当前请求上下文，不要求工艺重复声明。

事实携带 provider_epoch、revision、sample_tick、valid，以及契约要求的 subject/slot/request 身份。提供者未就绪、缺值、类型错误、过期、来源代次或关联不匹配均为 U（未知），同时记录原因。新鲜度以环境的 max_age_ticks 为上限，`0 <= current_tick-sample_tick <= max_age_ticks` 才有效；未来样本无效。默认值不能充当有效事实。参数不按时钟过期，但随参数修订失效。

| 表达式 | T | F | U |
| --- | --- | --- | --- |
| not x | F | T | U |
| all xs | 全 T 才 T | 存在 F 即 F | 其他为 U |
| any xs | 存在 T 即 T | 全 F 才 F | 其他为 U |

all/any 至少一个子式；空组合拒绝。只有 T 通过门控。所有子式逻辑上读取同一快照，短路优化不能改变诊断或快照身份。类型错误在静态期报错；运行中提供者违反类型产生 U 并报告协议故障。

## 4 节点语义

| 节点 | 正常推进 | 失败、取消与边界 |
| --- | --- | --- |
| seq | 按源顺序，一个成功后激活下一个 | 首个失败停止其余；至少一个子节点 |
| par | 所有子节点进入候选集合；全部成功才成功 | 至少两支；失败关闭新提交，取消在途分支，等待停止/清理；不回滚已完成交接 |
| branch ordered | 同一快照按 case 顺序取首个 T | 更早 case 为 U 时等待；全部 F 取 else |
| branch exclusive | 所有 case 已知且恰好一个 T 时选中 | 多个 T 立即 E_BRANCH_CONFLICT；存在 U 则等待；全 F 取 else |
| repeat | 0..10000 次，逐次运行唯一子树 | 0 次成功但不执行子树；每轮重新实例化节点状态和请求身份；不改变静态节点 ID |
| await | 条件为 T 后成功 | F/U 等待至 timeout，分别记录最后条件状态；不拥有动作资源 |
| delay | 激活后经过指定仿真时长 | 不等待设备；0 时长仍占一次逻辑步转换 |
| invoke | 调用已绑定、schedulable 的 action/composite/service | preconditions、资源授权、接受、完成和停止分别处理；continuous 行为拒绝 |
| with-control | 获得控制写入许可，提交 enter 设定并确认后运行子树；退出写 exit 设定并确认 | 所有退出路径都清理；不能以父失败/取消跳过退出；失败时不恢复先前“运行=true” |
| fail | 产生指定业务错误码 | 没有动作副作用；也触发祖先控制作用域退出 |

branch 必须有一个 else 和正的 timeout；作出选择后不反悔、不多支并发。选中分支失败不会改选 else。条件选择超时属于工艺失败。fail 的 code 是非空字符串，不能伪装为设备故障码。

with-control 的控制配置必须明确唯一输入写入者、原子 enter/exit 写集合、进入确认、持续条件、退出确认及资源集合。不同控制配置写同一输入，或 invoke 与父作用域竞争同一排他资源，应静态拒绝。允许继承父授权的动作必须由契约声明兼容 delegation，不能在运行中自锁。停止确认只要求实际停止和清理事实，不得复用已经失效的运行前置条件，防止“许可失效导致不能停止”。

v0.1 禁止资源跨越显式 invoke 节点隐式延长持有。抓放的预留、取料、放置与 confirm_load 由一个 composite 请求的子操作完成，并共享 task/request 上下文；若要用户可编辑的跨节点事务，必须增加事务作用域后再开放。工艺不能先 reserve 再期待一个无关请求自动继承该预留。

## 5 时钟与确定性

执行配置 fixed_60hz_v1 使用有理步长 1/60 s；以整数 tick 计时。所有 duration 写成 `N s` 或 `N ms`，N 为非负有限十进制；词法十进制作为有理数精确换算，编译为 ceil(duration/step)。超时必须 >0；delay 可为 0；上限 86400 s。禁止用浮点累加时间决定超时。

每个 tick 分阶段：①冻结上一物理步的事实和反馈；②按提交序号归并反馈、终态证据；③检查持续条件、取消和超时；④计算候选；⑤集中仲裁并复核 read-set 的 revision/epoch；⑥提交请求/控制写入；⑦推进设备和物理，发布下一 tick 的事实。初始 tick=0 没有默认成功证据。

一次激活最早在下一个 tick 转换；某 tick 的成功新激活的后继最早下一 tick 提交，组合节点同样遵守。初始根在 tick=0 激活，最早 tick=1 推进。每步最多 1024 次节点转换；超出则停止新提交并进入工艺停止，记录 E_STEP_BUDGET，不能无限留在当前 tick。节点上限 10000，树深度上限 64；repeat 不展开成无界树。

并发顺序由 `(eligible_tick, node_id 的 ASCII 顺序, iteration_path 的数字字典序)` 决定。全资源集合一次性获得；无法全部满足不部分持有。允许其他无冲突请求推进，因此不承诺严格排队无饥饿；gate 超时提供有界等待诊断。事件用 tick、phase、单调 sequence 排序，随机过程须固定种子并记录外部输入。

deadline=开始 tick＋编译后的 timeout_ticks。deadline tick 内的有效完成/接受反馈先于相应超时处理；但持续条件失败与成功同时到达时，持续条件故障优先，不能发布成功。非法矛盾终态进入协议故障。全局暂停冻结 tick、时长和物理；单动作暂停冻结执行计时但保留 gate/accept 已完成状态及全部占用。实时设备连接不支持这一时钟假设，必须另建 profile。

## 6 请求与结果

静态 node_id 与 activation_id 分离；后者由 run_id、node_id、iteration_path 唯一确定。本版每次激活最多一个请求，request_id 用不透明字符串；未来 retry 另增 attempt。请求含参数摘要、场景/契约/登记表版本。重发相同身份和摘要返回现状，摘要不同报 E_REQUEST_CONFLICT；超时或重连不能新建身份猜测重试。

节点状态：pending → waiting_conditions → waiting_resources → requesting → running → succeeded；取消/异常进入 stopping，暂停使用 paused；确认停止与清理后才 cancelled/failed。waiting_conditions 和 waiting_resources 共用 gate 截止点，条件抖动不重置；accept 从首次提交起，execute 从已观察接受起，stop 从首个停止请求起。

requesting 也可能已产生物理副作用。超时不代表未执行；应发送幂等停止/查询，保持隔离，禁止重复生产。接受与结果同一快照到达时必须有同 ID 的接受证据，先建立关联再核验结果。残留 done、初始 idle、progress=1 和计时结束均不构成成功。

| 情况 | 处理 |
| --- | --- |
| 接受前条件变 F/U | 尚未发送则撤销未生效许可并重排；已提交则进入停止确认 |
| 持续条件 F/U | 按契约受控停止/保持；无对应策略时绑定失败 |
| 取消尚未提交 | 可撤销预留，记录 cancelled；不声称设备曾接受 |
| 取消在途/父 par 失败 | 请求停止；等物料、控制与资源清理证据 |
| stop 超时/断线结果未知 | 保持 stopping，run 标记 attention_required；隔离资源，等待人工核对，不产生虚假终态 |
| 已接受动作报告失败 | 记录失败候选；停止和清理后节点终态 failed |
| 迟到/重复反馈 | 按请求关联去重；终态后不改写结果，矛盾反馈另记诊断 |

协议终态只记录一次。故障后的物料可能仍在夹具或过渡区；失败结果和资源可释放是两个判据。资源隔离记录可长于 run。进程重启默认禁止恢复生产，先从持久日志、登记表和设备状态对账；没有持久去重时不能声称重启后恰好一次执行。reset 不包含 restart。

## 7 验收边界

语法/类型检查、环境绑定、可执行性、协议运行、物理验收分别报告，不存在笼统的“DSL 已验证”。标准参考只使用公开说明：[IEC 61131-3](https://webstore.iec.ch/en/publication/68533) 区分语言与配置，[PLCopen Motion Control](https://www.plcopen.org/standards/motion-control/) 展示状态机和功能块分层，[CIF](https://eclipse.dev/escet/cif/documentation-single-page.html) 分开建模、验证和实现。本文的三态逻辑、超时、资源策略及请求身份都是本项目选择，未逐条实施上述标准。
