# 001 公共模型资产、参数明细与接口可视化

日期：2026-10-29  
阶段：本轮功能已实现并完成验证  
目标项目：AgenticComponents/apps

## 1. 本轮目标

“全部资产”同时展示现有八类示意模板与 public/modles 下的真实设备包。真实设备包由 GLB 和 schema.json 组成，选择资产时可在右侧查看定义参数；添加到场景后加载真实模型，点击任意模型子网格选中整个设备，显示高亮、实例参数与已定义的空间接口。

本轮实现资产发现、导入与展示闭环。物理仿真、PLC 执行、自动吸附求解、信号引擎、设备动作执行继续使用已有待接入边界。接口仅用于空间吸附和连接，不恢复 process 或 signal_refs 字段。

## 2. 当前代码与资源依据

- src/domain/catalog.ts 的 createCatalog() 生成八类 template.* 定义，DeviceShape.tsx 提供示意形体。这些是建模模板；动作 MOCK 是另一项预览模式，UI 需要分开命名。
- AssetPanel.tsx 读取 project.definitions。公共文件夹中的模型目前不会自动出现在这里。
- src/renderer/SceneCanvas.tsx 的 ImportedModel 从 IndexedDB 获取 assetId 对应的 Blob；已有 GLTFLoader、设备组选择事件和节点登记。当前选中效果是固定大小地面圆环，尚无完整模型高亮和空间接口标记。
- Inspector.tsx 根据 selectedId 查找实例，展示 paramsSchema 解析后的参数，已有空间接口文字明细；尚不能在只选目录资产、没有场景实例时展示右侧定义信息。
- BrowserProjectRepository.ts 已支持模型 Blob 持久化。associateGlb 已做 GLB 文件头及外部资源检查，需抽出公共校验供目录导入复用。
- scripts/sync-catalog.mjs 只同步参数范式和四份旧 DeviceSpec，不扫描 public/modles。
- public/modles/Conveyor_aankws 已有 Conveyor_aankws.glb、schema.json、README.md。schema 为设备版本 0.4.1 / 契约 1.1，含 11 个参数、21 个设备信号和两个纯空间接口。
- 现有开发文档实际位于 apps/docs；package.json 的格式化脚本仍引用 doc/动画接入指南.md，实施时顺便修正为真实路径，避免检查命令失败。

目录名称沿用用户现有的 modles，不改成 models。

## 3. 资源目录与发现机制

```text
public/modles/
  index.json                       # 扫描生成的公共资产清单
  Conveyor_aankws/
    schema.json
    Conveyor_aankws.glb
    README.md
```

浏览器不能枚举服务器文件系统目录。采用 Node 脚本在启动开发服务/构建前扫描 public/modles 下的设备文件夹并生成 index.json，前端请求清单获取设备列表；本轮不新增运行时文件系统 API。

建议新增 scripts/build-model-catalog.mjs 与 npm run catalog:models，并在 predev/prebuild 执行。开发服务运行期间新增设备包后，先重新运行扫描命令，再通过资产栏“刷新目录”重新读取索引。刷新按钮不承诺从浏览器触发磁盘扫描。

清单条目包含 packageKey、specId、revision、name、deviceType、schemaUrl、modelUrl、schemaSha256、modelSha256。目录路径不作为设备身份；specId/revision 由 schema 决定。条目按稳定规则排序，生成结果可重复。

扫描要求：

1. 每个设备文件夹从 schema.json 找到 asset.model_key，相对该 schema 所在目录解析 GLB；不能假定文件名与文件夹名相同。
2. 模型路径须落在该设备包目录内，禁止越界路径、外部地址和把本地磁盘绝对路径写入清单。
3. 检查必需身份字段、GLB 存在、模型哈希与 schema 声明一致，以及重复 specId/revision。运行时仍需通过 normalizeDeviceSpec 做完整契约校验；扫描结果不代替它。
4. 构建时损坏/冲突的包给出明确文件路径并失败。前端面对网络失败或异常索引应显示错误和重试入口，保留其他可用目录及当前项目。
5. schema 相对路径示例：/modles/Conveyor_aankws/schema.json 对应模型 URL 为 /modles/Conveyor_aankws/Conveyor_aankws.glb。

public/modles 是前端发布资产入口；test1/modles 为建模工作区。此次不以运行时读取 test1 作为备用来源，也不自动覆盖公共目录已有文件。发布副本更新应同步模型与 schema 并重新生成清单。

## 4. 资产栏交互

新增目录加载状态与目录条目存储，不把公共目录初始化直接写进 project.definitions，避免仅打开目录就把当前项目标为修改或悄悄升级其定义。

全部资产合并展示：公共设备、示意模板、项目已导入定义。按稳定目录键去重；已入项目的公共设备显示“已加入项目”。来源用标签区分，类型过滤和搜索沿用现有 UI。大目录只拉取索引与所需 schema，不预加载全部 GLB。

点击真实资产卡片：

- 选择该目录项，加载/校验 schema，并在右侧切换到“资产定义”明细。
- 展示名称、类型、定义版本、模型状态、参数默认值、单位、范围、说明、接口数量。
- 仅浏览定义不创建实例、不修改项目；目录参数只读。

双击卡片或点击“添加到现场”：

1. 校验 schema，解析同目录模型地址并读取模型；复用 GLB 2.0、嵌入资源与大小校验。
2. 校验预期模型哈希，将 Blob 以内容哈希生成的稳定 assetId 保存到现有资产仓库；相同字节可复用。
3. 在一个文档更新中添加所需定义、资产元数据及新实例，自动选中并定位。不能出现只有实例而定义/资源引用缺失的半完成提交。
4. 异步读取期间项目被替换、设备版本变化或进入预览锁定时，放弃迟到的场景提交。重复双击采用 in-flight 保护，完成后用户可继续添加第二实例。
5. 同 specId 同 revision 同内容复用；同 ID 不同版本/内容明确报冲突，不覆盖旧实例使用的定义。本轮不实现多版本定义升级。

下载/校验失败不添加错误实例。已入场模型后续解析失败时显示明确加载错误与可重试入口，不用模板形体冒充真实模型已加载。

## 5. 右侧参数明细与选择状态

用明确的 inspectorTarget 区分 catalog 资产、scene 实例和无选择状态。资产点击、BOM 点击、三维点击都更新这一选择入口，避免 selectedAsset 与 selectedId 同时指向不同设备而右侧显示错对象。

- 目录资产：展示 DeviceDefinition 的默认参数、说明和约束，显示“资产定义，只读”。缺失必需值显示“待填写”，不偷偷填零。
- 场景实例：参数取值为 paramsSchema.default + paramOverrides，标注默认/覆盖，继续按类型、范围和跨字段约束校验。
- 修改参数只影响选中实例；未实现模型变形的尺寸不应表现成已改变 GLB。Conveyor_aankws 的固定尺寸约束继续生效。
- 选择变化只改变明细与高亮，不应自动取消已有动作预览；预览控制仍明确显示所属实例。
- 当前设备信号独立展示，可编辑的是实例 PLC 映射；不在接口标记上添加信号绑定控件。

## 6. 模型选中与高亮

点击 GLB 任意子 Mesh 都选中所属设备实例，阻止事件冒泡导致重复选择。BOM 选择与三维选择共用 selectedId；点击空白清空选中状态。

高亮必须覆盖实际模型。首期对可支持的材质采用轻量 emissive 高亮，并以模型实际包围盒辅助定位；对不支持 emissive 的材质采用包围盒/边缘辅助显示。不能只依赖当前固定半径地面圆环。

每个实例拥有独立高亮状态；不能直接改共享材质使同定义其他实例一起变色。高亮所需材质副本和辅助几何由可视化层持有，取消选中恢复原材质；删除、切换模型、组件卸载时清理。骨骼模型实例化需保留骨骼关系，不能用错误的浅克隆共享姿态。

模型加载状态与选中状态无关：取消选择不重新下载 GLB。选中框边界只计算模型本体，不把接口箭头、标签和已有选中框包含进去形成递归膨胀。

## 7. 空间接口可视化

首期只在选中设备上显示已定义接口，采用用户参考图中的**小橙点**作为默认标识。明细显示局部位置、方向与吸附兼容角色。接口标记是辅助对象，不写入设备 GLB，不参与物理碰撞。

接口视觉规范：

- 默认：橙色实心圆点，建议色值 #F39A4B，直径约 8 px；以面向相机的小圆片或 Sprite 实现。保持屏幕尺寸相对稳定，避免随相机距离或设备缩放变成大球或难以辨认的小点。
- 悬停：圆点适度增大至约 10 px，显示名称/ID 提示，不常驻铺开所有标签。
- 选中接口：橙点加浅色描边，右侧显示该接口明细。吸附朝向箭头仅在选中接口或明确开启方向辅助时显示，默认不显示箭头。
- 标记中心严格位于接口局部坐标对应的投影位置。屏幕尺寸、描边和点击热区不修改真实接口位置；点击热区可扩展到约 16–20 px，但不可吞掉附近大面积模型的选择事件。
- 默认尊重模型遮挡，不让背面的接口始终穿透模型显示。共面闪烁通过绘制深度偏移处理，不改写 schema 坐标。
- 设备取消选中时隐藏其橙点及提示；没有有效坐标的 pending 接口不渲染假点。

色值、点大小及交互状态集中为渲染层样式常量，不新增设备 schema 参数。截图作为视觉参考，最终尺寸以真实模型视口验收为准。

- local_frame：直接按 position/forward/up 渲染。
- local_frame_pending=true：只显示待标定文字，不在原点生成假接口。
- local_frame_rule：实现当前受支持规则的纯函数求解，先解析实例参数与 origin_ref，再计算位置。未知规则/缺失参数明确显示无法求解；不得 eval 字符串。
- 标记点击保持所属设备选择，可突出对应接口/滚动右侧明细，但本轮不执行自动吸附。标记不应挡住模型选择或相机操作。

坐标体系：

```text
场景根节点
  └─ 设备实例组（实例平移、旋转、缩放）
      └─ 资产坐标组（导入变换，当前模型为单位变换）
          ├─ GLB 场景
          └─ 接口辅助组（模型根坐标系下的接口坐标）
```

保存的是设备/模型根坐标，显示位置遵循 p_world = M_instance × M_import × p_interface。标记作为共同变换父组的子对象即可随动，不能先手动转换成世界坐标后再放到设备组下重复变换。若计算世界朝向，使用完整变换后归一化；非均匀缩放下不得把法向变换简单当成位置变换。首期接口朝向按正交 forward/up 构造，奇异变换拒绝。

当前 GLB 加载器没有自动居中或缩放，继续保留原始模型根坐标。schema.asset.import_transform 的非单位情况需在规范化数据和渲染器中显式保留并应用一次；接口与模型必须经过同一个导入变换。不得因为接口间距为 1.5 m 而把有效皮带 length_m 从 1.4 m 改成 1.5 m。

Conveyor_aankws 验收基准：

| 接口 | 局部位置 m | forward | up |
| --- | --- | --- | --- |
| end_negative_x | [-0.749, 0.700, 0] | [-1, 0, 0] | [0, 1, 0] |
| end_positive_x | [0.751, 0.700, 0] | [1, 0, 0] | [0, 1, 0] |

## 8. 保存与资产所有权

公共模型添加到项目时保存一份内容明确的定义快照和 Blob，继续复用 IndexedDB 路径；项目刷新后能恢复，不依赖目录后来是否升级。项目 JSON 导出仍为数据导出，不含模型字节，沿用缺失时重新关联的说明。

公共目录刷新只更新候选资产清单，不替换已有项目定义；模型资源按 assetId/内容哈希复用，但 Object3D 与可编辑材质属于实例。GLB 解析缓存、重复实例化和释放职责应集中在 ModelRepository，而不是分散在卡片和视口组件。

## 9. 文件改动清单

以下为实施阶段的预计变更，名称可随代码职责作小幅调整。

| 文件（apps 下相对路径） | 操作 | 目的 |
| --- | --- | --- |
| scripts/build-model-catalog.mjs | 新增 | 扫描设备包、校验路径/元信息并生成索引 |
| public/modles/index.json | 生成 | 前端可请求的公共资产清单 |
| package.json | 修改 | 增加目录生成命令及 dev/build 前置步骤，修正 docs 路径 |
| src/contracts/catalog.ts | 新增 | 目录条目、来源、加载状态等类型与清单校验 |
| src/contracts/device.ts | 修改 | 保留规范化模型来源、导入变换及资源元信息 |
| src/validation/contracts.ts | 修改 | 新增资源/导入变换字段校验，保证保存后不丢字段 |
| src/domain/normalizeUnifiedDevice.ts | 修改 | 保留 asset.import_transform、来源和节点映射必要信息 |
| src/domain/catalog.ts | 修改 | 保留模板来源；与公共目录合并规则配合 |
| src/services/PublicModelCatalog.ts | 新增 | 获取索引/schema、解析相对 URL、缓存和重试 |
| src/services/ModelRepository.ts | 新增 | 下载/校验/持久化 GLB，模型解析与实例资源所有权 |
| src/domain/validateGlb.ts | 新增 | 抽取现有 GLB 校验，公共目录与手动导入共用 |
| src/stores/workspace.ts | 修改 | 增加目录状态、统一明细目标与原子添加定义/资源/实例操作 |
| src/commands/workspaceCommands.ts | 修改 | 新增公共资产添加命令，复用现有校验和异步失效保护 |
| src/features/workspace/WorkspaceClient.tsx | 修改 | 初始化目录加载，独立于项目恢复和场景文档 |
| src/features/catalog/AssetPanel.tsx | 修改 | 显示真实资产、来源、加载错误、刷新及添加操作 |
| src/features/inspector/Inspector.tsx | 修改 | 区分目录定义/场景实例明细，显示参数与接口信息 |
| src/renderer/SceneCanvas.tsx | 修改 | 接入模型仓库、统一坐标组和选择辅助组件 |
| src/renderer/SelectionHighlight.tsx | 新增 | 实例级材质高亮与包围盒辅助、恢复及释放 |
| src/renderer/InterfaceMarkers.tsx | 新增 | 渲染小橙点、悬停名称及选中方向辅助，随实例变换 |
| src/domain/resolveInterfaceFrame.ts | 新增 | 求解固定/参数化局部坐标，返回 pending/error 诊断 |
| src/renderer/SceneObjectRegistry.ts | 按需修改 | 区分模型根与辅助对象，避免辅助对象进入模型节点映射 |
| src/services/BrowserProjectRepository.ts | 按需修改 | 支持内容哈希资源复用和元数据恢复 |
| src/app/globals.css | 修改 | 目录来源、加载/错误状态、接口标签样式 |
| tests/public-catalog.test.ts | 新增 | 路径解析、包冲突、校验与添加失败完整性 |
| tests/interface-frame.test.ts | 新增 | 接口求解、实例/导入变换及坐标不重复应用 |
| tests/contracts.test.ts | 修改 | 真实资产字段保存往返与历史模板兼容 |
| e2e/workbench.spec.ts | 修改 | 取消硬编码“全部资产始终 8 个”的假设，保留模板断言 |
| e2e/public-models.spec.ts | 新增 | 使用真实 Conveyor 包验证本轮用户流程 |

src/domain/normalizeDeviceSpec.ts 保持入口分发；如资源字段需统一适配再调整。无需为本轮修改 PreviewController 的动作实现或接入物理库。

## 10. 实施顺序

1. 生成清单与资源发现：先让真实 Conveyor 卡片进入全部资产，校验失败可定位。
2. 添加到场景：打通定义校验、Blob 保存、实例创建与刷新恢复。
3. 右侧明细：目录选择只读、场景选择允许合法实例参数修改。
4. 实际模型高亮：子 Mesh 点击选择整机，同定义实例互不影响。
5. 接口呈现：固定坐标先验证，再处理现有参数化规则及 pending。
6. 运行静态检查、自动化测试和真实浏览器验收，记录已完成范围与遗留项。

## 11. 验收标准

- 新项目/空场景中仍能看见八类模板及公共 Conveyor；目录加载不自动摆放设备、不修改项目内容。
- 公共 Conveyor 显示 schema 的名称、版本及 11 个参数；仅看卡片也可在右侧读到默认参数。
- 添加后真实 GLB 加载成功，不要求先手工关联文件；模型与 schema 一致。
- 点击模型任意子网格，BOM、右侧明细和模型高亮同步；点击空白取消；两个相同设备只高亮一个。
- 选中 Conveyor 时仅显示两个小橙点，默认无常驻名称和方向箭头；悬停显示名称，选中接口加强描边并可查看朝向。位置/朝向与表中数值一致；平移、绕 Y 旋转 90°和缩放后仍与模型端点重合。
- 通过带非单位父变换的测试夹具，验证世界坐标只转换一次；pending 接口不显示原点标记。
- 参数覆盖只改当前实例，目录默认值和其他实例不变；固定尺寸参数不会让 GLB 与契约尺寸悄悄分离。
- 保存并刷新后，真实模型、定义、参数覆盖及可视化接口恢复；同内容资源不重复存储。
- GLB 404/损坏、schema 不合法、哈希不符、重复定义、异步时切换项目都能明确报错，避免半完成实例和旧请求污染新项目。
- 通过 npm test、npm run typecheck、npm run lint、npm run build；执行本轮 Playwright E2E 并查看真实模型选中/接口截图。测试应等待模型加载完成信号，不使用固定延时充当成功。

## 12. 方案记录约定

本轮已按方案实施，结果见第 13 节。后续每轮使用递增编号单独记录，保留需求、设计、文件清单、验收方法及最终实施结论。验收结论只能在实际完成后填写，不能将计划项描述成已实现。

## 13. 本轮实施结论

已完成公共目录扫描（catalog:models / predev / prebuild）、真实资产卡片、只读定义参数、实例参数覆盖、内容哈希资源持久化、真实 GLB 选中高亮、模型本体范围内的橙点遮挡检测、接口点击联动和项目保存恢复。

公共目录首个设备为 Conveyor_aankws 0.4.1。新增模型包后运行 npm run catalog:models，再使用资产栏“刷新目录”；浏览器刷新不扫描磁盘。目录只读浏览不修改项目，添加设备才把定义快照和模型资源纳入项目。

接口以约 8 px 橙点显示，悬停提示名称，选中显示描边与方向辅助；位置来自设备根坐标，实例和导入变换各应用一次。仅具有有效坐标的接口显示；参数化规则使用受约束的求解函数，缺失信息在明细中显示诊断。单独解析模型实例并隔离材质，避免选中一个设备使其他实例一起变色。

实际文件分工与计划有两处小调整：公共目录初始化放在 WorkspaceClient，目录数据放在 workspace store；模型资源仓库负责 Blob 校验/存储以外的解析与实例所有权，公共包下载、哈希核验由 PublicModelCatalog 提供。测试新增 model-repository.test.ts 专门覆盖材质隔离。

验证：47 项单元测试通过；类型检查、lint、生产构建通过。三个既有 Playwright 流程通过，新增真实公共模型流程通过，覆盖模型台面点击选择、橙点显示及保存恢复。验收截图为 test-results/public-conveyor-selected.png。

范围边界：自动吸附、拖动接口、信号引擎、物理接触仿真和真实动作执行未在本轮接入。目录重复身份明确拒绝，不自动升级项目已保存的设备定义。项目 JSON 导出继续不包含 GLB 字节，跨浏览器需要重新关联模型。小橙点当前按选中设备的模型本体做遮挡检测；跨设备遮挡可在后续统一场景遮挡集合中扩展。
