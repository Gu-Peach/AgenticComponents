import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("physical conveyor experiment, pause, arrival and reset", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const card = page
    .locator(".asset-card")
    .filter({ hasText: "Conveyor_aankws" });
  await expect(card).toBeVisible();
  await card.click();
  await page.getByRole("button", { name: "添加到现场", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "启动输送实验", exact: true }),
  ).toBeEnabled();
  const exportProject = async () => {
    await page.getByText("文件", { exact: true }).click();
    const promise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出项目数据", exact: true })
      .click();
    return JSON.parse(await readFile(await (await promise).path(), "utf8"));
  };
  const before = await exportProject();
  await page.getByRole("button", { name: "启动输送实验", exact: true }).click();
  await expect(page.getByTestId("simulation-status")).toContainText("running", {
    timeout: 30000,
  });
  await expect(page.getByLabel("position-X", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "暂停场景", exact: true }).click();
  await expect(page.getByTestId("simulation-status")).toContainText("paused");
  const paused = await page.getByTestId("material-position").textContent();
  await page.getByRole("button", { name: "继续场景", exact: true }).click();
  await expect
    .poll(() => page.getByTestId("material-position").textContent())
    .not.toBe(paused);
  await expect(page.getByTestId("arrival-status")).toContainText("succeeded", {
    timeout: 15000,
  });
  await page.screenshot({ path: "test-results/conveyor-runtime.png" });
  const after = await exportProject();
  expect(after).toEqual(before);
  await page.getByRole("button", { name: "重置场景", exact: true }).click();
  await expect(page.getByTestId("simulation-status")).toContainText("idle");
  await expect(page.getByTestId("material-position")).toHaveCount(0);
  await expect(page.getByLabel("position-X", { exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
