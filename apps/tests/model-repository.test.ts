import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Mesh, MeshStandardMaterial } from "three";
import { projectRepository } from "../src/services/BrowserProjectRepository";
import { acquireModel } from "../src/services/ModelRepository";
it("shares parsed geometry while isolating instance materials and releasing ownership", async () => {
  const spy = vi
    .spyOn(projectRepository, "getAsset")
    .mockResolvedValue(
      new Blob([
        readFileSync("public/modles/Conveyor_aankws/Conveyor_aankws.glb"),
      ]),
    );
  const [a, b] = await Promise.all([
    acquireModel("isolation-test"),
    acquireModel("isolation-test"),
  ]);
  const find = (root: typeof a.root) => {
    let mesh: Mesh | undefined;
    root.traverse((o) => {
      if (!mesh && o instanceof Mesh) mesh = o;
    });
    return mesh!;
  };
  const ma = find(a.root),
    mb = find(b.root);
  expect(ma.geometry).toBe(mb.geometry);
  expect(ma.material).not.toBe(mb.material);
  const matA = ma.material as MeshStandardMaterial,
    matB = mb.material as MeshStandardMaterial;
  const original = matB.emissive.getHex();
  matA.emissive.setHex(0xff8800);
  expect(matB.emissive.getHex()).toBe(original);
  a.release();
  expect(mb.material).toBe(matB);
  b.release();
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
