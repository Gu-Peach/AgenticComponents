import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeDeviceSpec } from "../src/domain/normalizeDeviceSpec";
import { createDemoProject } from "../src/domain/catalog";
import {
  parseProject,
  semanticIssues,
  validateParameters,
} from "../src/validation/contracts";
describe("contract boundaries", () => {
  it("loads all eight parameter templates and validates a round-tripped project", () => {
    const p = createDemoProject();
    expect(p.definitions).toHaveLength(8);
    for (const def of p.definitions)
      expect(semanticIssues(def), def.name).toEqual([]);
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it.each(["conveyor_1", "robot_arm_1", "workpiece_1", "carrier_tray_1"])(
    "normalizes actual %s, preserving its source",
    (file) => {
      const source = JSON.parse(
        readFileSync(`public/catalog/examples/${file}.json`, "utf8"),
      );
      const d = normalizeDeviceSpec(source);
      expect(d.source).toEqual(source);
      expect(d.specId).toBe(file);
      expect(semanticIssues(d)).toEqual([]);
    },
  );
  it("rejects parameter fragments and invalid references", () => {
    expect(() =>
      normalizeDeviceSpec({ device_type: "robot_arm", params_schema: {} }),
    ).toThrow();
    const p = createDemoProject();
    p.instances[0].specRevision = "stale";
    expect(() => parseProject(p)).toThrow("版本");
  });
  it("enforces bounds, conditional requirements, integer types and capacity semantics", () => {
    expect(
      validateParameters({ n: { type: "integer", min: 0 } }, { n: 1.5 }),
    ).not.toEqual([]);
    expect(
      validateParameters(
        {
          mode: { type: "string" },
          zone: {
            type: "integer",
            required_when: { parameter: "mode", equals: "zoned" },
          },
        },
        { mode: "zoned" },
      ),
    ).not.toEqual([]);
    expect(
      semanticIssues(createDemoProject().definitions[0], {
        capacity: 3,
        resume_threshold: 3,
      }),
    ).toContain("resume_threshold 必须小于 capacity");
  });
  it("rejects duplicate instance IDs and NaN transforms", () => {
    const p = createDemoProject();
    p.instances.push(p.instances[0]);
    expect(() => parseProject(p)).toThrow("重复");
    p.instances.pop();
    p.instances[0].transform.position[0] = NaN;
    expect(() => parseProject(p)).toThrow();
  });
});
