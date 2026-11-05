# S04 四件双机械臂双输送带流水交接

最多2件在途，上游准备可与下游出料重叠；共享设备和目标容量互锁。

本批共 4 件物料、0 个任务载具；每件身份和归属见 [batch.json](batch.json)。

[process.py](process.py) 定义循环/并发与行为调用，[bindings.json](bindings.json) 定义外部到料、资源和适配假设，[task-spec.json](task-spec.json) 按完整批次独立验收。


当前为可静态解析的控制规范，尚未接入实际调度和物理执行。
