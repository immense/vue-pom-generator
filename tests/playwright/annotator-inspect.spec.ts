import { expect, test, type Locator, type Page } from "@playwright/test";

import type { FormattedAnnotation } from "../../plugin/runtime/annotator/format";
import { useAnnotatorFixture } from "./annotator-fixture";

useAnnotatorFixture("/tests/playwright/fixtures/annotator-inspect/index.html");

function outlineStyle(locator: Locator) {
  return locator.evaluate(element => getComputedStyle(element).outlineStyle);
}

/** Moves the real mouse over `locator`, at `offset` from its top-left corner or else its center. */
async function hover(page: Page, locator: Locator, offset?: { x: number; y: number }) {
  const box = (await locator.boundingBox())!;
  await page.mouse.move(box.x + (offset?.x ?? box.width / 2), box.y + (offset?.y ?? box.height / 2));
}

async function expectSameBox(actual: Locator, expected: Locator) {
  const [a, e] = [(await actual.boundingBox())!, (await expected.boundingBox())!];
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(a[key] - e[key])).toBeLessThanOrEqual(1);
  }
}

test("outlines elements with a source location only while selecting, without shifting layout", async ({ page }) => {
  const card = page.getByTestId("card");
  const thirdParty = page.getByTestId("third-party");
  const before = await card.boundingBox();
  expect(await outlineStyle(card)).toBe("none");

  await page.getByRole("button", { name: "Select element", exact: true }).click();
  // Wins over the page's own `outline: none` on <section>.
  expect(await outlineStyle(card)).toBe("dashed");
  expect(await outlineStyle(page.getByRole("heading", { name: "Profile" }))).toBe("dashed");
  expect(await outlineStyle(thirdParty)).toBe("none");
  expect(await outlineStyle(page.locator(".vpg-annotator-toolbar"))).toBe("none");
  expect(await card.boundingBox()).toEqual(before);

  await page.getByRole("button", { name: "Stop selecting", exact: true }).click();
  expect(await outlineStyle(card)).toBe("none");

  await page.getByRole("button", { name: "Select element", exact: true }).click();
  await page.getByRole("button", { name: "Annotator settings", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "Outline source elements" });
  const panel = page.locator(".vpg-annotator-settings");
  const panelBox = await panel.boundingBox();
  await toggle.uncheck();
  expect(await outlineStyle(card)).toBe("none");
  // The panel stays open and in place (still anchored to the Settings button).
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await panel.boundingBox()).toEqual(panelBox);
  await toggle.check();
  expect(await outlineStyle(card)).toBe("dashed");
});

test("snaps hover and click to the nearest element with a source location", async ({ page }) => {
  await page.getByRole("button", { name: "Select element", exact: true }).click();
  const highlight = page.locator(".vpg-annotator-highlight");
  const label = page.locator(".vpg-annotator-highlight-label");

  // An unstamped <b> (like v-html output) resolves to its stamped <p>.
  const paragraph = page.getByText("Name: Ada");
  await hover(page, page.getByTestId("name"));
  await expect(label).toHaveText("ProfileCard (/app/src/components/ProfileCard.vue:5:5)");
  await expectSameBox(highlight, paragraph);

  // A component's root shows that component and its own location.
  const card = page.getByTestId("card");
  await hover(page, card, { x: 8, y: 8 });
  await expect(label).toHaveText("ProfileCard (/app/src/components/ProfileCard.vue:4:3)");
  await expectSameBox(highlight, card);

  // Third-party DOM resolves to its nearest stamped ancestor.
  await hover(page, page.getByText("Library widget"));
  await expect(label).toHaveText("Profile (/app/src/views/Profile.vue:1:1)");
  await expectSameBox(highlight, page.getByRole("main"));

  const name = (await page.getByTestId("name").boundingBox())!;
  await page.mouse.click(name.x + name.width / 2, name.y + name.height / 2);
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const records: FormattedAnnotation[] = await page.evaluate(() => JSON.parse(sessionStorage.getItem("vpg-annotator-annotations")!)[location.href]);
  expect(records).toMatchObject([{ source: "/app/src/components/ProfileCard.vue:5:5", targetLabel: "ProfileCard", uiText: "Name: Ada" }]);
});
