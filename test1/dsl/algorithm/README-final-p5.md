# 方法一 P5：审核、实验与结果冻结

本流程完成固定共同查询视图的条件对应审核、独立参考证据复核、触发补证、同语义基线/消融运行、独立评分和最终报告。实际结果以 [P5 最终实验报告](artifacts/method1-p5-final/P5最终实验报告.md)及其完成清单为准。

范围与限制：

- 共同视图有 27,495 个查询，26,970 个适用项。1,065 个旧不足窗口用不同 ID 的扩展问题比较，原记录保留。
- 参考结论不由被测算法生成；worker 不接收 gold，且拒绝读取 oracle/gold 文件。预测封存后才连接参考标签。
- none、storage、portfolio 使用相同的 `acverify-tick/0.3` 语义。这是算法基线和消融，没有外部 PLC 工具成绩。
- 准入依据为源码条件归纳审核、实例前提及独立检查，详见 [P5.3 条件对应审核](docs/P5.3条件对应与真值准入审核.md)。不声称机器证明任意 Python/PLC 实现、几何或硬件安全。
- Unknown 和 worker 失败保留在完整分母；空真、触发未知与协议构造性质单独报告。完成实验不意味着每个查询都被算法决定。

## 交付位置

大型原始数据放在已有 gitignore 覆盖的目录：

```text
datasets/ac-path-v1/experiments/p5-final-v1/
  reference-recheck/       # P4 新证据的重新准入及原答案一致性
  trigger-review/          # 参考模型产生的补充触发证据、检查回执及未决记录
  admission/              # 条件对应审核、无标签查询、独立 gold 与共同范围 gate
  static/                 # 576 个前端案例的独立结构任务
  run/                    # 固定计划、输入组、作业、见证、墙钟及源码快照
  scores/                 # 全量逐查询/逐作业评分、分层指标和分歧
  efficiency/             # 同预算配对、重复稳定性、条件耗时与采样内存
  witness-audit/          # 正向见证在两模型中的合法性与观察历史检查
  completion-audit/       # 逐项完成条件与审查结论
  analysis-plan.json
  hardware.json
  visual-qa.json
  bundle.json
```

人类可读报告、PNG/SVG 图、指标副本与验收清单在 `artifacts/method1-p5-final/`。所有原始文件按各自 manifest 绑定；历史 P1–P4、P5.1/P5.2 包和旧引擎保留。

## 复现顺序

在 `dsl/algorithm` 下使用 Python 3.10+；检查器使用项目已有依赖，报告另需 matplotlib/numpy。所有新的构造/评分目录必须为空或不存在。下面的 `artifacts/p5-reproduce/` 是新输出示例，不能覆盖本次正式包。

```powershell
python -B -X utf8 tools/audit_reference_truth_p4.py --workspace . --candidates datasets/ac-path-v1/oracle/whole-line-p4-v1 --output artifacts/p5-reproduce/reference-recheck
python -B -X utf8 tools/review_p53_triggers.py --workspace . --output artifacts/p5-reproduce/triggers
python -B -X utf8 tools/admit_p53_review.py --workspace . --recheck artifacts/p5-reproduce/reference-recheck --triggers artifacts/p5-reproduce/triggers --proof-document docs/P5.3条件对应与真值准入审核.md --output artifacts/p5-reproduce/admission

python -B -X utf8 tools/validate_corpus.py --dataset datasets/ac-path-v1 --dsl-root .. --output artifacts/p5-reproduce/static/validation.json
python -B -X utf8 tools/run_p54_experiment.py --workspace . --review artifacts/p5-reproduce/admission --output artifacts/p5-reproduce/run --plan-only
python -B -X utf8 tools/freeze_p55_analysis.py --experiment artifacts/p5-reproduce/run --output artifacts/p5-reproduce/analysis-plan.json
python -B -X utf8 tools/run_p54_experiment.py --workspace . --review artifacts/p5-reproduce/admission --output artifacts/p5-reproduce/run

python -B -X utf8 tools/score_p54_experiment.py --workspace . --review artifacts/p5-reproduce/admission --experiment artifacts/p5-reproduce/run --output artifacts/p5-reproduce/scores
python -B -X utf8 tools/report_p55_efficiency.py --scores artifacts/p5-reproduce/scores --output artifacts/p5-reproduce/efficiency
python -B -X utf8 tools/audit_p55_witnesses.py --workspace . --experiment artifacts/p5-reproduce/run --scores artifacts/p5-reproduce/scores --output artifacts/p5-reproduce/witness-audit
python -B -X utf8 tools/report_p55_final.py --review artifacts/p5-reproduce/admission --experiment artifacts/p5-reproduce/run --scores artifacts/p5-reproduce/scores --efficiency artifacts/p5-reproduce/efficiency --witnesses artifacts/p5-reproduce/witness-audit --static artifacts/p5-reproduce/static/validation.json --output artifacts/p5-reproduce/report
```

最后检查六张渲染图，保存带文件摘要的 `visual-qa.json`，再运行：

```powershell
python -B -X utf8 tools/audit_p55_completion.py --workspace . --review artifacts/p5-reproduce/admission --triggers artifacts/p5-reproduce/triggers --recheck artifacts/p5-reproduce/reference-recheck --experiment artifacts/p5-reproduce/run --scores artifacts/p5-reproduce/scores --efficiency artifacts/p5-reproduce/efficiency --witnesses artifacts/p5-reproduce/witness-audit --report artifacts/p5-reproduce/report --static artifacts/p5-reproduce/static/validation.json --analysis-plan artifacts/p5-reproduce/analysis-plan.json --visual-qa artifacts/p5-reproduce/visual-qa.json --output artifacts/p5-reproduce/completion-audit
```

图片 QA 记录包含 `figures` 数组，每项为 `file`（相对 report 目录的 PNG 名）、`sha256`、`status` 和检查说明。必须先实际查看图像，不能自动把所有项目填为 PASS。

## 运行与恢复规则

计划包含 4,536 个串行子进程作业：全量 3,240 个，以及预先分层选定的重复作业 1,296 个。全量预算 0.5 秒；重复预算 0.5/2 秒，各三次。每个配对块内轮换方法顺序。搜索、构造、重放、worker 与父进程墙钟分别保存；进程 watchdog 与搜索预算不同。

可再次运行同一 `run_p54_experiment.py` 命令恢复。输入、计划、源码或问题摘要改变时拒绝恢复；同一 runner PID 仍存活时拒绝并发启动。完成作业逐个封存，完成的错误/超时不按效果择优重跑。未完成 attempt 保留；正式作业采用同输出根内的原子提升。已经封存的整次运行只校验并返回，不改写预测。

原执行位置可能保留在 job-specs 的绝对路径中，作为运行来源记录。复现实验应创建新输出目录，由运行器重新生成路径；不要直接手改已封存的 job-specs。

## 指标解释

- **求解覆盖率** = 确定回答 / 全部适用查询。
- **已回答准确率** = 正确 / 确定回答；无回答时为 null，不能写 100%。
- **全范围正确比例** = 正确 / 全部适用查询。
- 触发可达性与性质 verdict 分开；目标可达性 V10a 不混进条件式性质的空真覆盖图。
- 时间比只在双方都正确决定全部适用查询的作业上计算，并与全量覆盖/超时率同时展示。区间按父案例、场景分层；样本少时不宣称稳定优势。
- 采样 RSS 不等于严格峰值或 OS 硬限制；portfolio 的跨阶段状态数可能重叠。

旧 `acverify` 默认入口仍是 v0.2；单独调用新引擎使用 `tools/acverify_v3.py`。本实验运行器明确导入 v0.3，不会用旧结果冒充新语义下的基线。
