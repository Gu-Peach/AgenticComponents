# 契约驱动的声明式协作工艺

资产已按三份原始规范改为DeviceSpec/1.1，见[规范对照与迁移](asset_contracts/docs/规范对照与迁移.md)。S01已按当前行为名和实例参数重写为ac-declarative/0.3，具体模型载荷仍待适配；S02—S12同样完成0.3声明迁移，但完整运行绑定仍待实现。check_flows执行严格契约审计，不接受候选能力占位。

[领域语言规范](declarative_dsl/领域语言规范.md)采用seq/par/branch/repeat/invoke/delay/with-control/fail八类控制节点；0.3移除显式等待，自动导入契约条件及流程收尾。[节拍与工步规则](declarative_dsl/节拍与工步规则.md)区分扫描周期、动作周期和生产节拍，明确证据推进与并行放行。

[十二场景索引](流程索引.md)指向当前声明式process.py。batch定义有限生产任务，bindings定义现场事实与单动作/持续控制适配，设备契约定义通用行为，DSL显式组织协作。

```powershell
python -B tools/check_flows.py
python -B tools/compile_declarative.py processes/S01/process.py
python -B -m unittest discover -s tests -p "test_*.py"
python -B asset_contracts/tools/validate_contracts.py
```

当前前端静态编译声明到控制IR并检查接口，实际调度、事实提供者、信号与物理驱动仍待接入。检查输出executable=false及具体blockers；不能直接用Python解释器运行process.py。

旧函数式原型及其输入、工具与测试保存在legacy/ac-python-0.1，旧Lisp历史在legacy/ac-flow-0.2。当前入口不读取旧脚本作为工艺源。

[九类资产PLC接口图](plc-modules.html)可直接在浏览器打开；[S01工艺说明](processes/S01/README.md)解释当前共同节拍与双工位并行。
