import { test, expect } from "@playwright/test";

test("warehouse import, physical preparation, pause, stop and reset", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "场景", exact: true }).click();
  await page
    .getByRole("button", { name: /S07：四件分层入库后按订单出库/ })
    .click();
  await expect(
    page.getByRole("tab", { name: "PLC", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "准备候选仿真", exact: true }).click();
  const panel = page.getByRole("region", { name: "场景运行" });
  await expect(panel).toContainText("ready", { timeout: 30000 });
  await panel.getByRole("button", { name: "运行", exact: true }).click();
  await expect(panel).toContainText("running");
  await expect(panel).toContainText(/tick [1-9]/);
  await panel.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(panel).toContainText("paused");
  const text = await panel.textContent();
  await page.waitForTimeout(200);
  expect(await panel.textContent()).toBe(text);
  await page.screenshot({ path: "test-results/warehouse-paused.png" });
  await panel.getByRole("button", { name: "继续", exact: true }).click();
  await panel.getByRole("button", { name: "停止", exact: true }).click();
  await expect(panel).toContainText("cancelled", { timeout: 30000 });
  await panel.getByRole("button", { name: "重置", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "准备候选仿真", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
