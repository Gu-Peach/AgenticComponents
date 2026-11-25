import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openAssetFolder } from "./asset-library";

test("keeps the asset and scene trees in separate panes and exposes the categorized catalog", async ({
  page,
}) => {
  await page.goto("/");
  const assets = page.getByRole("region", { name: "资产库", exact: true });
  const scenes = page.getByRole("region", { name: "场景库", exact: true });
  await expect(assets).toBeVisible();
  await expect(scenes).toBeVisible();
  const upper = await assets.boundingBox(),
    lower = await scenes.boundingBox();
  if (!upper || !lower) throw new Error("左侧面板未显示");
  expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y + 1);
  for (const category of [
    "全部资产",
    "传送带",
    "升降台",
    "直线滑轨",
    "出料口",
    "机械臂",
    "旋转台",
    "仓储柜",
    "加工机床",
    "搬运人员",
    "物料",
  ]) {
    await expect(
      assets.getByRole("button", { name: category, exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
  }

  const cargo = await openAssetFolder(page, "物料");
  await expect(
    cargo.getByRole("button", { name: "物料", exact: true }),
  ).toBeVisible();
  await expect(
    cargo.getByRole("button", { name: "物料托盘", exact: true }),
  ).toBeVisible();
  await expect(
    cargo.getByRole("button", { name: /Engine block/ }),
  ).toBeVisible();
  const search = assets.getByRole("textbox", { name: "搜索资产目录" });
  await search.fill("UR10");
  await expect(assets.getByRole("button", { name: /robot_UR10/ })).toHaveCount(
    1,
  );
  await expect(cargo).toBeHidden();
  await expect(scenes.getByRole("button", { name: /^S07：/ })).toBeVisible();
  await search.clear();
  await cargo.getByRole("button", { name: "物料托盘", exact: true }).dblclick();
  await expect(page.getByLabel("设备名称")).toHaveValue(/物料托盘 09/);
  await expect(
    scenes.getByRole("button", { name: "物料托盘 09", exact: true }),
  ).toBeVisible();
});

test("browses and searches scene folders in the asset tree before importing a scene", async ({
  page,
}) => {
  const sceneModels: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/scene/") && url.pathname.endsWith(".glb"))
      sceneModels.push(url.pathname);
  });
  await page.goto("/");
  const library = page.getByRole("region", { name: "场景库" });
  const warehouseName = "S07：四件分层入库后按订单出库";
  const warehouse = library.getByRole("button", {
    name: warehouseName,
    exact: true,
  });
  const welding = library.getByRole("button", {
    name: "S11：人工搬运与转台分度焊接",
    exact: true,
  });
  const importWarehouse = library.getByRole("button", {
    name: "导入 S07 整场景",
    exact: true,
  });

  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(
    page.getByRole("tab", { name: "资产", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /终端/ })).toBeVisible();
  await expect(warehouse).toHaveAttribute("aria-expanded", "false");
  await expect(importWarehouse).toBeHidden();
  await warehouse.click();
  await expect(library).toContainText("STORE");
  await welding.click();
  await expect(welding).toHaveAttribute("aria-expanded", "true");
  await expect(warehouse).toHaveAttribute("aria-expanded", "true");
  await warehouse.click();
  await expect(welding).toHaveAttribute("aria-expanded", "true");

  const search = library.getByRole("textbox", { name: "搜索场景" });
  await search.fill("STORE");
  await expect(welding).toBeHidden();
  await expect(warehouse).toBeVisible();
  await expect(library).toContainText("STORE");
  await search.clear();
  await expect(welding).toHaveAttribute("aria-expanded", "true");
  await expect(warehouse).toHaveAttribute("aria-expanded", "false");

  await warehouse.click();
  expect(sceneModels).toEqual([]);
  await expect(
    page.getByRole("tab", { name: "PLC", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await importWarehouse.click();
  await expect(
    page.getByRole("tab", { name: "PLC", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const projectScene = page.getByRole("button", {
    name: warehouseName + " · 场景",
    exact: true,
  });
  await expect(projectScene).toHaveAttribute("aria-expanded", "false");
  await library
    .getByRole("button", { name: "可导入场景", exact: true })
    .click();
  await projectScene.click();
  await expect(projectScene).toHaveAttribute("aria-expanded", "true");
  const rack = library.getByRole("button", { name: "选择 STORE", exact: true });
  await rack.click();
  await expect(rack).toHaveAttribute("aria-pressed", "true");
  await library
    .getByRole("button", { name: "隐藏 STORE", exact: true })
    .click();
  await expect(
    library.getByRole("button", { name: "显示 STORE", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "场景运行" })).toContainText(
    "场景运行",
  );
  await page.getByText("文件", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目数据", exact: true }).click();
  const saved = JSON.parse(
    await readFile(await (await download).path(), "utf8"),
  );
  expect(saved.scenePackages[0].hiddenDeviceIds).toContain("STORE");
  await library
    .getByRole("button", { name: "显示 STORE", exact: true })
    .click();
  await projectScene.click();
  await expect(rack).toBeHidden();
});
