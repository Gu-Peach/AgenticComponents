import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function addModel(page: Page, name: string, position: number[], yaw = 0) {
  await page.locator(".asset-card").filter({ hasText: name }).click();
  await page.getByRole("button", { name: "添加到现场", exact: true }).click();
  await expect(page.getByLabel("设备名称")).toHaveValue(new RegExp(name));
  for (const [index, value] of position.entries()) {
    const field = page.getByLabel("position-" + "XYZ"[index], { exact: true });
    await field.fill(String(value));
    await field.press("Tab");
  }
  if (yaw) {
    const field = page.getByLabel("rotation-Y", { exact: true });
    await field.fill(String(yaw));
    await field.press("Tab");
  }
}

async function exportProject(page: Page) {
  await page.getByText("文件", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目数据", exact: true }).click();
  return JSON.parse(await readFile(await (await download).path(), "utf8"));
}

test("composes transport and pick/place from separately imported model instances", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByText("文件", { exact: true }).click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(page.locator(".tree-select")).toHaveCount(0);

  await addModel(page, "robot_UR10", [0, 0, 0]);
  // The conveyor exit and its center must both be within reach of the arm.
  await addModel(page, "Conveyor_aankws", [-0.160371, 0, -0.647548]);
  await addModel(page, "Engine block", [-0.310371, 0.7, -0.647548], 90);
  const mass = page.getByLabel("mass_kg", { exact: true });
  await mass.fill("1");
  await mass.press("Tab");
  await page
    .locator(".tree-select")
    .filter({ hasText: "Conveyor_aankws" })
    .click();
  await page.getByText("组合工艺 · 输送后抓放", { exact: true }).click();
  const armSelect = page.getByLabel("组合工艺机械臂");
  const supportSelect = page.getByLabel("组合工艺放料支承");
  await armSelect.selectOption({ index: 0 });
  await supportSelect.selectOption({ index: 0 });
  await expect(armSelect.locator("option:checked")).toContainText("robot_UR10");
  await expect(supportSelect.locator("option:checked")).toContainText(
    "Conveyor_aankws",
  );
  const before = await exportProject(page);
  await page
    .getByRole("button", { name: "运行输送与取放", exact: true })
    .click();
  await expect(page.getByTestId("simulation-status")).toContainText("running", {
    timeout: 30000,
  });
  await expect(page.getByLabel("组合工艺机械臂")).toBeDisabled();

  await page.getByRole("button", { name: "暂停仿真", exact: true }).click();
  await expect(page.getByTestId("simulation-status")).toContainText("paused");
  const paused = await page.getByTestId("material-position").textContent();
  await page.getByText("已绑定的工步信号", { exact: true }).click();
  const bindings = page
    .locator("details")
    .filter({
      has: page.locator("summary").filter({ hasText: "已绑定的工步信号" }),
    })
    .last();
  const routes = bindings.locator("p");
  await expect(routes).toHaveCount(2);
  await expect(routes.filter({ hasText: /arrive → place · at\(/ })).toHaveCount(
    1,
  );
  await expect(
    routes.filter({ hasText: /arrive → place · supported_at\(/ }),
  ).toHaveCount(1);
  await expect(page.getByTestId("material-position")).toHaveText(paused!);
  await page.getByRole("button", { name: "继续仿真", exact: true }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "工艺 succeeded" }),
  ).toBeVisible({ timeout: 75000 });
  await expect(page.getByTestId("arrival-status")).toContainText("succeeded");
  expect(await exportProject(page)).toEqual(before);
  await page.getByRole("button", { name: "重置仿真", exact: true }).click();
  await expect(page.getByTestId("simulation-status")).toContainText("idle");
  await expect(page.getByLabel("组合工艺机械臂")).toBeEnabled();
  expect(errors).toEqual([]);
});
