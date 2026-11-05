# S07 四件分层入库后按订单出库

先完成有限入库批次，再按订单出库；共享抓放机构X1互斥。

本批共 4 件物料、0 个任务载具；每件身份和归属见 [batch.json](batch.json)。

[process.py](process.py) 定义循环/并发与行为调用，[bindings.json](bindings.json) 定义外部到料、资源和适配假设，[task-spec.json](task-spec.json) 按完整批次独立验收。

- X1是仓储抓放子模块的标准化能力适配，复用robot_arm接口，不声称模型中有六轴机械臂。

当前为可静态解析的控制规范，尚未接入实际调度和物理执行。
