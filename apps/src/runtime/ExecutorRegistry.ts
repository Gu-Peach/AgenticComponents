/** 按执行器 ID 注册和查找动画适配器，供预览控制器选择契约指定的执行器或模拟执行器。 */

import type { AnimationAdapter } from "@/contracts/preview";
export class ExecutorRegistry {
  private adapters = new Map<string, AnimationAdapter>();
  register(adapter: AnimationAdapter) {
    if (this.adapters.has(adapter.id))
      throw new Error(`执行器已注册: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string) {
    return this.adapters.get(id);
  }
}
