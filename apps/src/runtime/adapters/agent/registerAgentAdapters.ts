/** 预留智能体动画适配器的注册入口，供后续把设备行为契约关联到预览执行器。 */

import type { ExecutorRegistry } from "@/runtime/ExecutorRegistry";
/** Migration entry. Register AnimationAdapter implementations here when ready. */
export function registerAgentAdapters(registry: ExecutorRegistry): void {
  void registry;
  // registry.register(robotPickPlaceAdapter);
  // Its id must match the BehaviorContract.executorRef.
}
