import { test, expect } from "@playwright/test";
test("selection, parameters, preview, docking and persistence", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "待接入动作实现" }),
  ).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await page.getByLabel("capacity", { exact: true }).fill("0");
  await page.getByLabel("capacity", { exact: true }).press("Tab");
  await expect(page.locator(".error-banner")).toContainText("超出范围");
  await page.getByLabel("capacity", { exact: true }).fill("5");
  await page.getByLabel("capacity", { exact: true }).press("Tab");
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await page.getByLabel("演示模式").check();
  await page.getByRole("button", { name: "启动演示预览" }).click();
  await expect(page.locator(".statusbar")).toContainText("running");
  await page.getByRole("button", { name: "暂停预览", exact: true }).click();
  await expect(page.locator(".statusbar")).toContainText("paused");
  await expect(page.getByLabel("capacity", { exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "PLC", exact: true }).click();
  await page.getByRole("tab", { name: /终端/ }).click();
  await expect(page.locator(".statusbar")).toContainText("paused");
  await page.getByRole("button", { name: "停止预览", exact: true }).click();
  await expect(page.locator(".statusbar")).toContainText("cancelled");
  await page.getByLabel("应用命令").fill("save");
  await page.getByLabel("应用命令").press("Enter");
  await expect(page.locator(".statusbar")).toContainText("本地项目");
  await page.reload();
  await expect(page.getByLabel("capacity", { exact: true })).toHaveValue("5");
  await page.getByRole("tab", { name: "资产", exact: true }).click(); // collapse or open does not affect selection
  await expect(page.getByLabel("设备名称")).toHaveValue("传送带 01");
  expect(errors).toEqual([]);
});
test("asset insertion, old spec import, project export and responsive shell", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".asset-card")).toHaveCount(9);
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.locator(".scene-label")).toBeVisible();
  await page.screenshot({ path: "test-results/workbench-1440.png" });
  await page.getByRole("button", { name: "机械臂 待配置模板" }).click();
  await page.getByRole("button", { name: "添加到现场" }).click();
  await expect(page.locator(".statusbar")).toContainText("9 个实例");
  await expect(page.getByLabel("设备名称")).toHaveValue("机械臂 09");
  await page.getByLabel("导入已有样例").selectOption("robot_arm_1");
  await expect(page.locator(".asset-card")).toHaveCount(10);
  await page.getByRole("tab", { name: "PLC", exact: true }).click();
  await page.getByLabel("PLC 程序").fill("PROGRAM Main\nEND_PROGRAM");
  await page.getByText("文件", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目数据", exact: true }).click();
  expect((await download).suggestedFilename()).toContain(".json");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator("canvas")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/workbench-1280.png" });
});
function triangleGlb() {
  const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const source = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: "PreviewTestNode", mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: bin.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
    }),
  );
  const json = Buffer.concat([
    source,
    Buffer.alloc((4 - (source.length % 4)) % 4, 32),
  ]);
  const out = Buffer.alloc(12 + 8 + json.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  json.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + json.length);
  out.writeUInt32LE(0x004e4942, 24 + json.length);
  bin.copy(out, 28 + json.length);
  return out;
}
test("GLB import survives local save and reload, invalid imports leave scene intact", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".asset-card")).toHaveCount(9);
  await page.getByText("文件", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "为选中设备关联 GLB" }).click();
  await (
    await chooser
  ).setFiles({
    name: "fixture.glb",
    mimeType: "model/gltf-binary",
    buffer: triangleGlb(),
  });
  await page.getByText("模型节点与类型结构", { exact: true }).click();
  await expect(page.locator(".node-list")).toContainText("PreviewTestNode");
  await page.getByText("文件", { exact: true }).click();
  await page.getByRole("button", { name: /保存到浏览器/ }).click();
  await expect(page.locator(".statusbar")).toContainText("本地项目");
  await page.reload();
  await page.getByText("模型节点与类型结构", { exact: true }).click();
  await expect(page.locator(".node-list")).toContainText("PreviewTestNode");
  await page.getByText("文件", { exact: true }).click();
  const bad = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入项目 JSON" }).click();
  await (
    await bad
  ).setFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":999}'),
  });
  await expect(page.locator(".toast")).toBeVisible();
  await expect(page.locator(".statusbar")).toContainText("8 个实例");
  expect(errors).toEqual([]);
});
