# 002 Model transforms and interface snapping

日期：2026-10-29。阶段：已实现并验证。

## 目标和交互

选中模型后显示移动/旋转手柄，拖动坐标轴操作设备，拖动期间禁用相机轨道操作。工具栏切换移动、旋转、接口吸附；邻近兼容接口时提示候选，松开提交吸附后的位姿。Esc、窗口失焦、选择切换或场景失效时取消未提交拖动。预览运行期间不能编辑设备。

拖动中的位姿与候选属于交互状态，不每帧写入项目。一次拖动只在松开时提交一次文档更新；右侧坐标展示提交值。工具栏“对齐”对邻近候选执行相同的吸附计算，可用于精确坐标调整后的确认。

## 模块边界

- domain/spatial/transforms.ts：可复用的矩阵、接口朝向及缩放检查；无 DOM、React、store 副作用。
- domain/spatial/snap.ts：纯函数求解候选、距离/朝向/角色/占用检查及设备位姿。使用 three 的数学类型，不依赖 WebGL 或 Object3D 场景。
- stores/interaction.ts：工具模式、拖动预览、候选和吸附开关，不序列化到项目。
- renderer/DeviceTransformControls.tsx：Drei 手柄、相机互斥、取消与提交生命周期。
- editor/transformActions.ts：提交前检查文档版本和预览锁，再写入位姿与连接。

计算部分适合作为工具，但采用有职责名称的 domain/spatial 模块，不把整个拖动流程放进通用 utils。交互由编辑器管理，渲染器只负责呈现。

## 吸附规则

接口坐标应用模型导入变换和设备实例变换各一次。首期只支持均匀正缩放；非均匀缩放不参与自动吸附，以免旋转补偿产生剪切。已声明位置/朝向的接口可参与，pending 或无法解析的接口跳过。

候选需满足双方 snap.accepts/role 相容、目标可见、不是同一实例、目标接口未被其他连接占用，端点世界距离不超过 0.15 m、朝向修正不超过 30°。阈值是编辑器交互配置，不是设备参数或物理安全距离。求解后位置重合，forward 相对，up 对齐；按距离和稳定身份排序。

连接保存在项目可选 connections 数组中，端点引用 instanceId/interfaceId。旧项目没有该字段仍可读取。移动、旋转或删除某设备后解除其相关连接；重新吸附建立新连接。不自动带动相邻设备，也不生成刚体约束、PLC 接线或物料交接许可。吸附是空间编排，不证明设备碰撞已排除。

## 变更文件

新增 domain/spatial/transforms.ts、domain/spatial/snap.ts、stores/interaction.ts、editor/transformActions.ts、renderer/DeviceTransformControls.tsx、features/workspace/TransformToolbar.tsx、tests/snap.test.ts 及本轮浏览器测试。

修改 renderer/SceneCanvas.tsx、features/workspace/WorkspaceClient.tsx、contracts/device.ts、validation/contracts.ts、stores/workspace.ts、commands/workspaceCommands.ts 和全局样式。schema 中既有端点坐标和纯空间能力保持有效，不添加信号绑定。

## 验收

验证手柄移动/旋转、相机不抢占、Esc 取消、拖动中项目不写入和一次提交；两个 Conveyor 端点吸附后世界位置误差小于 1e-6 m，方向相对；远端、不兼容、已占用、隐藏、pending 接口不吸附。连接可保存恢复，移动后解除；预览锁和过期项目阻止提交。运行单元测试、类型检查、lint、生产构建和真实浏览器交互测试。

## 实施结论

已实现坐标轴移动、旋转模式、拖动预览、松开提交、Esc/失焦取消、预览运行锁，以及接口吸附开关和邻近接口对齐按钮。吸附计算复用 domain/spatial；交互与文档提交保持独立。

项目新增可选 connections，可保存恢复。删除或改变设备位姿时清理相关连接；当前参数编辑也采用保守的解除连接策略，后续可根据具体几何依赖缩小影响范围。没有把空间连接当作物理刚体约束、信号接线或工艺授权。

验证通过：58 项单元测试、类型检查、lint、生产构建；六个浏览器流程通过（四个既有流程、两台真实 Conveyor 的吸附/导出、真实鼠标坐标轴拖动与 Esc 取消）。截图：test-results/model-snapping.png 和 test-results/model-transform-drag.png。

首期不支持非均匀缩放自动吸附，不自动排除整机碰撞，不带动已连接的邻机一起移动；移动后需要重新对齐。相机在手柄拖动时禁用，松开或取消后恢复。右侧数值显示已提交位姿，拖动中的变化只在视口预览。
