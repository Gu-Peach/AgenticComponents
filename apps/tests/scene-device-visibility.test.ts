import { readFileSync } from "node:fs";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector3,
} from "three";
import { expect, it } from "vitest";
import {
  sceneBundleSchema,
  sceneMeshOwners,
} from "../src/contracts/scene-package";
import {
  raycastScenePackage,
  sceneDeviceMaterials,
  applyDeviceVisibility,
  highlightDevice,
} from "../src/renderer/sceneDeviceMaterials";

it("maps an imported warehouse row to only its owned geometry and preserves runtime visibility", () => {
  const bundle = sceneBundleSchema.parse(
    JSON.parse(
      readFileSync("public/scene/S07/.generated/scene.bundle.json", "utf8"),
    ),
  );
  const owners = sceneMeshOwners(bundle);
  function nodeIndex(id: string) {
    const device = bundle.devices.find((d) => d.instance_id === id)!;
    return (device.node_binding.owned_mesh_indices as number[])[0];
  }
  const glb = new Group();
  const railMat = new MeshStandardMaterial();
  const liftMat = new MeshStandardMaterial();
  const material = new MeshStandardMaterial();
  const tinted = material.emissive.getHex();
  const rail = new Mesh(undefined, railMat);
  rail.userData.sceneNodeIndex = nodeIndex("T1");
  const liftGroup = new Group();
  liftGroup.userData.sceneNodeIndex = nodeIndex("L1");
  const lift = new Mesh(undefined, liftMat);
  liftGroup.add(lift);
  rail.add(liftGroup);
  const part = new Mesh(undefined, material);
  part.userData.sceneNodeIndex = nodeIndex("M01");
  glb.add(rail, part);
  const groups = sceneDeviceMaterials(glb, owners);
  const restoreRail = applyDeviceVisibility(groups, ["T1"]);
  expect(railMat.visible).toBe(false);
  expect(liftMat.visible).toBe(true);
  restoreRail();
  expect(railMat.visible).toBe(true);
  const restoreParts = applyDeviceVisibility(groups, ["Workpiece"]);
  const spawned = part.clone();
  expect(spawned.material.visible).toBe(false);
  spawned.visible = false; // The physics bridge separately controls admission.
  restoreParts();
  expect(spawned.material.visible).toBe(true);
  expect(spawned.visible).toBe(false);
  const clear = highlightDevice(groups.get("Workpiece"));
  expect(material.emissive.getHex()).not.toBe(tinted);
  expect(liftMat.emissive.getHex()).toBe(tinted);
  clear();
  expect(material.emissive.getHex()).toBe(tinted);
});

it("picks through a hidden package member to the visible device behind it", () => {
  const scenePackage = new Group();
  scenePackage.raycast = raycastScenePackage;
  const device = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  const behind = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  device.position.z = 1;
  behind.position.z = -1;
  scenePackage.add(device);
  scenePackage.updateMatrixWorld(true);
  behind.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(0.1, 0, 5), new Vector3(0, 0, -1));
  const firstHit = () =>
    ray.intersectObjects([scenePackage, behind], true)[0]?.object;
  expect(firstHit()).toBe(device);
  device.material.visible = false;
  expect(firstHit()).toBe(behind);
  expect(ray.intersectObject(scenePackage, true)).toEqual([]);
  device.material.visible = true;
  expect(firstHit()).toBe(device);
  scenePackage.visible = false;
  expect(firstHit()).toBe(behind);
});
