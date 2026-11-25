import { expect, test } from "@playwright/test";
import { importSceneFromLibrary } from "./scene-library";
test("extracts a mounted pair and runs its numeric DSL from the standalone rail inspector", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await importSceneFromLibrary(page, "S07");
  await page.getByRole("button", { name: "提取独立设备 · T1 / L1" }).click();
  const panel = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "挂载定位" }) })
    .last();
  const position = panel.getByLabel("滑轨目标位置（m）");
  await position.fill("-0.55");
  await panel.getByLabel("平台目标高度（m）").fill("1");
  await panel.getByRole("button", { name: "运行挂载定位" }).click();
  await expect(panel.getByRole("status")).toContainText("running", {
    timeout: 30000,
  });
  await expect(position).toBeDisabled();
  await panel.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("paused");
  await panel.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("succeeded", {
    timeout: 45000,
  });
  await expect(panel).toContainText("-0.550 m");
  await expect(panel).toContainText("1.000 m");
  await panel.getByRole("button", { name: "退出仿真" }).click();
  await expect(position).toBeEnabled();
  expect(errors).toEqual([]);
});
