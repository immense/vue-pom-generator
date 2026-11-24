import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import type { FormattedAnnotation } from "../../plugin/runtime/annotator/format";

let output: string;
test.beforeAll(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), "annotator-usage-browser-"));
  const root = path.resolve("tests/playwright/fixtures/annotator-usage/frontend");
  await build({ root, configFile: path.join(root, "vite.config.mjs"), logLevel: "silent", build: { outDir: output } });
});
test.afterAll(async () => { await fs.rm(output, { recursive: true, force: true }); });

test("preserves source and nearest usage through hover, Preview, Copy, and Submit in a built app", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("http://127.0.0.1:4173/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    await route.fulfill({
      body: await fs.readFile(path.join(output, file)),
      contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
    });
  });
  await page.goto("http://127.0.0.1:4173/");
  const source = "shared/ui/src/components/Button.vue:6:3";
  const usageSource = "shared/ui/src/components/Wrapper.vue:7:3";
  const button = page.getByRole("main").getByRole("button").first();
  await expect(button).toHaveAttribute("data-v-inspector", source);
  await expect(button).toHaveAttribute("data-v-pom-usage", usageSource);
  await page.getByRole("button", { name: "Update label", exact: true }).click();
  await expect(button).toHaveText("Updated");
  await expect(button).toHaveAttribute("data-v-pom-usage", usageSource);
  await page.evaluate(() => {
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = (annotations) => {
      sessionStorage.setItem("submitted", JSON.stringify(annotations));
      return true;
    };
    window.__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__!.refresh();
  });
  await page.getByRole("button", { name: "Select element", exact: true }).click();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  const label = page.locator(".vpg-annotator-highlight-label");
  await expect(label).toContainText(`Source: ${source}`);
  await expect(label).toContainText(`Used at: ${usageSource}`);
  await page.mouse.click(box.x + 5, box.y + 5);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Preview annotations", exact: true }).click();
  const preview = await page.locator(".vpg-annotator-panel--preview textarea").inputValue();
  expect(preview).toContain(`- **Source:** ${source}`);
  expect(preview).toContain(`- **Used at:** ${usageSource}`);
  await page.getByRole("button", { name: "Copy annotations", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(preview);
  await page.getByRole("button", { name: "Submit annotations", exact: true }).click();
  const submitted: FormattedAnnotation[] = await page.evaluate(() => JSON.parse(sessionStorage.getItem("submitted")!));
  expect(submitted).toMatchObject([{ source, usageSource, references: [{ source, usageSource }] }]);
});
