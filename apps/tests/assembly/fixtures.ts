import { readFileSync } from "node:fs";
import { sceneBundleSchema } from "../../src/contracts/scene-package";
export function sceneFixture(scene: "S01" | "S02" | "S04" = "S01") {
  const folder = `public/scene/${scene}`;
  const bundle = sceneBundleSchema.parse(
    JSON.parse(readFileSync(`${folder}/.generated/scene.bundle.json`, "utf8")),
  );
  const model = readFileSync("public" + decodeURIComponent(bundle.model_url));
  const bytes = model.buffer.slice(
    model.byteOffset,
    model.byteOffset + model.byteLength,
  ) as ArrayBuffer;
  const goal = JSON.parse(readFileSync(`${folder}/task-spec.json`, "utf8"));
  return { bundle, bytes, goal };
}
