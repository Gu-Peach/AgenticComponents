# S10 三托盘各四件的批次码垛与换盘

单机器人逐件码放，按托盘清单完成后等待实际换盘；总计12件。

本批共 12 件物料、3 个任务载具；每件身份和归属见 [batch.json](batch.json)。

[process.py](process.py) 定义循环/并发与行为调用，[bindings.json](bindings.json) 定义外部到料、资源和适配假设，[task-spec.json](task-spec.json) 按完整批次独立验收。


当前为可静态解析的控制规范，尚未接入实际调度和物理执行。
