import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { warehouseFixture } from "./warehouse-fixtures";
import { compileSceneRuntime } from "../src/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "../src/runtime/assembly/SceneRuntimeAssembler";

for (const count of [1, 3, 4])
  it(`warehouse validates ${count} real GLB boxes against independent goals`, async () => {
    const { bundle, goal, bytes } = warehouseFixture(count),
      compiled = compileSceneRuntime(bundle, bytes, goal, "validation");
    const { program } = await assembleSceneRuntime(
      "warehouse-test",
      "warehouse-run",
      compiled,
    );
    program.start();
    let s = program.snapshot();
    for (let i = 0; i < 72000 && program.needsStep(); i++)
      s = program.step(1 / 60);
    const world = s.observations.samples["world/state"]?.value as {
      receipts: unknown[];
      inventory: { events: unknown[]; occupancy: object; reservations: object };
    };
    if (process.env.AC_WAREHOUSE_REPORT)
      writeFileSync(
        process.env.AC_WAREHOUSE_REPORT + `-${count}.json`,
        JSON.stringify(
          {
            count,
            modelSha256: bundle.model_sha256,
            sourceHashes: bundle.source_hashes,
            scope:
              count === 4
                ? "original task, expected unreachable fourth level"
                : "independent reachable subset fixture",
            status: s.status,
            error: s.error,
            ticks: s.tick,
            process: s.process,
            world,
          },
          null,
          2,
        ),
      );
    if (count === 4) {
      expect(s.status).toBe("failed");
      expect(s.error).toContain("TARGET_UNREACHABLE");
      expect(world.inventory.events).toHaveLength(3);
      expect(world.receipts).toHaveLength(0);
      expect(
        s.process.activations.find((a) => a.requestId === "31")?.state,
      ).toBe("failed");
      const state = s.observations.samples["world/state"].value as {
        mounts: Record<string, { held?: string; lift: number }>;
        bodies: Record<string, { pose?: { position: number[] } }>;
      };
      expect(state.mounts.L1.held).toBe("M04");
      expect(state.mounts.L1.lift).toBeLessThan(0);
      console.log(`S07 original 4-box task: safely rejected at tick ${s.tick}`);
      program.dispose();
      return;
    }
    expect(
      s.status,
      JSON.stringify({
        error: s.error,
        tick: s.tick,
        active: s.process.activations.slice(-8),
        inventory: world.inventory,
      }),
    ).toBe("succeeded");
    expect(world.receipts).toHaveLength(count);
    expect(world.inventory.events).toHaveLength(count * 2);
    expect(world.inventory.occupancy).toEqual({});
    expect(world.inventory.reservations).toEqual({});
    expect(s.process.resources).toEqual({});
    console.log(`S07 ${count} boxes: ${s.tick} ticks`);
    program.dispose();
  }, 120000);
