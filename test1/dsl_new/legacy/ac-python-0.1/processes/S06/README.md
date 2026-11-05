# S06 四件分度台批次与前后段流水

进出料可与转位工位处理重叠，T1单工位周期串行。

本批共 4 件物料、0 个任务载具；每件身份和归属见 [batch.json](batch.json)。

[process.py](process.py) 定义循环/并发与行为调用，[bindings.json](bindings.json) 定义外部到料、资源和适配假设，[task-spec.json](task-spec.json) 按完整批次独立验收。


当前为可静态解析的控制规范，尚未接入实际调度和物理执行。
