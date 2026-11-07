import type { CompiledCondition } from "./condition-expression";
import type { ProcessNode } from "./process-ir";
export interface SceneLadderRung {
  id: string;
  kind: ProcessNode["kind"] | "join" | "finalization";
  label: string;
  depth: number;
  parentId?: string;
  predecessor?: string;
  children: string[];
  device?: string;
  behavior?: string;
  conditions: CompiledCondition[];
  source?: { file: string; line: number; column: number };
}
export interface SceneLadder {
  schema: "scene-ladder/0.1";
  rungs: SceneLadderRung[];
}
