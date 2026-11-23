import { expect, test } from "@playwright/test";

test("the loading line keeps its PLC and responds to toolbar playback and speed controls", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "场景", exact: true }).click();
  await page.getByRole("button", { name: /S02：六托盘三工位分层装载/ }).click();

  const plc = page.getByRole("tab", { name: "PLC", exact: true });
  const panel = page.getByRole("region", { name: "场景运行" });
  const toolbar = page.getByRole("group", { name: "场景播放控制" });
  await expect(plc).toHaveAttribute("aria-selected", "true");
  await expect(panel).toBeVisible();
  await expect(toolbar).toContainText("S02");

  await page.getByRole("button", { name: "传送带 01", exact: true }).click();
  await expect(panel).toBeVisible();
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("三维视口不可用");
  await canvas.click({
    position: { x: bounds.width * 0.74, y: bounds.height * 0.14 },
  });
  await expect(page.locator(".bom .tree-row.selected")).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(toolbar).toContainText("S02");

  const speed = toolbar.getByRole("spinbutton", { name: "场景播放速度" });
  await speed.fill("1.75");
  await speed.press("Enter");
  await expect(speed).toHaveValue("1.75");
  await toolbar.getByRole("button", { name: "播放场景", exact: true }).click();
  await expect(panel).toContainText("running", { timeout: 30_000 });
  await expect(panel).toContainText(/tick [1-9]/);
  await toolbar.getByRole("button", { name: "暂停场景", exact: true }).click();
  await expect(panel).toContainText("paused");
  const pausedText = await panel.innerText();
  const runId = /run (\S+) · tick/.exec(pausedText)?.[1];
  expect(runId).toBeTruthy();
  const time = toolbar.getByLabel("场景仿真时间");
  const pausedTime = await time.innerText();
  await speed.fill("0.5");
  await speed.press("Tab");
  await expect(speed).toHaveValue("0.5");
  await expect(time).toHaveText(pausedTime);

  await toolbar.getByRole("button", { name: "继续场景", exact: true }).click();
  await expect(panel).toContainText("running");
  await expect(panel).toContainText(runId!);
  await expect(time).not.toHaveText(pausedTime);
  await toolbar.getByRole("button", { name: "停止场景", exact: true }).click();
  await expect(panel).toContainText("cancelled", { timeout: 30_000 });
  await toolbar
    .getByRole("button", { name: "重新播放场景", exact: true })
    .click();
  await expect(panel).toContainText("running", { timeout: 30_000 });
  await expect(panel).not.toContainText(runId!);
  await toolbar.getByRole("button", { name: "停止场景", exact: true }).click();
  await expect(panel).toContainText("cancelled", { timeout: 30_000 });
  expect(errors).toEqual([]);
});
