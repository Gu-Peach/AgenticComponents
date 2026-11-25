import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { importSceneFromLibrary } from "./scene-library";

interface ExportedProject {
  id: string;
  name: string;
  instances: { instanceId: string }[];
  scenePackages?: { id: string; bundle: { id: string } }[];
  connections?: unknown[];
  definitions: { specId: string }[];
  assets: { id: string }[];
  plc: string;
}
async function exported(page: Page): Promise<ExportedProject> {
  await page.getByText("文件", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目数据", exact: true }).click();
  const path = await (await download).path();
  if (!path) throw new Error("项目导出未完成");
  return JSON.parse(await readFile(path, "utf8")) as ExportedProject;
}

test("replaces a scene only after a valid import and clears placed content while retaining the asset catalog", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const scenes = page.getByRole("region", { name: "场景库" });
  const clear = scenes.getByRole("button", { name: "清理场景", exact: true });
  await expect(clear).toBeEnabled();
  await page.getByLabel("PLC 程序").fill("PROGRAM Previous\nEND_PROGRAM");
  const initial = await exported(page);
  expect(initial.instances.length).toBeGreaterThan(0);

  await importSceneFromLibrary(page, "S11");
  const welding = scenes.getByRole("button", {
    name: "S11：人工搬运与转台分度焊接 · 场景",
    exact: true,
  });
  await expect(welding).toBeVisible();
  const first = await exported(page);
  expect(first.id).toBe(initial.id);
  expect(first.name).toBe(initial.name);
  expect(first.instances).toEqual([]);
  expect(first.scenePackages?.map((scene) => scene.bundle.id)).toEqual(["S11"]);
  expect(first.connections ?? []).toEqual([]);
  expect(first.plc).toBe("");
  expect(first.definitions).toEqual(initial.definitions);

  const brokenModel = /\/scene\/S07\/.*\.glb$/;
  await page.route(brokenModel, (route) =>
    route.fulfill({ status: 503, body: "Model temporarily unavailable" }),
  );
  await importSceneFromLibrary(page, "S07");
  await expect(scenes.getByRole("alert")).toContainText("场景资源读取失败");
  await expect(welding).toBeVisible();
  expect(await exported(page)).toEqual(first);
  await page.unroute(brokenModel);

  await importSceneFromLibrary(page, "S07");
  const warehouse = scenes.getByRole("button", {
    name: "S07：四件分层入库后按订单出库 · 场景",
    exact: true,
  });
  await expect(warehouse).toBeVisible();
  await expect(welding).toBeHidden();
  const second = await exported(page);
  expect(second.instances).toEqual([]);
  expect(second.scenePackages?.map((scene) => scene.bundle.id)).toEqual([
    "S07",
  ]);

  await warehouse.click();
  await scenes.getByRole("button", { name: "选择 STORE", exact: true }).click();
  await clear.click();
  await expect(warehouse).toBeHidden();
  await expect(page.getByRole("region", { name: "场景运行" })).toBeHidden();
  await expect(page.getByLabel("PLC 程序")).toHaveValue("");
  const empty = await exported(page);
  expect(empty.id).toBe(initial.id);
  expect(empty.name).toBe(initial.name);
  expect(empty.instances).toEqual([]);
  expect(empty.scenePackages ?? []).toEqual([]);
  expect(empty.connections ?? []).toEqual([]);
  expect(empty.definitions).toEqual(initial.definitions);
  expect(empty.assets).toEqual(second.assets);
  await expect(clear).toBeDisabled();

  await importSceneFromLibrary(page, "S11");
  await expect(welding).toBeVisible();
  expect(
    (await exported(page)).scenePackages?.map((scene) => scene.bundle.id),
  ).toEqual(["S11"]);
  expect(errors).toEqual([]);
});
