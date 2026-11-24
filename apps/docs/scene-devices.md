# 精简的场景设备文件

`public/scene/Sxx/device/*.json`采用`scene-device/0.2`，保存实例信息。共用DeviceSpec放在同一场景的`contracts/`，编译后完整运行数据放在`.generated/scene.bundle.json`。这样单个场景包仍可独立复制，不依赖其它场景目录。

## 设备库与发布来源

设备类型模板统一维护在 `src/devices/<type>/contract.json`，同目录的 `behavior.ts` 和 `index.ts` 分别提供动作实现和实例工厂。[设备目录](../src/devices/catalog.json) 登记十种规范类型、型号组合（`profiles`）与输出路径（`publications`）。场景实例继续保存节点、标定、实际点位和参数覆盖。`public/scene/Sxx/contracts/*.json` 与 `public/modles/<型号>/schema.json` 是可独立导入的发布快照。

修改所有适用型号共用的参数、条件或行为声明时，编辑类型目录的模板。修改型号差异时，按 `catalog.json` 中的 profile 找到其内联 `overrides` 或 `source` 指向的模型包／代表场景 `contract-overrides.json`。后者按 profile 名登记差量。一份 profile 可被多个发布目标使用，继承关系通过 `extends` 指定，`behaviors` 与 `ports` 明列本型号的能力与端口。旧版 `workpiece_carrier` 的发布视图保留原类型与槽位信息，设备库将其映射到物料的承载能力。

覆盖对象递归合并普通字段；标量和普通数组直接替换。用 `$list` 指定以 `behavior_id`、`port_id` 等稳定 ID 合并的数组，`entries` 修改对应条目，`select` 选择并排列需要发布的条目。`$remove` 移除所选型号没有的对象字段，`$order` 保留历史发布的字段顺序。例：给单个机床型号定制默认加工时间，在其 profile 的 `overrides` 写入 `{"params_schema":{"cycle_time_s":{"default":4}}}`。

运行 `npm run catalog:models` 或 `npm run catalog:scenes` 后，包内 `.generated/device-contracts.lock.json` 记录模板修订、实际 profile 链和覆盖来源的语义哈希，以及每份发布快照的字节哈希。既有工作台仍通过原包 URL 和原始快照哈希校验资产。独立复制的旧场景包可直接用其本地契约编译；只有应用公共目录中的已登记路径由设备库生成。

构建同时从所有已展开的型号及类型模板生成 `src/devices/.generated/dispatch-signatures.json`。场景准备时，注册表按设备定义 ID、修订、PLC 类型与方向、载荷、行为参数和条件绑定匹配完整的执行签名。几何、初始位置和实例参数独立解析。同类型新型号可选择已登记的兼容子集；同名新行为和不同的端口签名需要显式登记并接入驱动。

## 请求与结果

设备库的有限动作在接受前冻结请求身份和载荷，接单后通过非重复请求号驱动一次任务。公共动作适配器读取上一扫描的启动电平：启动保持期间 `accepted` 为真，撤销后清除。运动保持期间，只要原任务仍在执行，`busy` 继续为真。`done` 与 `result_id` 对应同一终态，保留至下一个请求被接受；尚未有终态时结果号为 0。世界停止或取消不会为尚未完成的加工、定位或交接制造成功回执。

错误通过该型号已声明的反馈端口发布，通用故障码为 1，正常为 0，专用执行器可提供自己的码值。仅当型号存在 `reset`、故障原因已由设备确认解除、驱动和载荷均允许恢复时才接受新的复位请求。旧 S06 机床和 S11 人物的发布快照未提供完整的 `reset/error_code` 引脚，原有调用继续使用其受限反馈。已经终止的工艺会话需重新准备。

## 编辑位置

| 内容 | 位置 |
| --- | --- |
| 行为、前置/持续/结束条件、信号、参数类型/范围/默认值 | `src/devices/<type>/contract.json` 与所选型号的差量覆盖 |
| 实例ID、节点选择、非默认参数值、特定模型配置 | `device/<id>.json` |
| GLB节点路径、测量矩阵、参数来源等证据 | `evidence/` |
| 节点索引、静止位姿、合并后的参数、端口命名空间和有限批次实例 | 编译器生成，不在device重复手写 |

设备的`contract_ref`是相对引用。例如R1使用`../contracts/robot_arm.json`，R2引用同一份定义。实例`parameters`只写与默认值不同的覆盖，不出现的参数仍从共享契约继承，并未丢失。

当前机械臂位置IK/关节点到点配置使用与单设备UR10相同的八项参数名：joint_speed_rad_s、joint_accel_rad_s2、settle_speed_rad_s、ik_position_tolerance_m、ik_max_iterations、ik_mode、max_payload_kg、lift_height。未实现的笛卡尔路径速度和姿态误差参数不混入此配置。

R1/R2的关节只保存节点名、轴及限位。静止位置、静止四元数、渲染静止四元数、父关节关系由GLB层级生成，格式与运动学读取器所需结构对应。轴或限位为null表示待标定，编译器不会补一个“看起来合理”的数值。

## 构建与校验

```powershell
npm run catalog:scenes
python -B -m unittest discover -s scripts/tests -p "test_*.py"
npm test
npm run typecheck
```

编译器读取当前共享契约，记录全部输入文件哈希。编辑类型模板或型号覆盖后重新构建即可；浏览器导入时会检查实际源文件与编译产物的哈希，过期包会被拒绝。节点绑定仍记录GLB哈希，模型变化需要重新核对绑定。

校验包括引用路径不能越出场景包、节点名唯一、几何属于对应设备、关节链遵循GLB层级、参数类型与范围、行为参数及单位、预制体身份和独立验收数量。S01的三盘各十二件仍由一份托盘和一份物料声明展开，运行信号身份分别生成。

精简文件不表示物理执行已经标定。待验证模型继续保留pending状态，未知轴/限位、制动距离与接触验证仍形成运行阻塞。

原0.1格式的完整文件可通过`scripts/compact-scene-devices.py --root <scene-root> --backup <outside-backup>`迁移；原文件备份必须位于public场景目录之外。正常构建只读取0.2格式，不会每次迁移或回写设备声明。
