import { expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { sceneFixture } from "./fixtures";
import {
  decodeProcessNode,
  childrenOf,
  type ProcessNode,
} from "@/contracts/process-ir";
import { compileSceneRuntime } from "@/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "@/runtime/assembly/SceneRuntimeAssembler";
import type { SceneConditionWorld } from "@/runtime/assembly/SceneConditionBindings";
import type { SceneDevice } from "@/contracts/scene-execution";

it("executes an ordinary machining pick with its named material port and accepts the old payload for the return", async () => {
  const { bundle, bytes, goal } = sceneFixture("S06");
  const root = decodeProcessNode(bundle.process.body);
  const bind = (node: ProcessNode) => {
    if (
      node.kind === "invoke" &&
      node.id === "load_machine" &&
      node.payload?.kind === "payload"
    )
      node.payload.kwargs.grasp = { kind: "literal", value: "fixture_port" };
    childrenOf(node).forEach(bind);
  };
  bind(root);
  bundle.process.body = root;
  for (const raw of bundle.devices.filter(
    (d) => d.asset_kind === "runtime_material",
  )) {
    const device = raw as unknown as SceneDevice,
      g = device.geometry,
      inverse = new Quaternion(...g.world_rotation).invert();
    const contact = new Vector3(...g.bounds.min).lerp(
      new Vector3(...g.bounds.max),
      0.5,
    );
    contact.y = g.bounds.max[1];
    const frame = {
      position_m: contact
        .sub(new Vector3(...g.world_position))
        .applyQuaternion(inverse)
        .toArray(),
      approach_axis: new Vector3(0, -1, 0).applyQuaternion(inverse).toArray(),
    };
    (
      device.contract.type_specific_contract as Record<string, unknown>
    ).grasping = {
      frame_source: "material_local_m",
      preferred_grasp: "fixture_port",
      frames: { fixture_port: frame },
    };
  }
  const compiled = compileSceneRuntime(bundle, bytes, goal, "validation");
  const { program } = await assembleSceneRuntime(
    "assembled",
    "named-port",
    compiled,
  );
  try {
    program.start();
    const first = compiled.machining!.pallets[0].items[0];
    let returned = false;
    for (let tick = 0; tick < 72000 && program.needsStep(); tick++) {
      const snapshot = program.step(1 / 60);
      const w = snapshot.observations.samples["world/state"]
        .value as SceneConditionWorld;
      returned ||=
        w.machining!.slots[first.source] === first.material &&
        w.bodies[first.material + "/body"].materialState === "finished";
    }
    expect(
      program.snapshot().status,
      JSON.stringify(program.snapshot().error),
    ).toBe("succeeded");
    expect(returned).toBe(true);
  } finally {
    if (program.snapshot().status === "attention_required") program.discard();
    else program.dispose();
  }
}, 60000);
