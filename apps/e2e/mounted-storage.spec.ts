import { expect, test, type Page } from "@playwright/test";

async function save(page: Page) {
  await page.getByText("文件", { exact: true }).click();
  await page.getByRole("button", { name: /保存到浏览器/ }).click();
}
async function stored(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ revision: number; keys: string[]; refs: string[] }>(
        (resolve, reject) => {
          const open = indexedDB.open("agentic-workbench", 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result,
              tx = db.transaction(["assets", "project"]);
            const assets = tx.objectStore("assets").getAllKeys(),
              document = tx.objectStore("project").get("current");
            tx.oncomplete = () => {
              db.close();
              resolve({
                revision: document.result?.revision ?? -1,
                keys: assets.result.map(String),
                refs: (document.result?.assets ?? []).map(
                  (r: { id: string }) => r.id,
                ),
              });
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
          };
        },
      ),
  );
}

test("saving extracted GLBs and the document rolls back on a failed write and skips already stored hashes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "场景", exact: true }).click();
  await page
    .getByRole("button", { name: /S07：四件分层入库后按订单出库/ })
    .click();
  const extract = page.getByRole("button", { name: "提取独立设备 · T1 / L1" });
  await expect(extract).toBeVisible();
  await save(page);
  await expect
    .poll(async () =>
      (await stored(page)).refs.some((k) => k.startsWith("scene-model-")),
    )
    .toBe(true);
  const before = await stored(page);
  await extract.click();
  await expect(page.getByLabel("滑轨目标位置（m）")).toBeVisible();
  expect(await stored(page)).toEqual(before);

  // Abort the real IDB transaction on its second new asset. Keep one valid SHA/Blob
  // in a local variable so another project can publish the same asset before the retry.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    let shared: { id: IDBValidKey; value: Blob } | undefined;
    IDBObjectStore.prototype.add = function (value, key) {
      const request = original.call(this, value, key);
      if (
        this.name === "assets" &&
        typeof key === "string" &&
        key.startsWith("sha256-")
      ) {
        if (!shared) shared = { id: key, value };
        else {
          IDBObjectStore.prototype.add = original;
          this.transaction.addEventListener("abort", () => {
            document.documentElement.dataset.failedSave = "true";
          });
          this.transaction.abort();
          window.addEventListener(
            "publish-shared",
            () => {
              const open = indexedDB.open("agentic-workbench", 1);
              open.onsuccess = () => {
                const db = open.result,
                  tx = db.transaction("assets", "readwrite");
                tx.objectStore("assets").add(shared!.value, shared!.id);
                tx.oncomplete = () => {
                  db.close();
                  document.documentElement.dataset.shared = String(shared!.id);
                };
              };
            },
            { once: true },
          );
        }
      }
      return request;
    };
  });
  await save(page);
  await page.waitForFunction(
    () => document.documentElement.dataset.failedSave === "true",
  );
  expect(await stored(page)).toEqual(before);
  await page.evaluate(() => window.dispatchEvent(new Event("publish-shared")));
  await page.waitForFunction(() => !!document.documentElement.dataset.shared);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, key) {
      if (
        this.name === "assets" &&
        typeof key === "string" &&
        key.startsWith("sha256-")
      ) {
        document.documentElement.dataset.inserted = key;
        if (key === document.documentElement.dataset.shared)
          throw new Error("Shared asset was overwritten");
      }
      return original.call(this, value, key);
    };
  });
  await save(page);
  await expect
    .poll(async () => (await stored(page)).refs.length)
    .toBe(before.refs.length + 2);
  const after = await stored(page);
  expect(after.keys.length).toBe(before.keys.length + 2);
  expect(after.keys).toEqual(
    expect.arrayContaining(after.refs.filter((id) => id.startsWith("sha256-"))),
  );
  await page.reload();
  expect(await stored(page)).toEqual(after);
});
