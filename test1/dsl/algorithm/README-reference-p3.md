# P3 参考真值证据与准入

P3 为冻结的 P2 符号参考问题构造并检查证据，提供有范围声明的逐查询答案。它不改变 P1 查询、P2 转换模型或旧实验结果。

- [证据准入规则](docs/P3证据准入规则.md)：可信边界、轨迹、闭合图、逻辑和成功效果证书。
- [P3 验收报告](artifacts/reference-p3/P3验收报告.md)：本轮实际覆盖、空真、反例与未决项。
- `datasets/ac-path-v1/oracle/whole-line-p3-v1/answers.jsonl`：正式准入输出。
- 同目录 `query-registry.json`：新参考查询身份及原查询来源。
- 同目录 `evidence/`、`evidence-checks.json`、`manifest.json`：压缩证据、复核结果及冻结摘要。

## 实现结构

| 文件 | 职责 |
| --- | --- |
| `certification/binding.py` | 查询、模型、输入、性质与时间范围绑定 |
| `certification/evidence_check.py` | 独立于搜索循环的轨迹和图覆盖检查 |
| `certification/logic.py` | 必经矛盾、最终目标蕴含、初始不可推进等逻辑规则 |
| `certification/success_effects.py` | 成功效果过近似证书生成与独立推导核查 |
| `certification/policy.py`、`trusted-kernel.json` | 固定已审查的参考语义核心和归一化来源 |
| `certification/construct.py` | 合法路径候选与图候选构造 |
| `tools/build_reference_truth_p3.py` | 构造候选包，保留所有查询及未决项 |
| `tools/audit_reference_truth_p3.py` | 重新检查全部证据，输出正式准入包 |

检查器单独放在 certification 下，避免新增检查代码改变 P2 的模型指纹。生成器与检查器不使用被测 acverify 的输出；但证据检查信任冻结的 P2 转换语义，这不等于证明真实设备或其他执行器与它等价。

## 复现

在 algorithm 目录运行，使用新的输出目录：

```powershell
python -B -m unittest discover -s tests/certification -v
python -B tools/build_reference_truth_p3.py --workspace . --output artifacts/p3-candidates-new
python -B tools/audit_reference_truth_p3.py --workspace . --candidates artifacts/p3-candidates-new --construction-builder tools/build_reference_truth_p3.py --output datasets/ac-path-v1/oracle/whole-line-p3-new
```

当前正式包保留了实际构造源码快照。未来重跑时 `--construction-builder` 必须与该次候选包记录的 SHA-256 相符；不能更改源码后仍声称复现了同一构造过程。生成器及准入器都拒绝覆盖非空输出目录。

## 解释结果

CERTIFIED 表示在记录的参考语义和范围下证据已核查；UNRESOLVED 不等于错误；NOT_APPLICABLE 沿用明确的任务范围。空真与非空真分开统计，V10b 的原完整窗口与延长尾窗是不同查询。

本轮仍没有完成所有查询的真值，也没有完成与被测执行器的语义对应。正式包的 `sut_comparison_eligible=false` 必须保留，不能直接重算旧实验准确率。更多属性和场景覆盖在 P4 推进。
