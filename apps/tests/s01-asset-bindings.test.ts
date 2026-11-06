import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sceneBundleSchema } from "../src/contracts/scene-package";

const path = "public/scene/S01/";
const json = (file: string) => JSON.parse(readFileSync(path + file, "utf8"));
const bundle = sceneBundleSchema.parse(json(".generated/scene.bundle.json"));
const manifest = json("scene.json");
interface AuthoredDevice {
  instance_id: string;
  asset_kind: string;
  node_binding: {
    status: string;
    root: { index: number };
    excluded_subtrees: number[];
  };
  contract: {
    asset: { model_key: string };
    runtime_execution_contract: { real_execution_available: boolean };
    type_specific_contract: {
      urdf: { joints: { axis: unknown; limit: unknown }[] };
      tooling: { tcp_local_frame: { position: number[] } };
    };
  };

  parameters: { height_m: number };
}
const authored: {
  instance_id: string;
  asset_kind?: string;
  contract_ref: string;
}[] = manifest.devices.map((f: string) => json(f));
const compiled = authored.map((a) =>
  bundle.devices.find((d) => d.instance_id === a.instance_id),
) as unknown as AuthoredDevice[];
const raw = readFileSync(
  path + "assembly_order_index/assembly_order_index.glb",
);
const gltf = JSON.parse(
  raw.subarray(20, 20 + raw.readUInt32LE(12)).toString("utf8"),
);

describe("S01 verified scene assets", () => {
  it("binds the exact user-specified devices and distinguishes four conveyor sections", () => {
    expect(authored).toHaveLength(9);
    const expected: Record<string, string> = {
      C1: "Conveyor(1)",
      C2: "Conveyor(2)",
      C3: "Conveyor(3)",
      C4: "Conveyor(4)",
      R1: "robot(center)(1)",
      R2: "robot(2)",
      F1: "__Geometry__ [00Jc]",
      Pallet: "AssemblyBaseComponent [00Ln]",
      Workpiece: "Lathe Comp 3 [00On]",
    };
    for (const d of compiled) {
      expect(d.node_binding.status).toBe("bound");
      expect(gltf.nodes[d.node_binding.root.index].name).toBe(
        expected[d.instance_id],
      );
      expect(d.contract.asset.model_key).not.toContain("unbound/");
      expect(
        d.contract.runtime_execution_contract.real_execution_available,
      ).toBe(false);
    }
  });
  it("maintains one carrier and material contract while deriving three finite twelve-item loads", () => {
    expect(
      authored.filter((d) => d.asset_kind === "carrier_prefab"),
    ).toHaveLength(1);
    expect(
      authored.filter((d) => d.asset_kind === "material_prefab"),
    ).toHaveLength(1);
    expect(bundle.process.task.pallet_count).toBe(3);
    expect(bundle.process.task.material_count).toBe(36);
    const pallets = bundle.process.task.pallets as {
      id: string;
      items: { category: string }[];
    }[];
    expect(pallets).toHaveLength(3);
    for (const p of pallets) {
      expect(p.items).toHaveLength(12);
      expect(p.items.filter((i) => i.category === "A")).toHaveLength(6);
      expect(p.items.filter((i) => i.category === "B")).toHaveLength(6);
    }
  });
  it("covers each original GLB mesh node once without attaching workpieces to the pallet body", () => {
    const owned = new Set<number>();
    for (const d of bundle.devices) {
      if (
        ["carrier_prefab", "material_prefab"].includes(String(d.asset_kind)) ||
        d.node_binding.status !== "bound"
      )
        continue;
      for (const index of d.node_binding.owned_mesh_indices as number[]) {
        expect(owned.has(index)).toBe(false);
        owned.add(index);
      }
    }
    const meshes = gltf.nodes.flatMap((n: { mesh?: number }, i: number) =>
      n.mesh === undefined ? [] : [i],
    );
    expect([...owned].sort((a, b) => a - b)).toEqual(meshes);
    const pallet = compiled.find((d) => d.instance_id === "Pallet")!;
    expect(pallet.node_binding.excluded_subtrees).toHaveLength(12);
    expect(pallet.parameters.height_m).toBeLessThan(0.16);
  });
  it("does not mark future batches as physically present and does not invent robot calibration", () => {
    expect(
      bundle.devices.find((d) => d.instance_id === "P02")?.node_binding.status,
    ).toBe("prototype");
    expect(
      bundle.devices.find((d) => d.instance_id === "M03_12")?.creation_policy,
    ).toBe("clone_on_admission");
    const future = bundle.devices.find((d) => d.instance_id === "M03_12")!;
    const signals = future.signal_bindings as Record<
      string,
      { logical_signal: string }
    >;
    for (const [port, signal] of Object.entries(signals))
      expect(signal.logical_signal).toBe(`M03_12/${port}`);
    expect(
      bundle.blockers.some((b) => b.code === "PREFAB_INSTANTIATION_REQUIRED"),
    ).toBe(true);
    for (const id of ["R1", "R2"]) {
      const d = compiled.find((d) => d.instance_id === id)!;
      expect(d.contract.type_specific_contract.urdf.joints).toHaveLength(6);
      const declared = json(`device/${id}.json`).model.urdf.joints;
      for (const [
        index,
        joint,
      ] of d.contract.type_specific_contract.urdf.joints.entries()) {
        expect(joint.axis).toEqual(declared[index].axis);
        expect(joint.limit).toEqual(declared[index].limit);
      }
      expect(
        d.contract.type_specific_contract.tooling.tcp_local_frame.position,
      ).toEqual([0, 0, 0]);
    }
  });
  it("routes far gray output to C4 and near brown output to C3", () => {
    const calls: Record<string, unknown>[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.kind === "invoke") calls.push(record);
        Object.values(record).forEach(visit);
      }
    };
    visit(bundle.process.body);
    for (const [node, target] of [
      ["R1_pick_place", "C4"],
      ["R2_pick_place", "C3"],
    ]) {
      const call = calls.find((c) => c.id === node)!;
      const payload = call.payload as { kwargs: { target: unknown } };
      expect(payload.kwargs.target).toEqual({
        kind: "field",
        base: { kind: "ref", name: target },
        field: "entry",
      });
    }
    const goal = json("task-spec.json");
    expect(goal.expected.material_count).toBe(36);
    for (const delivery of goal.all[0].items) {
      expect(delivery.target).toBe(
        delivery.category === "A" ? "C4.exit" : "C3.exit",
      );
    }
    expect(
      bundle.blockers.some((b) => b.code === "NODE_BINDING_REQUIRED"),
    ).toBe(false);
  });
});
