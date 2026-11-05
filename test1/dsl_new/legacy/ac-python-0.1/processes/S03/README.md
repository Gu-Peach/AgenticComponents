# S03 六件入环输送与双机械臂出环流水

最多2件在途，入口、环线和出口分别互锁；环线单次沿允许方向到交接点。

本批共 6 件物料、0 个任务载具；每件身份和归属见 [batch.json](batch.json)。

[process.py](process.py) 定义循环/并发与行为调用，[bindings.json](bindings.json) 定义外部到料、资源和适配假设，[task-spec.json](task-spec.json) 按完整批次独立验收。

- 闭合几何不自动增加循环圈数；LOOP.entry至exit是本次路线，需路径适配，未声明独立分区。

当前为可静态解析的控制规范，尚未接入实际调度和物理执行。
