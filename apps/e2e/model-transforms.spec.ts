import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("neighboring conveyor interfaces snap and persist", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const card = page
    .locator(".asset-card")
    .filter({ hasText: "Conveyor_aankws" });
  await expect(card).toBeVisible();
  await card.click();
  await page.getByRole("button", { name: "添加到现场", exact: true }).click();
  const set = async (field: string, value: string) => {
    const input = page.getByLabel(field, { exact: true });
    await input.fill(value);
    await input.press("Tab");
  };
  await set("position-X", "0");
  await set("position-Z", "0");
  await card.click();
  await page.getByRole("button", { name: "添加到现场", exact: true }).click();
  await set("position-X", "1.55");
  await set("position-Z", "0");
  await page.getByText("模型节点与类型结构", { exact: true }).click();
  await expect(page.locator(".node-list")).toContainText("Mesh");
  await expect(
    page.getByRole("button", { name: "移动模型", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "旋转模型", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "旋转模型", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "移动模型", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "吸附到邻近接口", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "吸附到邻近接口", exact: true })
    .click();
  await expect(page.getByLabel("position-X", { exact: true })).toHaveValue(
    "1.5",
  );
  await page.getByRole("button", { name: "定位", exact: true }).click();
  await page.screenshot({ path: "test-results/model-snapping.png" });
  await page.getByText("文件", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目数据", exact: true }).click();
  const exported = JSON.parse(
    await readFile(await (await download).path(), "utf8"),
  );
  expect(exported.connections).toHaveLength(1);
  await set("position-X", "2");
  await page.getByText("文件", { exact: true }).click();
  const download2 = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目数据", exact: true }).click();
  const moved = JSON.parse(
    await readFile(await (await download2).path(), "utf8"),
  );
  expect(moved.connections).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("axis dragging commits on release and Escape cancels the next drag", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const card = page
    .locator(".asset-card")
    .filter({ hasText: "Conveyor_aankws" });
  await card.click();
  await page.getByRole("button", { name: "添加到现场", exact: true }).click();
  await page.getByText("模型节点与类型结构", { exact: true }).click();
  await expect(page.locator(".node-list")).toContainText("Mesh");
  await page.getByRole("button", { name: "定位", exact: true }).click();
  const input = page.getByLabel("position-X", { exact: true });
  const before = await input.inputValue();
  const box = (await page.locator("canvas").boundingBox())!;
  const drag = async (distance: number) => {
    await page.mouse.move(box.x + box.width * 0.54, box.y + box.height * 0.63);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width * 0.54 + distance,
      box.y + box.height * 0.63 + distance * 0.34,
      { steps: 10 },
    );
  };
  await drag(60);
  await expect(input).toHaveValue(before);
  await page.mouse.up();
  await expect.poll(() => input.inputValue()).not.toBe(before);
  const moved = await input.inputValue();
  await page.getByRole("button", { name: "定位", exact: true }).click();
  await drag(35);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(input).toHaveValue(moved);
  await page.screenshot({ path: "test-results/model-transform-drag.png" });
  expect(errors).toEqual([]);
});
