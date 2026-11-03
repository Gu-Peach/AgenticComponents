# P1：性质规范与完整查询身份

本目录工作对应[五阶段方案](../docs/方法一整线参考模型与真值构造实施方案.md)的 P1。已经提供 V01–V10b 的局部/轨迹判定、语义澄清与完整查询库存；P1 本身不包含整线状态枚举，也不为实际案例补造真值。后续独立模型见 [P2 实现](README-reference-p2.md)。

见 [P1 验收报告](artifacts/reference-p1/P1验收报告.md)和[语义澄清](reference/specs/semantics-clarifications.md)。

## 范围

27,495 条原查询保留完整身份、原 profile_scope、性质版本和输入摘要。其中 26,810 条定义已就绪，160 条旧试点查询等待时间映射，525 条保留原不适用声明。217 条删除调用后的查询另标记空真风险，未从适用范围剔除。

1,065 条 V10b 查询的 K 小于响应期限 D；2,485 条延长尾窗的扩展候选单独保存，不改变旧查询范围。

`READY_FOR_P2` 不表示模型已实现或性质已验证。所有实际查询的 verdict 仍为 null，trigger_reachability 仍待探索。

## 可执行规范

`reference/specs/property-spec.json` 保存人可读公式和执行入口；Python 判定器实现这些观察义务，JSON 本身不是 SMT 编码器。

- `reference.properties.evaluate()`：检查一个明确的观察帧。V09/V10a 必须传入独立 TaskSpec，V10a 还需传入 bound。
- `ResponseMonitor`：检查一条完整事件轨迹中的有界响应，保留首次接受时钟，包含截止 tick，显式报告尾窗不足。
- SATISFIED 仅是局部义务满足；TRACE_SATISFIED 仅针对一条轨迹。它们不能直接充当普遍性标准答案。
- 缺失字段返回 UNKNOWN；非法帧返回 INVALID_FRAME。P2 负责从独立转换状态生成这些帧，P3 负责证据完整性与全模型结论。

## 文件

| 文件 | 内容 |
| --- | --- |
| `reference/specs/property-spec.json` | 11 项性质、观察/触发边界、类型与版本 |
| `reference/specs/semantics-clarifications.md` | 六阶段语义、身份、交接中间状态、窗口与待映射项 |
| `reference/properties.py` | 独立局部判定和单轨迹响应监视 |
| `datasets/ac-path-v1/oracle/whole-line-v1/query-inventory.json` | 27,495 条查询，无真值标签 |
| 同目录 `case-inputs.json` | 每案例输入、任务和契约摘要 |
| 同目录 `proposed-query-extensions.json` | 新身份的尾窗扩展候选，尚未准入 |
| 同目录 `static-scope.json` | 576 个案例的参考前端分类；216 个静态负例不进入动态枚举 |
| `tests/reference/` | 41 项性质边界与库存测试 |

## 复现

在 algorithm 目录运行：

```powershell
python -B tools/build_property_spec.py
python -B tools/build_reference_inventory.py --workspace . --output datasets/ac-path-v1/oracle/whole-line-v1-new
python -B -m unittest discover -s tests/reference -v
python -B tools/report_reference_p1.py --workspace . --inventory datasets/ac-path-v1/oracle/whole-line-v1 --test-log artifacts/reference-p1/tests.log --output artifacts/reference-p1-recheck
```

测试默认读取已发布的 whole-line-v1；验证新生成库存时设置 `AC_REFERENCE_INVENTORY` 指向新目录。生成器拒绝覆盖非空目录，输入或语义变更后应使用新版本，不能覆盖历史真值包。参考侧仅复用已存在的独立解析/绑定帮助器，不导入 `acverify` 或被测求解结果。
