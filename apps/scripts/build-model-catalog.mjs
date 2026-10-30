import { readdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../public/modles/", import.meta.url));
const hash = (b) => createHash("sha256").update(b).digest("hex");
const entries = [];
const ids = new Set();
for (const dir of (await readdir(root, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))) {
  const folder = path.join(root, dir.name),
    schemaPath = path.join(folder, "schema.json");
  const bytes = await readFile(schemaPath);
  const s = JSON.parse(bytes.toString("utf8"));
  if (
    !s.device_spec_id ||
    !s.version ||
    !s.display_name ||
    !s.device_type ||
    s.asset?.model_format !== "glb"
  )
    throw new Error(`${schemaPath}: missing device metadata`);
  const model = await realpath(path.resolve(folder, s.asset.model_key));
  const base = await realpath(folder);
  if (
    !model.startsWith(base + path.sep) ||
    path.extname(model).toLowerCase() !== ".glb"
  )
    throw new Error(`${schemaPath}: invalid model path`);
  const glb = await readFile(model),
    modelSha256 = hash(glb);
  if (s.asset.sha256 && s.asset.sha256 !== modelSha256)
    throw new Error(`${schemaPath}: model hash mismatch`);
  if (ids.has(s.device_spec_id))
    throw new Error(`${schemaPath}: duplicate device ID`);
  ids.add(s.device_spec_id);
  const url = (p) =>
    "/modles/" +
    path.relative(root, p).split(path.sep).map(encodeURIComponent).join("/");
  entries.push({
    packageKey: dir.name,
    specId: s.device_spec_id,
    revision: s.version,
    name: s.display_name,
    deviceType: s.device_type,
    schemaUrl: url(schemaPath),
    modelUrl: url(model),
    schemaSha256: hash(bytes),
    modelSha256,
  });
}
await writeFile(
  path.join(root, "index.json"),
  JSON.stringify({ version: 1, entries }, null, 2) + "\n",
);
console.log(`Published ${entries.length} public model packages`);
