import type {
  ConditionContext,
  ConditionProvider,
  Truth,
} from "@/contracts/conditions";
export type {
  ConditionContext,
  ConditionProvider,
  Truth,
} from "@/contracts/conditions";
export class ConditionProviders {
  private providers = new Map<string, ConditionProvider>();
  register(id: string, provider: ConditionProvider) {
    if (this.providers.has(id)) throw new Error("Duplicate condition provider");
    this.providers.set(id, provider);
  }
  validate(ids: readonly string[]) {
    const visited = new Set<string>(),
      active = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) throw new Error("Condition dependency cycle: " + id);
      if (visited.has(id)) return;
      const p = this.providers.get(id);
      if (!p) throw new Error("Missing condition provider: " + id);
      active.add(id);
      for (const dep of p.dependencies ?? []) visit(dep);
      active.delete(id);
      visited.add(id);
    };
    ids.forEach(visit);
  }
  evaluate(id: string, context: ConditionContext): Truth {
    this.validate([id]);
    const cache = new Map<string, Truth>();
    const evalOne = (key: string): Truth => {
      if (cache.has(key)) return cache.get(key);
      const p = this.providers.get(key)!;
      const dependencies = Object.create(null) as Record<string, Truth>;
      for (const d of p.dependencies ?? []) dependencies[d] = evalOne(d);
      const result = p.evaluate(context, Object.freeze(dependencies));
      if (result !== true && result !== false && result !== undefined)
        throw new Error("Invalid condition result");
      cache.set(key, result);
      return result;
    };
    return evalOne(id);
  }
  all(ids: readonly string[], context: ConditionContext): Truth {
    const results = ids.map((id) => this.evaluate(id, context));
    return results.includes(false)
      ? false
      : results.includes(undefined)
        ? undefined
        : true;
  }
}
export function signalEquals(
  key: string,
  expected: boolean | number,
  correlated = false,
): ConditionProvider {
  return {
    evaluate(c) {
      const s = c.frame.samples[key];
      if (!s || s.runId !== c.frame.runId || s.quality !== "good")
        return undefined;
      if (
        correlated &&
        (!c.request ||
          c.request.runId !== c.frame.runId ||
          s.requestId !== c.request.requestId ||
          s.activationId !== c.request.activationId ||
          s.subjectId !== c.request.subjectId)
      )
        return undefined;
      return s.value === expected;
    },
  };
}
export function observationMatches(
  key: string,
  predicate: (value: unknown) => boolean,
  correlated = false,
): ConditionProvider {
  return {
    evaluate(c) {
      const s = c.observations?.samples[key];
      if (!s || s.runId !== c.frame.runId || s.quality !== "good")
        return undefined;
      if (
        correlated &&
        (!c.request ||
          c.request.runId !== c.frame.runId ||
          s.requestId !== c.request.requestId ||
          s.activationId !== c.request.activationId ||
          s.subjectId !== c.request.subjectId)
      )
        return undefined;
      return predicate(s.value);
    },
  };
}
