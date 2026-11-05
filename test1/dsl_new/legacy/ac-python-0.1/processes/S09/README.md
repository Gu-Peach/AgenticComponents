# S09 六件双机加工与单机器人互斥服务

任务按明确轮换分配到MC1/MC2，两机可并行加工，R1的上下料和退位均互斥。

本批共 6 件物料、0 个任务载具；每件身份和归属见 [batch.json](batch.json)。

[process.py](process.py) 定义循环/并发与行为调用，[bindings.json](bindings.json) 定义外部到料、资源和适配假设，[task-spec.json](task-spec.json) 按完整批次独立验收。


当前为可静态解析的控制规范，尚未接入实际调度和物理执行。
