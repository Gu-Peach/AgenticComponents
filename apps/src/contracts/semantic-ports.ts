/** 具名物料／端点事实与其实例化后的控制流来源。事实读取始终保留主体与坐标端点的身份。 */
export interface SemanticFact {
  semantic:
    "at" | "supported_at" | "stopped" | "held_by" | "retained_at" | "processed";
  subject: string;
  endpoint: string;
}
export interface SignalConnection extends SemanticFact {
  consumer: string;
  producer: string | null;
  alternatives: readonly (string | null)[];
}
