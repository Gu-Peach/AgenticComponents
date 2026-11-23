import { readFileSync } from "node:fs";
import { sceneBundleSchema } from "../src/contracts/scene-package";
export function warehouseFixture(count = 4) {
  const bundle = sceneBundleSchema.parse(
    JSON.parse(
      readFileSync("public/scene/S07/.generated/scene.bundle.json", "utf8"),
    ),
  );
  const goal = JSON.parse(
    readFileSync("public/scene/S07/task-spec.json", "utf8"),
  );
  const raw = readFileSync("public" + decodeURIComponent(bundle.model_url));
  const bytes = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  ) as ArrayBuffer;
  if (count !== 4) {
    const jobs = (bundle.process.task.jobs as { material: string }[]).slice(
        0,
        count,
      ),
      ids = jobs.map((j) => j.material);
    bundle.process.task.jobs = jobs;
    bundle.process.task.material_count = count;
    bundle.process.task.job_count = count;
    bundle.devices = bundle.devices.filter(
      (d) => d.asset_kind !== "runtime_material" || ids.includes(d.instance_id),
    );
    goal.expected.material_ids = ids;
    goal.expected.material_count = count;
    for (const g of goal.all)
      if (g.items)
        g.items = g.items.filter((i: { material: string }) =>
          ids.includes(i.material),
        );
  }
  return { bundle, goal, bytes };
}
