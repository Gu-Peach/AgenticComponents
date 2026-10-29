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
