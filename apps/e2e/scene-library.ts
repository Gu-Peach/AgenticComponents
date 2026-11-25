import type { Page } from "@playwright/test";

export async function importSceneFromLibrary(page: Page, sceneId: string) {
  const library = page
    .getByRole("region", { name: "场景库" })
    .locator(".scene-library");
  const group = library.getByRole("button", {
    name: "可导入场景",
    exact: true,
  });
  if ((await group.getAttribute("aria-expanded")) !== "true")
    await group.click();
  const folder = library.getByRole("button", {
    name: new RegExp(`^${sceneId}：`),
  });
  if ((await folder.getAttribute("aria-expanded")) !== "true")
    await folder.click();
  await library
    .getByRole("button", { name: `导入 ${sceneId} 整场景`, exact: true })
    .click();
}

export async function openProjectFolder(page: Page) {
  const project = page.getByRole("region", { name: "当前项目", exact: true });
  const folder = project.locator(".project-folder-toggle");
  if ((await folder.getAttribute("aria-expanded")) !== "true")
    await folder.click();
  return project;
}
