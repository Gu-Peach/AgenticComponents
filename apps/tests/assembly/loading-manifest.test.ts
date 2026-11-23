import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  sceneBundleSchema,
  type SceneBundle,
} from "../../src/contracts/scene-package";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";

const folder = "public/scene/S02";
const original = sceneBundleSchema.parse(
  JSON.parse(readFileSync(folder + "/.generated/scene.bundle.json", "utf8")),
);
const model = readFileSync("public" + decodeURIComponent(original.model_url));
const bytes = model.buffer.slice(
  model.byteOffset,
  model.byteOffset + model.byteLength,
) as ArrayBuffer;
const goal = JSON.parse(readFileSync(folder + "/task-spec.json", "utf8"));

function withChange(mutate: (bundle: SceneBundle) => void) {
  const bundle = structuredClone(original);
  mutate(bundle);
  return () => compileSceneRuntime(bundle, bytes, goal, "validation");
}

it("rejects a carrier-local destination belonging to another pallet", () => {
  const run = withChange((bundle) => {
    const pallets = bundle.process.task.pallets as {
      items: { target: string }[];
    }[];
    pallets[0].items[0].target = pallets[1].items[0].target;
  });
  expect(run).toThrow(/target manifest differs/);
});

it("rejects a material assigned to a feeder supplying a different prototype", () => {
  const run = withChange((bundle) => {
    bundle.devices.find((d) => d.instance_id === "M01_01")!.initial_supply =
      "F2";
  });
  expect(run).toThrow(/slot\/material\/supply mapping/);
});

it("rejects a loading target supported by another drive group", () => {
  const run = withChange((bundle) => {
    const device = bundle.devices.find((d) => d.instance_id === "C5")!;
    const locations = device.locations as Record<
      string,
      { support_device?: string }
    >;
    locations["C5.station1"].support_device = "S1A";
  });
  expect(run).toThrow(/Target support outside loading line/);
});

it("rejects a material-source support bound against an older model snapshot", () => {
  const run = withChange((bundle) => {
    bundle.devices.find(
      (d) => d.instance_id === "F1",
    )!.node_binding.model_sha256 = "f".repeat(64);
  });
  expect(run).toThrow(/model hash mismatch/);
});
