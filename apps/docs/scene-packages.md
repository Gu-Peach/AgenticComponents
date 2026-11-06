# 场景包开发入口

`public/scene/index.json`是生成目录。每个Sxx包由scene.json、process.py、device/*.json、task-spec.json和原始整场GLB组成。工艺为受限声明式数据，不执行Python源码。

```powershell
npm run catalog:scenes
python -B -m unittest discover -s scripts/tests -p test_scene_compiler.py
npm test
npm run typecheck
npm run lint
npm run build
```

构建脚本需要Python 3.10及以上，仅使用标准库。predev/prebuild会重建模型和场景目录；修改process或device之后也可单独执行catalog:scenes。浏览器会检查bundle、模型和输入文件哈希，过期IR不能静默运行。

首次迁移可使用scripts/build-scene-catalog.py的--migrate-from与--contracts参数；已有scene.json时不会覆盖包的作者输入。正常构建不读取batch.json/bindings.json。production声明有限订单/托盘，device保存契约、实例参数、位置、初始装载、配方与待标定信息。

应用资产库选择“场景”后可导入整场GLB和设备声明，模型资源由工程持久化保存，多次导入使用不同场景实例ID。BOM选择场景后PLC面板显示契约接口和调用列表；当前数值全部未知，未生成实际PLC接线。

当前node_binding均为unresolved，所有scene bundle保持executable=false。待实现项包括真实节点和关节/TCP/碰撞标定、完整工艺调度、设备适配器接入统一世界、运行信号快照以及控制/信号拓扑。不能通过手改executable或填入假信号解除阻塞。

SceneWorldStepper仅提供固定tick的阶段所有权和停止确认基础，尚未接管RuntimeKernel。它的单元测试驱动桩只验证调度阶段，不是十二场景物理运行证据。

原有单设备机械臂与输送实验继续走现有RuntimeController，可作为后续场景化回归基线。原始DeviceSpec的signal_ports是信号来源；应用旧DeviceDefinition.interfaces是规范化信号列表的历史字段名，不能与原始空间interfaces混淆。
