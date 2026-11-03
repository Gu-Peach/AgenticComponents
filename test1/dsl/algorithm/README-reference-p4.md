# P4：整线参考真值覆盖扩展

新增 `certification_p4/`，在冻结的 P2/P3 参考内核上检查条件不变量、并发成功后态、事件保持、响应上界与压缩反例。方法与限制见 [覆盖扩展与证明边界](docs/P4覆盖扩展与证明边界.md)，结果见 [验收报告](artifacts/reference-p4/P4验收报告.md)。

正式包为 `datasets/ac-path-v1/oracle/whole-line-p4-v1/`。不覆盖 P1/P3，原查询与扩展 V10b 查询分开计数；`sut_comparison_eligible=false` 仍然有效。`benchmark-view.json` 是改变响应窗口后的建议评价视图，不是对旧查询答案的回填。

在 `dsl/algorithm` 执行（Python 3.10+）：

```powershell
python -B -X utf8 -m unittest discover -s tests/certification_p4 -v
python -B -X utf8 tools/build_reference_truth_p4.py --workspace . --output artifacts/p4-rebuild-candidates
python -B -X utf8 tools/complete_reference_truth_p4.py --workspace . --candidates artifacts/p4-rebuild-candidates --output artifacts/p4-rebuild-supplemented
python -B -X utf8 tools/audit_reference_truth_p4.py --workspace . --candidates artifacts/p4-rebuild-supplemented --output artifacts/p4-rebuild-final
python -B -X utf8 tools/report_reference_truth_p4.py --package artifacts/p4-rebuild-final --output artifacts/p4-rebuild-report
```

构造/准入必须使用新的空输出目录，不能覆盖已冻结包。报告工具需要 matplotlib；证明与检查只用标准库。跨目录运行测试时可通过 `ACVERIFY_WORKSPACE` 指向数据集所在的 algorithm 根目录。

| 文件/目录 | 职责 |
| --- | --- |
| `certification_p4/contract-policy.json` | 已审核契约模板摘要 |
| `certification_p4/invariants.py` | 构造与条件保持证明模式、实例前提 |
| `certification_p4/event_rules.py` | 外部更新对目标/阻塞事实的保持 |
| `certification_p4/goal_projection.py` | 仅用于成功后态的并发上近似 |
| `certification_p4/response_bound.py` | 新鲜无故障反馈的充分响应上界 |
| `certification_p4/quiet_wait.py` | 不跨期限的单路径等待摘要与复核 |
| `certification_p4/witnesses.py` | 有限触发见证 |
| `certification_p4/binding.py` | 查询绑定与新旧检查器分派 |
| `tools/build_reference_truth_p4.py` | 批量构造候选证据 |
| `tools/complete_reference_truth_p4.py` | 对非窗口原因的剩余查询尝试完整状态图，保留父包来源 |
| `tools/audit_reference_truth_p4.py` | 重新检查新证据、独立汇总、输入完整性检查 |
| `tests/certification_p4/` | 语义反例、规则拒绝、摘要对照、篡改检测 |

证明模式包含人工可读的技术论证和机器可检查的条件；不是证明助手对 Python 的全语义证明。审核由 AI 完成，不声称第三方人工审定。只有被测模型与参考模型的目标、时间、环境、身份、停止/隔离语义完成对应后，才能进行算法准确率比较。
