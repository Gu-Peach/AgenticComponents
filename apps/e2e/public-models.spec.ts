import { test, expect } from "@playwright/test";
test("public model, inspector, orange interfaces and local persistence", async ({
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
  await expect(page.getByText("资产定义 · 只读")).toBeVisible();
  await expect(page.getByLabel("定义 speed_mps", { exact: true })).toHaveValue(
    "0.4",
  );
  await expect(
    page.getByLabel("定义 speed_mps", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "添加到现场", exact: true }).click();
  await expect(page.getByLabel("设备名称")).toHaveValue(/Conveyor_aankws/);
  await page.getByText("模型节点与类型结构", { exact: true }).click();
  await expect(page.locator(".node-list")).toContainText("Mesh");
  const dots = page.locator(".interface-dot");
  await expect(dots).toHaveCount(2);
  await expect(dots.first()).toHaveAttribute(
    "data-local-position",
    "-0.749,0.7,0",
  );
  await page.getByRole("button", { name: "定位", exact: true }).click();
  await expect
    .poll(() =>
      dots.evaluateAll(
        (elements) =>
          elements.filter((el) => {
            let node: HTMLElement | null = el as HTMLElement;
            while (node) {
              const style = getComputedStyle(node);
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.opacity === "0"
              )
                return false;
              node = node.parentElement;
            }
            return true;
          }).length,
      ),
    )
    .toBeGreaterThan(0);
  await card.click();
  await expect(dots).toHaveCount(0);
  const viewport = await page.locator("canvas").boundingBox();
  await page
    .locator("canvas")
    .click({ position: { x: viewport!.width / 2, y: viewport!.height * 0.4 } });
  await expect(page.getByLabel("设备名称")).toHaveValue(/Conveyor_aankws/);
  await expect(dots).toHaveCount(2);
  await dots.nth(1).click();
  await expect(page.locator("#interface-end_positive_x")).toBeVisible();
  await expect(dots.nth(1)).toHaveClass(/active/);
  await page.screenshot({ path: "test-results/public-conveyor-selected.png" });
  await page.getByText("文件", { exact: true }).click();
  await page.getByRole("button", { name: /保存到浏览器/ }).click();
  await expect(page.locator(".statusbar")).toContainText("本地项目");
  await page.reload();
  await expect(card).toBeVisible();
  const bom = page
    .locator(".tree-select")
    .filter({ hasText: "Conveyor_aankws" });
  await bom.click();
  await page.getByText("模型节点与类型结构", { exact: true }).click();
  await expect(page.locator(".node-list")).toContainText("Mesh");
  await expect(dots).toHaveCount(2);
  await page.getByLabel("position-X", { exact: true }).fill("4");
  await page.getByLabel("position-X", { exact: true }).press("Tab");
  await page.getByLabel("rotation-Y", { exact: true }).fill("90");
  await page.getByLabel("rotation-Y", { exact: true }).press("Tab");
  await expect(dots.first()).toHaveAttribute(
    "data-local-position",
    "-0.749,0.7,0",
  );
  expect(errors).toEqual([]);
});
