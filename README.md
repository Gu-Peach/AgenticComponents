<p align="center"><img src="apps/public/assets/agentic-mark.svg" width="72" height="72" alt="Agentic Components 标识" /></p>

# Agentic Components

面向异构工业设备的建模、工艺规划与仿真实验工作台。项目通过结构化设备契约，将三维资产与设备能力、信号接口及执行条件关联起来，逐步形成从设备建模、场景搭建到工艺生成和运行时调度的开发环境。

## 开发目标

- **建立可复用的设备模型**：统一描述设备基础参数、几何节点、接口、行为、前置条件和完成依据，为契约驱动的 PLC 合成提供输入。
- **连接场景理解与工艺规划**：后续引入专家智能体，基于空间布局、设备能力与工艺目标规划流程，并调用契约编译器生成 PLC。
- **支持运行时调度研究**：后续汇集设备内部状态、物理/感知状态与外部控制状态，在资源与时序约束下开展规则、优化和学习型派工实验。

## 应用场景

设备供应方或开发者可以在工作台中导入 GLB、完善 DeviceSpec，检查参数和节点绑定，并通过统一预览接口接入设备动作。场景设计者可以搭建搬运、输送、分拣和仓储工作站，维护现场资产及接口映射。研究与教学场景可将其作为设备契约、智能体工艺规划、PLC 生成和调度方法的可视化实验载体。

## 当前实现

当前以浏览器前端为主，提供现场 BOM、R3F 三维视口、设备明细、资产目录、PLC 文本面板和应用终端；支持八类设备模板、DeviceSpec/GLB 导入、参数校验、实例位姿编辑和浏览器本地保存。

动作预览的生命周期与动画适配接口已建立，当前注册的是显式 Mock 演示执行器。真实 IK、物料输送/抓放、PLC 执行、智能体规划及调度算法需要后续接入。

## 界面预览

![Agentic Components 工作台](apps/public/assets/image.png)

界面截图：[apps/public/assets/image.png](apps/public/assets/image.png)。项目标识为自绘 AC 字母与连接节点，源文件位于 [agentic-mark.svg](apps/public/assets/agentic-mark.svg)。

## 快速启动

```powershell
cd apps
npm ci
npm run dev
```

打开 http://127.0.0.1:3000 。需要 Node.js 22 LTS 或更新的受支持版本。依赖已安装时直接运行 npm run dev。

技术栈：Next.js App Router、React、TypeScript、React Three Fiber / three.js、Zustand、Zod；测试使用 Vitest 与 Playwright。

## 目录与开发入口

| 位置                                     | 内容                                     |
| ---------------------------------------- | ---------------------------------------- |
| [apps/](apps/README.md)                  | 前端工作台、启动/检查命令及功能说明      |
| [test1/docs/](test1/docs/)               | 设备接口与行为规范、参数契约和建模样例   |
| [前端开发计划](apps/doc/前端开发计划.md) | 界面、模块、契约及实施阶段设计           |
| [动画接入指南](apps/doc/动画接入指南.md) | 执行器注册、节点变换、运行观测与完成条件 |

项目数据 JSON 与设备模型分别管理；浏览器保存包含本地导入模型，JSON 导出仅包含项目数据与资源引用。具体使用方式见 [前端 README](apps/README.md)。
