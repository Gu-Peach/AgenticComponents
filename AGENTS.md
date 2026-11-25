# Agentic Components 项目指南

## 项目目标与当前进展

本项目面向数字孪生车间。目标是把自然语言描述的生产需求，结合三维布局、设备能力和工艺约束，转换为可执行的工艺程序，并通过三维仿真验证结果。

| 研究方向 | 当前进展与要解决的问题 |
| --- | --- |
| 异构设备建模与行为 DSL | 第一阶段已基本完成。工作台已有十类设备模板、`ac-declarative/0.4` 工艺语言，以及从工艺编译到物理反馈的执行链。已接入仿真的示例包括 S01、S02、S04、S06、S07、S11。 |
| 设备契约驱动的智能体工艺规划 | 后续重点是结合设备位姿、空间连接、工艺目标和能力，推理可行工步，生成绑定到实际设备与参数的确定性 DSL，并进行校验。场景语义图和工艺路径推理的研究资料见 [test2/docs](test2/docs/)。 |
| 仿真驱动的鲁棒性验证与失效诊断 | 后续要从任务需求和行为契约提取验证属性，构造扰动与边界用例，用执行反例定位失效的工步、设备和约束。现有物理回执与停止记录提供验证依据。研究资料见 [test3/docs](test3/docs/)。 |

## 初次阅读顺序

1. **先读两份公开规范。** [设备契约规范](apps/public/specs/device-contract.md)规定设备如何声明参数、空间接口、信号、行为及前置、持续、完成条件，第 6 节列出十个模板的准确路径。[工艺 DSL 规范](apps/public/specs/dsl.md)说明工艺如何选择设备、传入本次目标、组合顺序或并发工步，以及如何用独立任务书验收。维护工作台时以这两份规范及其链接的当前发布实例为起点。`test1/docs/` 与 `test1/dsl_new/` 用于追溯规范来源和早期语言版本。
2. **再看设备模板与实现。** 从[设备类型目录](apps/src/devices/catalog.json)找到类型。以转台为例，依次看[契约模板](apps/src/devices/rotary_table/contract.json)中的 `rotate_to_station`、[行为脚本](apps/src/devices/rotary_table/behavior.ts)中的分度与到位判定、[工厂入口](apps/src/devices/rotary_table/index.ts)如何创建运动对象和驱动。[设备注册表](apps/src/devices/registry.ts)负责查找类型模块及匹配已发布的行为签名。托盘按拥有承载属性的物料建模。
3. **从一份现有场景理解实例与工艺。** 打开 [S11 场景清单](apps/public/scene/S11/scene.json)，跟随 `devices` 找到[转台实例 T1](apps/public/scene/S11/device/T1.json)，再沿 `contract_ref` 看到[这个型号实际发布的转台契约](apps/public/scene/S11/contracts/rotary_table.json)。在[工艺脚本](apps/public/scene/S11/process.py)中找 `index_to_robot`：每件先由 H1 搬上工装，T1 接受 180° 的绝对目标角，R1 加工并退回，T1 正向转回 0°，再由 H1 搬走。[任务书](apps/public/scene/S11/task-spec.json)独立规定四件物料如何交付、用哪个工具和工件接口核验加工。对照其他工艺可看 [S01 并发分拣](apps/public/scene/S01/process.py)、[S04 双臂交接](apps/public/scene/S04/process.py)和 [S07 轨道升降仓储](apps/public/scene/S07/process.py)。
4. **最后沿同一个工步读执行链。** 跟踪 S11 的 `T1.rotate_to_station(angleTag=quantity(180, '°'))`，查明目标在哪里给出，哪个模块使设备运动，哪条反馈允许下一步开始。

| 执行阶段 | S11 的阅读入口与观察点 |
| --- | --- |
| 发布工艺 | [场景目录构建器](apps/scripts/build-scene-catalog.py)中的 `SceneParser` 和 `build` 将 `process.py` 编译为控制树，展开有限任务，校验实例、动作参数和验收目标，生成场景目录下的 `.generated/scene.bundle.json`。 |
| 准备场景 | [prepareScenePackage](apps/src/services/prepareScenePackage.ts)核对场景包、GLB 和源文件哈希，调用 [compileSceneRuntime](apps/src/domain/runtime/compileSceneRuntime.ts)解析设备、物理几何及 S11 的运行配置。 |
| 绑定动作 | [assembleSceneRuntime](apps/src/runtime/assembly/SceneRuntimeAssembler.ts)匹配行为签名并选择[分度加工装配器](apps/src/runtime/assembly/IndexedProcessingRuntimeAssembler.ts)。查看 `createDriver`、`bindProcess` 和[工装绑定中的 index](apps/src/runtime/assembly/indexedFixtureBindings.ts)，可看到 DSL 角度如何交给转台行为，以及工件固定、人员撤离等互锁如何取证。 |
| 推进与验收 | [SceneRuntimeProgram.advance](apps/src/runtime/engine/SceneRuntimeProgram.ts)在每个仿真步调用[工艺调度器](apps/src/runtime/scheduler/ProcessScheduler.ts)，提交设备请求，推进物理世界，再发布信号与观测。转台以实测角度、停稳和工装持件确认本次分度。[S11 集成测试](apps/tests/assembly/s11-indexed-runtime.test.ts)覆盖四件交付、途中停止，以及将加工位改为 90° 并增加中间工位后的整场回放。 |

## 在哪一层改、如何验证

- 设备共用的参数、信号和行为声明维护在对应类型的 `contract.json`，动作实现维护在同目录的 `behavior.ts`。型号差异由设备目录登记的配置和覆盖文件表达。`public/scene/Sxx/contracts/` 是发布快照，应从源模板或型号覆盖重新生成。
- 模型节点、设备安装关系和实例参数在场景清单及 `device/` 中声明。某一批次的顺序、件数、抓取接口和目标位置写在 `process.py` 及其任务参数中。把实际到位、支承、持件和交付留给设备行为与引擎验证。S07 的原四件任务在第四件遇到带载净空不足时受控停止，这也是按任务验证的结果。
- 在 `apps/` 下工作时同时遵循该目录的 [AGENTS.md](apps/AGENTS.md)。以下命令分别验证 S11 的场景编译和物理回放。第一条将产物写入临时目录，第二条使用项目已安装的依赖。

```powershell
cd apps
python -B scripts/build-scene-catalog.py --scene S11 --output-root "$env:TEMP/ac-s11-onboarding"
npm test -- tests/assembly/s11-indexed-runtime.test.ts
```
