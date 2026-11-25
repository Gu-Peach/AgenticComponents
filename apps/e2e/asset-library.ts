import type { Page } from "@playwright/test";

export async function openAssetFolder(page: Page, name = "全部资产") {
  const assets = page.getByRole("region", { name: "资产库", exact: true });
  const folder = assets
    .getByRole("button", { name, exact: true })
    .and(assets.locator("[aria-expanded]"));
  if ((await folder.getAttribute("aria-expanded")) !== "true")
    await folder.click();
  return assets.getByRole("group", { name: name + "列表", exact: true });
}

export async function assetModel(page: Page, name: string) {
  const all = await openAssetFolder(page);
  return all.getByRole("button", { name });
}
