# 全量数据集构造与检查

数据位于 `datasets/ac-path-v1/`，由本目录 `.gitignore` 中的 `/datasets/` 忽略。现有完整输入为 72 个父案例、216 个结构变体、288 个语义变体，共 576 个案例；原 S04-P01 和七个变体的工艺与任务输入保留。

## 交付范围

| 子集 | 数量 | 文件与检查 |
| --- | ---: | --- |
| D-S | 288 | 72 父例复用，另有 216 个结构变体；72 语法、72 类型、72 未知能力按预期拒绝 |
| D-V | 360 | 72 父例复用，另有 288 个语义变体；均完成语法/引用/类型/资源绑定检查 |
| D-X | 7 条 | 已有 S04 轨迹的诊断索引及副本；包含反例、受保护负对照和合法隔离 |
| D-E | 12 对 | 每对有 ST 主程序、请求功能块、参数/条件/步骤映射、审核说明、输入锁；编译通过，等价待验证 |
| D-R | 36 组 | 每场景 3 类变更：别名、时间预算、独立目标；有真实 after 输入覆盖、before 引用和影响预测 |

源目录中的 `case.json`、`process.acp`、`environment.json`、`initial-state.json`、`task-spec.json`、`property-set.json`、`query-plan.json`、依赖锁与说明均已构造。变体按输入引用共享父例目标，避免目标跟随缺陷改变。

每个新父案例都有具体的符号工艺、物料及位置、外部事件、设备状态和业务目标，并非只换 ID。结构化输入未发现完全重复的父例，但同一家族的工艺仍高度相关，不将其当成独立工业总体样本。

## 如何检查

在 `dsl/algorithm/` 下运行，需要 Python 3.10+ 与既有 DSL 前端依赖 jsonschema：

```powershell
python -B tools/validate_foundation.py datasets/ac-path-v1
python -B tools/validate_corpus.py --dataset datasets/ac-path-v1 --dsl-root .. --output artifacts/full-construction/validation.json
python -B tools/test_corpus.py
python -B tools/test_pilot.py
python -B tools/test_foundation.py
```

第二条命令会检查 576 个输入，并将预期非法的结构样本与意外构造错误分开。退出成功表示构造与检查意图一致，不表示 576 个程序均合法，更不表示完整工艺已获证明。

`pilot_verify.py` 默认只运行原八个 pilot 输入。向它传入普通 corpus 案例会返回 UNSUPPORTED_MODEL；不能把未实现的通用求解能力隐藏在数据状态中。

## 重建与依赖锁

生成器使用已有基础契约、场景和八个 pilot 输入作为种子。数据目录被忽略后，新克隆仓库仍需获得这份种子或本地数据备份；生成器代码不包含原 GLB，也不凭空恢复未保存的契约。写入新的输出目录，不覆盖源数据：

```powershell
python -B tools/build_full_dataset.py --source datasets/ac-path-v1 --output datasets/ac-path-v1-next --dsl-root ..
```

随后对新目录做结构检查和 ST 编译检查，使用 `finalize_corpus.py` 根据实际检查报告登记状态，再显式冻结：

```powershell
python -B tools/freeze_dataset.py --dataset datasets/ac-path-v1 --dsl-root .. --write
```

`freeze_pilot.py` 仅更新八个 pilot 输入的锁，不覆盖全部 corpus 的锁策略。配对和变更任务有单独锁。生成器在种子之外会重建模板案例，人工修改前应保留副本；其输出状态必须重新审核。

## 当前真值边界

`oracle/truth-catalog.json` 逐案例区分结构检查、受限 pilot 参考结果和独立路径真值。新增案例的动态真值全部保留 pending/unresolved。四类语义变体是“顺序/门控、错误证据、冗余检查删除、终止逻辑”的候选变异；分支未走到或其他保护可能使它们不产生错误，不能自动贴正例标签。

DSL/ST 配对只在顺序、有限重复、控制作用域和等待的共同子集构造。ST 使用明确的 Ready/Condition、请求确认和停止清理输入；这些必须绑定到同一设备/环境模型。时间由 tick 向上取整为毫秒，扫描语义和取整差异都需要等价性论证。编译通过不等于与 DSL 等价，也不意味着设备已接通。

D-R 当前验证覆盖变更后结构与绑定，性能、影响集合准确性和动态回归结果未填写。D-X 的多环境轨迹可能来自同一缺陷，保留 defect_group，不把重复轨迹当新独立缺陷。

## 显式实验扩展

S03 的 LOOP 使用专用 loop_conveyor/circulate 契约，普通输送带没有自动获得回环能力。S12 的 PS1/PS2 是补充的抽象加工角色，没有声称对应真实模型节点。新增交接边为显式实验假设，不是空间规划结论。

多物料初态使用有限清单；需要时显式扩大输送与被动工作区容量，槽位、机器人、加工位的约束保留。换盘场景定义了外部物料去向和代次变更，不只将“已换盘”置 true。外部类型/质量/就绪状态均列在初态或事件中，缺失事实不默认成功。

这些定义足以继续开展算法实现、路径标签审核及对比实验；通用并行/循环/协议/异常转换模型仍需按算法方案实现和交叉验证。
