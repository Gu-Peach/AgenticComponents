import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(root, "../test1/docs");
await mkdir(path.join(root, "src/data"), { recursive: true });
await mkdir(path.join(root, "public/catalog/examples"), { recursive: true });
await copyFile(
  path.join(source, "parameter_contract_examples.json"),
  path.join(root, "src/data/parameter-examples.json"),
);
for (const name of [
  "conveyor_1",
  "robot_arm_1",
  "workpiece_1",
  "carrier_tray_1",
]) {
  await copyFile(
    path.join(source, `scene1/device_specs/${name}.json`),
    path.join(root, `public/catalog/examples/${name}.json`),
  );
}
console.log(
  "已同步参数范式与四份 DeviceSpec 发布副本，请运行 npm test 检查契约兼容性。",
);
