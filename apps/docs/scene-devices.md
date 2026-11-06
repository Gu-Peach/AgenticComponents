# 精简的场景设备文件

`public/scene/Sxx/device/*.json`采用`scene-device/0.2`，保存实例信息。共用DeviceSpec放在同一场景的`contracts/`，编译后完整运行数据放在`.generated/scene.bundle.json`。这样单个场景包仍可独立复制，不依赖其它场景目录。

## 编辑位置

| 内容 | 位置 |
| --- | --- |
| 行为、前置/持续/结束条件、信号、参数类型/范围/默认值 | `contracts/<device_type>.json` |
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

编译器读取当前共享契约，记录全部输入文件哈希。编辑共享契约后重新编译即可；浏览器导入时会检查实际源文件与编译产物的哈希，过期包会被拒绝。节点绑定仍记录GLB哈希，模型变化需要重新核对绑定。

校验包括引用路径不能越出场景包、节点名唯一、几何属于对应设备、关节链遵循GLB层级、参数类型与范围、行为参数及单位、预制体身份和独立验收数量。S01的三盘各十二件仍由一份托盘和一份物料声明展开，运行信号身份分别生成。

精简文件不表示物理执行已经标定。待验证模型继续保留pending状态，未知轴/限位、制动距离与接触验证仍形成运行阻塞。

原0.1格式的完整文件可通过`scripts/compact-scene-devices.py --root <scene-root> --backup <outside-backup>`迁移；原文件备份必须位于public场景目录之外。正常构建只读取0.2格式，不会每次迁移或回写设备声明。
