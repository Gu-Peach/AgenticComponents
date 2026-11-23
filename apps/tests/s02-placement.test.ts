import { readFileSync } from "node:fs";
import { Quaternion, Vector3 } from "three";
import { expect, it } from "vitest";
import { sceneBundleSchema } from "../src/contracts/scene-package";
import { compileSceneRuntime } from "../src/domain/runtime/compileSceneRuntime";
import { createJoltBackend } from "../src/runtime/physics/jolt/JoltPhysicsBackend";
import {
  fitsLoadedSlot,
  palletPlacement,
} from "../src/runtime/assembly/loadingDevices";

it("resolves actual S02 pallet slots, layer supports and declared cover rotation", async () => {
  const root = "public/scene/S02";
  const bundle = sceneBundleSchema.parse(
    JSON.parse(readFileSync(root + "/.generated/scene.bundle.json", "utf8")),
  );
  const glb = readFileSync("public" + decodeURIComponent(bundle.model_url));
  const c = compileSceneRuntime(
    bundle,
    glb.buffer.slice(
      glb.byteOffset,
      glb.byteOffset + glb.byteLength,
    ) as ArrayBuffer,
    JSON.parse(readFileSync(root + "/task-spec.json", "utf8")),
    "validation",
  );
  const physics = await createJoltBackend(c.physics);
  try {
    const pallet = c.loading!.pallets[0],
      lower = pallet.items[0],
      cover = pallet.items[12],
      upper = pallet.items[13];
    const first = palletPlacement(c, physics, lower.material),
      lid = palletPlacement(c, physics, cover.material),
      last = palletPlacement(c, physics, upper.material);
    expect(first.supports).toEqual([pallet.id + "/body"]);
    expect(lid.supports).toEqual(
      pallet.items.slice(0, 12).map((i) => i.material + "/body"),
    );
    expect(last.supports).toEqual([cover.material + "/body"]);
    const body = c.bodyMap.get(pallet.id + "/body")!;
    const q = new Quaternion(...lid.rotation);
    expect(new Vector3(0, 0, 1).applyQuaternion(q).x).toBeCloseTo(1, 5);
    expect(lid.center[0]).toBeCloseTo(body.position[0], 4);
    expect(lid.center[2]).toBeCloseTo(body.position[2], 4);
    expect(first.center[1]).toBeCloseTo(0.46, 3);
    expect(lid.center[1]).toBeCloseTo(0.565, 3);
    expect(last.center[1]).toBeCloseTo(0.67, 3);
    expect(fitsLoadedSlot(c, physics, lower.material)).toBe(false);
  } finally {
    physics.dispose();
  }
});
