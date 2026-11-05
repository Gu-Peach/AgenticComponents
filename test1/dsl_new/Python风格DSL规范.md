# 历史规范入口

资产已按三份原始规范改为DeviceSpec/1.1，见[规范对照与迁移](asset_contracts/docs/规范对照与迁移.md)。此前脚本引用的旧行为和参数需要重新绑定；当前check_flows执行严格契约审计，不再接受候选能力占位。

当前规范为[声明式协作DSL](declarative_dsl/领域语言规范.md)。此前函数式版本的文档保存在[原型归档](legacy/ac-python-0.1/Python风格DSL规范.md)，不作为当前process.py的语法规范。
