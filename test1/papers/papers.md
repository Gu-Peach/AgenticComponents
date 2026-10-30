下面是截至 2026 年 10 月 检索到、与你的研究方向较相关的代表性工作。我将传统模型驱动方法和 AI 方法放在一起比较。

1．先读一篇综述，建立研究分类

Koziolek 等，2020，Journal of Systems and Software：
A classification framework for automated control code generation in industrial automation

论文分析了 13 类控制代码生成方法，主要分成：

- 基于设备／工厂结构和规则的生成。
- 基于高级行为模型的生成。
- 结合工厂结构与高级行为模型的生成。
  它比较各方法需要什么输入、如何转换、输出什么控制程序，也讨论了模型与手写代码同步、迭代修改和工程验证等问题。

**对你的价值：**适合作为论文相关工作章节的分类依据。你的方法一可以定位在“设备结构与行为契约支持的模型驱动生成”，而不是笼统地归入“AI 写 PLC”。

2．GRAFCET 形式化建模与控制代码生成

Schumacher、Fay，2014，Control Engineering Practice：
Formal representation of GRAFCET to automatically generate control code

**输入：**已经明确的 GRAFCET 工艺模型，包括步骤、转换条件、动作、层次结构和时间约束。

**方案：**先为 GRAFCET 建立形式化的结构和动态语义，再通过模型转换生成控制代码。其重点包括嵌套步骤、强制控制和时间相关行为，而不只是将步骤图机械翻译成 CASE Step。

**对你的价值：**很适合作为方法一的基础路线。你的行为、前置条件和完成条件，可以进入具有明确状态转换语义的工艺中间表示，再生成 ST。

**局限：**工艺顺序需要事先建模；它不负责根据三维布局推断用户想完成什么任务。

3．从设备模型和约束中合成监督控制器

Reijnen 等，2017，IEEE CCTA：
Supervisory control synthesis for a waterway lock

**输入：**未受控设备系统模型，以及需要满足的控制要求。

**方案：**通过监督控制综合，计算哪些设备动作在当前状态下允许发生，再将得到的监督控制器转换为 PLC Structured Text。论文展示了从建模、综合、验证到 PLC 实现的完整工程流程。作者机构论文页面

**对你的价值：**它提供了一条比模板展开更强的路线：根据设备状态机和互锁约束，自动求解控制许可。

例如，可以把这些条件形式化：

- 机械臂占用交接区时，输送带不能进入该区域。
- 升降台未到位时，不允许接收物料。
- 同一独占资源不能被两个动作同时持有。
  **局限：**需要准确的设备状态模型和要求模型，建模及状态空间处理成本较高。监督控制器保证允许行为，也不直接等同于吞吐量最优的派工器。

4．CAYENNE：设备拓扑模式驱动的规则生成

Koziolek 等，2020，ICSE-SEIP：
Rule-based Code Generation in Industrial Automation: Four Large-scale Case Studies applying the CAYENNE Method

**输入：**P&ID 等工程资料形成的设备拓扑模型，以及可复用代码生成规则。

**方案：**规则引擎遍历拓扑，识别设备、连接和仪表的特定组合，并生成对应控制逻辑。论文在四个大型工业案例中进行了验证，报告可利用跨工厂复用的规则生成超过 70% 的所需互锁逻辑。会议官方介绍

**对你的价值：**这篇与你的“设备接口＋场景拓扑＋契约”十分接近。可以借鉴：
识别设备组合与接口关系 → 匹配控制模式 → 实例化变量、互锁和功能块。

**局限：**主要研究过程工业中的拓扑与互锁生成。迁移到机械臂、托盘和输送系统时，需要建立自己的动作与物料交接模式库。

5．GRAFCET 与代数综合结合生成 ST

Roisin 等，2025，ICINCO：
From Algebraic Synthesis and GRAFCET to Logical Controller Design in ST Code (IEC 61131-3)

**输入：**GRAFCET 行为模型和规则／约束形式的控制要求。

**方案：**将显式步骤建模与代数综合结合，用 GReSTIC 支持代码生成和仿真，用 BooG 进行代数综合及结果融合，最终生成 ST。

**对你的价值：**可以参考其“流程描述＋约束求解”的组合思想。工艺图决定正常执行路径，约束层补充动作许可和互锁。

**局限：**论文展示了案例验证；你的研究仍需针对异构设备契约、交接协议和异常恢复设计自己的表示及转换方法。

6．LLM4PLC：生成、编译和形式化验证的反馈循环

Fakih 等，2024，ICSE-SEIP：
LLM4PLC: Harnessing Large Language Models for Verifiable Programming of PLCs in Industrial Control Systems

**输入：**自然语言控制需求，以及用户反馈。

**方案：**让 LLM 生成控制设计与 ST 程序，再引入语法检查、编译器和 SMV 验证器；错误反馈给模型进行迭代修复，并研究提示工程及 LoRA 微调。

**对你的价值：**适合参考“生成—验证—修复”闭环，也可以作为 AI 生成方法的比较对象。

**局限：**它不是基于你这类统一 DeviceSpec 契约的确定性编译。验证效果取决于需求如何转换为性质，以及验证模型是否忠实反映程序行为。

7．Agents4PLC：检索、规划、编码、调试与验证的多智能体协作

Liu 等，2024 年预印本：
Agents4PLC: Automating Closed-loop PLC Code Generation and Verification in Industrial Control Systems using LLM-based Agents

**输入：**ST 编程需求及检索到的相关资料。

**方案：**检索智能体提供知识，规划智能体提出实现计划，编码智能体生成 ST，再通过编译和验证发现问题，交给调试智能体指导修复；必要时更换计划。方法全文

**对你的价值：**可用于设计方法二中的角色分工，以及诊断反馈如何返回规划阶段。

**局限：**多个 Agent 的分工本身不保证工程正确。仍需明确接口绑定、扫描周期语义和外部验证判据，也不能将其“闭环”直接理解成完整三维产线的物理闭环。

8．AutoPLC：检索案例与 API 后生成目标平台 ST

Yang 等，2024 年首次提交、2025 年修订：
AutoPLC: Generating Vendor-Aware Structured Text for Programmable Logic Controllers

**输入：**自然语言需求、I/O 定义、程序单元类型及目标平台。

**方案：**建立需求—计划—代码案例库与 API 库，经过规划、案例检索、API 推荐，再利用编译反馈生成和修复代码。过程控制任务的规划会识别状态及转换关系。方法全文

**对你的价值：**其“先识别所需能力，再匹配接口和实现”的思想值得借鉴。你的 DeviceSpec 可以成为能力和接口知识的结构化来源。

**局限：**重点是目标平台语法和库使用。你的 test1 更适合先选择固定的 ST 子集与自定义设备功能块库，把变量和调用的生成过程固定下来。

9．Spec2Control：从工艺叙述生成函数块组合

Koziolek 等，2025 年预印本、2026 年 ICSE-SEIP 工作：
Spec2Control: Automating PLC/DCS Control-Logic Engineering from Natural Language Requirements with LLMs — A Multi-Plant Evaluation

**输入：**自然语言控制说明、函数块库、控制策略及已有工程逻辑。

**方案：**分块读取控制说明，识别所需函数块与控制策略，生成实例、连接、参数、互锁及报警。LLM 输出简化的 FBD 表示，再由确定性程序转换和布局；论文主要研究 FBD，而非直接生成整份 ST。方法全文

**对你的价值：**它与你之前确定的架构很契合：
Agent 生成结构化控制方案 → 确定性工具生成最终工程产物。

**局限：**该工作主要依靠文本控制说明，不能据此认为它已经解决三维场景理解和搬运工艺路径规划。

10．SemaPLC：以当前工程和有效验证证据作为交付条件

Tu 等，2026 年预印本，当前 v2 修订于 10 月 26 日：
SemaPLC: A Project-Grounded, Verification-Gated Agent Harness for PLC Code Generation

**输入：**需求，以及现有工程中的声明、函数块接口、入口约定等上下文。

**方案：**结合可复用 PLC 技能、规范审查、集成编译和实际运行检查；失败触发有限次数修复。一个关键机制是：源码改变后，之前的验证结论失效，交付结果必须对应当前版本。

论文分别评估了独立 POU 与现有工程集成两类任务。方法与评估定义

**对你的价值：**适合直接参考 test1 的生成验收机制：将设备契约、工艺、生成代码及检查记录绑定到同一版本。

**局限：**它是智能体执行与验证框架，不能代替你的设备契约和工艺编译器。其论文定义的 verified-pass 也不代表所有性质均得到证明。

11．PLCWorld：在设备与物料闭环中评价生成代码

Kim 等，2026 年预印本：
PLCWorld: Benchmarking LLM-Generated PLC Programs in Closed-Loop Plant Simulation

**输入：**生成的 ST 程序、规定 I/O、任务要求和仿真场景。

**方案：**把 ST 执行、设备响应与传感器反馈连接起来，观察程序的命令是否真正导致正确的设备和物料状态，并评价任务完成与安全约束。论文全文

**对你的价值：**它尤其适合参考实验设计。对于你的输送、抓放和仓储场景，应评价“物料是否到达目标、交接是否完成、容量是否超限”，而不只是“代码是否可编译”。

**局限：**它主要贡献评测环境和方法，不是从设备建模到 PLC 合成的完整解决方案。
