/** 按运行能力类型登记并查找工厂函数，使用场景上下文创建设备运行对象，检查类型重复或未注册的情况。 */

/** Capability dispatch is independent of scene IDs and authored device names. */
export class RuntimeFactoryRegistry<TContext, TResult> {
  private factories = new Map<string, (context: TContext) => TResult>();
  register(type: string, factory: (context: TContext) => TResult) {
    if (this.factories.has(type))
      throw new Error("Duplicate runtime factory: " + type);
    this.factories.set(type, factory);
  }
  create(type: string, context: TContext): TResult {
    const factory = this.factories.get(type);
    if (!factory) throw new Error("Unsupported runtime capability: " + type);
    return factory(context);
  }
}
