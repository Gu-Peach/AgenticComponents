import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { Matrix4, Vector3, Quaternion, PropertyBinding } from "three";
import { z } from "zod";
import { sceneBundleSchema } from "../src/contracts/scene-package";
import { fetchSceneBundle } from "../src/services/PublicSceneCatalog";
import { sceneIndexSchema } from "../src/contracts/scene-package";

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const root = "public/scene";
const entries = sceneIndexSchema.parse(read(root + "/index.json")).entries;
afterEach(() => vi.unstubAllGlobals());
describe("compact device authoring", () => {
  it("stores each runtime definition once and omits duplicate derived fields", () => {
    let count = 0;
    for (const entry of entries) {
      const scene = `${root}/${entry.id}`,
        manifest = read(scene + "/scene.json");
      for (const file of manifest.devices) {
        const device = read(scene + "/" + file);
        count++;
        expect(device.schema_version).toBe("scene-device/0.2");
        expect(device.contract_ref).toMatch(/^\.\.\/contracts\//);
        for (const field of [
          "contract",
          "signal_bindings",
          "condition_bindings",
          "robot_geometry",
          "geometry",
          "parameter_evidence",
        ]) {
          expect(Object.hasOwn(device, field)).toBe(false);
        }
      }
    }
    expect(count).toBe(152);
  });
  it("keeps exactly the eight implemented robot parameters and preserves unknown calibration", () => {
    const expected = [
      "joint_speed_rad_s",
      "joint_accel_rad_s2",
      "settle_speed_rad_s",
      "ik_position_tolerance_m",
      "ik_max_iterations",
      "ik_mode",
      "max_payload_kg",
      "lift_height",
    ].sort();
    const bundle = sceneBundleSchema.parse(
      read(root + "/S01/.generated/scene.bundle.json"),
    );
    for (const id of ["R1", "R2"]) {
      const device = bundle.devices.find((d) => d.instance_id === id)!;
      expect(Object.keys(device.parameters as object).sort()).toEqual(expected);
      expect(
        Object.keys(device.contract.params_schema as object).sort(),
      ).toEqual(expected);
      const model = z
        .object({
          urdf: z.object({
            joints: z.array(
              z.object({ axis: z.unknown(), limit: z.unknown() }),
            ),
          }),
        })
        .parse(device.contract.type_specific_contract);
      const declared = read(`${root}/S01/device/${id}.json`).model.urdf.joints;
      for (const [index, joint] of model.urdf.joints.entries()) {
        expect(joint.axis).toEqual(declared[index].axis);
        expect(joint.limit).toEqual(declared[index].limit);
      }
    }
    expect(bundle.executable).toBe(false);
  });
  it("derives rest transforms matching the original GLB without storing world matrices in R1", () => {
    const bytes = readFileSync(
      root + "/S01/assembly_order_index/assembly_order_index.glb",
    );
    const gltf = z
      .object({
        nodes: z.array(
          z.object({
            name: z.string().optional(),
            children: z.array(z.number()).optional(),
            matrix: z.array(z.number()).optional(),
            translation: z.array(z.number()).optional(),
            rotation: z.array(z.number()).optional(),
            scale: z.array(z.number()).optional(),
          }),
        ),
      })
      .parse(
        JSON.parse(
          bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"),
        ),
      );
    const parents = new Map<number, number>();
    gltf.nodes.forEach((n, i) => n.children?.forEach((c) => parents.set(c, i)));
    const world = (index: number): Matrix4 => {
      const n = gltf.nodes[index];
      const matrix = n.matrix
        ? new Matrix4().fromArray(n.matrix)
        : new Matrix4().compose(
            new Vector3().fromArray(n.translation ?? [0, 0, 0]),
            new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]),
            new Vector3().fromArray(n.scale ?? [1, 1, 1]),
          );
      return parents.has(index)
        ? matrix.premultiply(world(parents.get(index)!))
        : matrix;
    };
    const bundle = sceneBundleSchema.parse(
      read(root + "/S01/.generated/scene.bundle.json"),
    );
    const pose = z.object({
      rest_position: z.array(z.number()),
      rest_quaternion: z.array(z.number()),
    });
    const modelSchema = z.object({
      urdf: z.object({
        joints: z.array(pose.extend({ nodeName: z.string() })),
      }),
      tooling: pose.extend({ tcp_node_name: z.string() }),
    });
    for (const id of ["R1", "R2"]) {
      const source = read(`${root}/S01/device/${id}.json`);
      expect(JSON.stringify(source)).not.toContain("world_matrix");
      const device = bundle.devices.find((d) => d.instance_id === id)!;
      const model = modelSchema.parse(device.contract.type_specific_contract);
      const original = world(device.node_binding.node_indices[0]),
        position = new Vector3(),
        rotation = new Quaternion();
      original.decompose(position, rotation, new Vector3());
      const actual = new Matrix4().compose(
        position,
        rotation,
        new Vector3(1, 1, 1),
      );
      const check = (name: string) => {
        const index = gltf.nodes.findIndex(
          (n) => PropertyBinding.sanitizeNodeName(n.name ?? "") === name,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        expect(
          new Vector3()
            .setFromMatrixPosition(actual)
            .distanceTo(new Vector3().setFromMatrixPosition(world(index))),
        ).toBeLessThan(1e-6);
      };
      for (const joint of model.urdf.joints) {
        actual.multiply(
          new Matrix4().compose(
            new Vector3().fromArray(joint.rest_position),
            new Quaternion().fromArray(joint.rest_quaternion),
            new Vector3(1, 1, 1),
          ),
        );
        check(joint.nodeName);
      }
      actual.multiply(
        new Matrix4().compose(
          new Vector3().fromArray(model.tooling.rest_position),
          new Quaternion().fromArray(model.tooling.rest_quaternion),
          new Vector3(1, 1, 1),
        ),
      );
      check(model.tooling.tcp_node_name);
    }
  });
  it("checks shared contract hashes when loading generated packages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            url.endsWith("/contracts/robot_arm.json")
              ? "changed"
              : readFileSync("public" + decodeURIComponent(url)),
          ),
      ),
    );
    await expect(fetchSceneBundle(entries[0])).rejects.toThrow("哈希");
  });
});
