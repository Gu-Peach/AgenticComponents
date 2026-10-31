import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
async function blank(page: Page) {
  await page.getByText("文件", { exact: true }).click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(page.locator(".tree-select")).toHaveCount(0);
}
async function add(page: Page, label: string) {
  await page.locator(".asset-card").filter({ hasText: label }).click();
  await page.getByRole("button", { name: "添加到现场", exact: true }).click();
  await expect(page.getByLabel("设备名称")).toHaveValue(new RegExp(label));
}
async function transform(page: Page, p: number[], ry = 0) {
  for (let i = 0; i < 3; i++) {
    const input = page.getByLabel(`position-${"XYZ"[i]}`, { exact: true });
    await input.fill(String(p[i]));
    await input.press("Tab");
  }
  const r = page.getByLabel("rotation-Y", { exact: true });
  await r.fill(String(ry));
  await r.press("Tab");
}
async function exported(page: Page) {
  await page.getByText("文件", { exact: true }).click();
  const promise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目数据", exact: true }).click();
  return JSON.parse(await readFile(await (await promise).path(), "utf8"));
}
test("real robot joint movement, controlled hold, position IK, task and reset", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await blank(page);
  await add(page, "robot_UR10");
  await transform(page, [0, 0, 0]);
  await page.getByRole("button", { name: "定位", exact: true }).click();
  const before = await exported(page);
  await page
    .getByRole("button", { name: "准备机械臂预览", exact: true })
    .click();
  await expect(page.getByTestId("robot-status")).toContainText("running");
  const rest = await page.getByTestId("robot-joints").textContent();
  await page
    .getByLabel("机械臂关节目标", { exact: true })
    .fill("0.6, 0.1, 0, 0, 0, 0");
  await page.getByRole("button", { name: "执行关节运动", exact: true }).click();
  await expect
    .poll(() => page.getByTestId("robot-joints").textContent())
    .not.toBe(rest);
  await page.getByRole("button", { name: "减速保持", exact: true }).click();
  await expect(page.getByTestId("robot-status")).toContainText("holding");
  await expect(page.getByTestId("robot-request")).toContainText("busy");
  await page.getByRole("button", { name: "恢复运动", exact: true }).click();
  await expect(page.getByTestId("robot-request")).toContainText("succeeded");
  await page.getByRole("button", { name: "执行空载任务", exact: true }).click();
  await expect(page.getByTestId("robot-request")).toContainText("busy");
  await expect(page.getByTestId("robot-request")).toContainText("succeeded", {
    timeout: 15000,
  });
  const tcp = (await page.getByTestId("robot-tcp").textContent())!.replace(
    "TCP m: ",
    "",
  );
  await page.getByLabel("机械臂目标坐标系").selectOption("world");
  await page.getByLabel("机械臂TCP目标").fill(tcp);
  await page.getByRole("button", { name: "执行TCP定位", exact: true }).click();
  await expect(page.getByTestId("robot-request")).toContainText("succeeded");
  await page.getByRole("button", { name: "定位", exact: true }).click();
  await page.screenshot({ path: "test-results/robot-runtime.png" });
  expect(await exported(page)).toEqual(before);
  await page.getByRole("button", { name: "重置场景", exact: true }).click();
  await expect(page.getByTestId("robot-status")).toContainText("idle");
  await expect(page.getByLabel("position-X", { exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
test("real engine_block fixed-constraint grasp job releases onto selected belt", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await blank(page);
  await add(page, "robot_UR10");
  await transform(page, [0, 0, 0]);
  await add(page, "Conveyor_aankws");
  await transform(page, [0.099129, 0, -0.647548]);
  await add(page, "Engine block");
  await transform(page, [-0.020371, 0.7, -0.647548], 90);
  const mass = page.getByLabel("mass_kg", { exact: true });
  await mass.fill("1");
  await mass.press("Tab");
  await page.locator(".tree-select").filter({ hasText: "robot_UR10" }).click();
  await page.getByText("固定约束物理抓放", { exact: true }).click();
  await page.getByLabel("机械臂运行物料").selectOption({ index: 1 });
  await page.getByLabel("机械臂目标支承").selectOption({ index: 1 });
  const before = await exported(page);
  await page.getByRole("button", { name: "准备物理抓放", exact: true }).click();
  await expect(page.getByTestId("robot-status")).toContainText("running", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "执行抓放任务", exact: true }).click();
  await expect(page.getByTestId("robot-holding")).not.toContainText(
    "持有：无",
    { timeout: 30000 },
  );
  await page.getByRole("button", { name: "定位", exact: true }).click();
  await page.getByTestId("robot-holding").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/robot-grasp.png" });
  await expect(page.getByTestId("robot-request")).toContainText("succeeded", {
    timeout: 45000,
  });
  await expect(page.getByTestId("robot-holding")).toContainText("持有：无");
  expect(await exported(page)).toEqual(before);
  await page.getByRole("button", { name: "重置场景", exact: true }).click();
  expect(errors).toEqual([]);
});
