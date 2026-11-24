import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { normalizeUnifiedDevice } from "../src/domain/normalizeUnifiedDevice";
import { sceneBundleSchema } from "../src/contracts/scene-package";
import { sceneModules } from "../src/domain/runtime/sceneModules";

it("imports the rail contract and exposes the real S07 device modules", () => {
  const contract = JSON.parse(
    readFileSync("public/scene/S07/contracts/linear_rail.json", "utf8"),
  );
  const device = normalizeUnifiedDevice(contract);
  expect(device.deviceType).toBe("linear_rail");
  expect(device.behaviors.map((b) => b.id)).toEqual([
    "move_to_location",
    "move_to_position",
    "stop_motion",
  ]);
  expect(
    device.behaviors.every((b) => b.implementationStatus === "pending_adapter"),
  ).toBe(true);
  const bundle = sceneBundleSchema.parse(
    JSON.parse(
      readFileSync("public/scene/S07/.generated/scene.bundle.json", "utf8"),
    ),
  );
  expect(sceneModules(bundle).length).toBeGreaterThan(0);
  expect(bundle.calls.some((c) => c.device === "X1")).toBe(false);
  expect(
    bundle.calls.some(
      (c) => c.device === "T1" && c.behavior === "move_to_position",
    ),
  ).toBe(true);
});
