import {
  readdir,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
// Python also builds scene snapshots, so both catalogs use the same profile resolver.
execFileSync(
  "python",
  [
    "-B",
    fileURLToPath(new URL("./lib/device_library.py", import.meta.url)),
    "--models",
  ],
  {
    stdio: "inherit",
  },
);
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
const target = path.join(root, "index.json");
const contents = JSON.stringify({ version: 1, entries }, null, 2) + "\n";
const previous = await readFile(target, "utf8").catch((error) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
if (previous !== contents) {
  const temporary = path.join(root, ".index." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
console.log(`Published ${entries.length} public model packages`);
