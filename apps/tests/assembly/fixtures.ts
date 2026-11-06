import { readFileSync } from "node:fs";
import { sceneBundleSchema } from "../../src/contracts/scene-package";
export function sceneFixture() {
  const bundle = sceneBundleSchema.parse(
    JSON.parse(
      readFileSync("public/scene/S01/.generated/scene.bundle.json", "utf8"),
    ),
  );
  const model = readFileSync("public" + decodeURIComponent(bundle.model_url));
  const bytes = model.buffer.slice(
    model.byteOffset,
    model.byteOffset + model.byteLength,
  ) as ArrayBuffer;
  const goal = JSON.parse(
    readFileSync("public/scene/S01/task-spec.json", "utf8"),
  );
  return { bundle, bytes, goal };
}
