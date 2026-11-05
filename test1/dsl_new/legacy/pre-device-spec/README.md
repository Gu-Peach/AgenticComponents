# 契约驱动的声明式协作工艺

[领域语言规范](declarative_dsl/领域语言规范.md)采用seq/par/branch/repeat/invoke/await/delay/with-control/fail九类控制节点。[节拍与工步规则](declarative_dsl/节拍与工步规则.md)区分扫描周期、动作周期和生产节拍，明确证据推进与并行放行。

[十二场景索引](流程索引.md)指向当前声明式process.py。batch定义有限生产任务，bindings定义现场事实，设备契约定义通用行为，DSL显式组织协作。

```powershell
python -B tools/check_flows.py
python -B tools/compile_declarative.py processes/S01/process.py
python -B -m unittest discover -s tests -p "test_*.py"
python -B asset_contracts/tools/validate_contracts.py
```

当前前端静态编译声明到控制IR并检查接口，实际调度、事实提供者、信号与物理驱动仍待接入。检查输出executable=false及具体blockers；不能直接用Python解释器运行process.py。

旧函数式原型及其输入、工具与测试保存在legacy/ac-python-0.1，旧Lisp历史在legacy/ac-flow-0.2。当前入口不读取旧脚本作为工艺源。
