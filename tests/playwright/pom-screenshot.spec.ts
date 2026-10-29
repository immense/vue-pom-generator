import { readFile, stat } from "node:fs/promises";

import { Buffer } from "node:buffer";
import { expect, test } from "@playwright/test";

import { BasePage, type Fluent } from "../../class-generation/base-page";

const PNG_MAGIC = Buffer.from("89504e47", "hex");

class TenantListPageStub extends BasePage {
  public goToNewTenant(): Fluent<BasePage> {
    return this.fluent(async () => new BasePage(this.page));
  }
}

test("BasePage.screenshot writes a real PNG file and resolves its buffer", async ({ page }, testInfo) => {
  await page.goto("/tests/playwright/fixtures/pointer-callout/index.html");

  const pom = new BasePage(page);
  const outPath = testInfo.outputPath("proof.png");
  const buffer = await pom.screenshot({ path: outPath });

  expect(buffer.length).toBeGreaterThan(0);
  expect(buffer.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);

  const written = await stat(outPath);
  expect(written.size).toBe(buffer.length);
  expect((await readFile(outPath)).equals(buffer)).toBe(true);
});

test("BasePage.screenshot without options resolves the viewport image", async ({ page }) => {
  await page.goto("/tests/playwright/fixtures/pointer-callout/index.html");

  const pom = new BasePage(page);
  const buffer = await pom.screenshot();

  expect(buffer.length).toBeGreaterThan(0);
  expect(buffer.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
});

test("consumer pattern: awaited fluent destination POM supports screenshot({ path })", async ({ page }, testInfo) => {
  await page.goto("/tests/playwright/fixtures/pointer-callout/index.html");

  const tenantListPage = new TenantListPageStub(page);
  const newTenant = await tenantListPage.goToNewTenant();
  const outPath = testInfo.outputPath("destination-proof.png");
  const buffer = await newTenant.screenshot({ path: outPath });

  expect(buffer.length).toBeGreaterThan(0);
  expect(buffer.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  expect((await stat(outPath)).size).toBe(buffer.length);
  expect((await readFile(outPath)).equals(buffer)).toBe(true);
});
