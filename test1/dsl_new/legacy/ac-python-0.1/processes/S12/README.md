# S12 四件双侧加工与转位交接流水

最多2件在途，PS1与PS2可加工不同工件，转台交接周期互斥。

本批共 4 件物料、0 个任务载具；每件身份和归属见 [batch.json](batch.json)。

[process.py](process.py) 定义循环/并发与行为调用，[bindings.json](bindings.json) 定义外部到料、资源和适配假设，[task-spec.json](task-spec.json) 按完整批次独立验收。


当前为可静态解析的控制规范，尚未接入实际调度和物理执行。
