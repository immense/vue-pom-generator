import { expect, test, type Page } from "@playwright/test";

import type { FormattedAnnotation } from "../../plugin/runtime/annotator/format";
import { useAnnotatorFixture } from "./annotator-fixture";

useAnnotatorFixture("/tests/playwright/fixtures/annotator/index.html");

async function pick(page: Page, id: string) {
  const bounds = await page.getByTestId(id).boundingBox();
  if (!bounds) {
    throw new Error(`Target ${id} is not visible`);
  }
  // Click through the shield using actual page coordinates, as a user does.
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function records(page: Page): Promise<FormattedAnnotation[]> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("vpg-annotator-annotations")!)[location.href]);
}

test("types a multi-pill note, picks at the caret, reloads, and deletes pills with the keyboard", async ({ page }) => {
  await page.getByRole("button", { name: "Select element", exact: true }).click();
  await pick(page, "save");
  const comment = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(comment).toBeVisible();
  await comment.press("Home");
  await page.keyboard.type("Swap ");
  await comment.press("End");
  await page.keyboard.type(" with  please");
  for (let i = 0; i < 7; i += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.getByRole("button", { name: "Add element", exact: true }).click();
  await pick(page, "cancel");
  await expect(comment.locator("[data-reference-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  expect(await records(page)).toMatchObject([{
    comment: "Swap [element1: SaveButton] with [element2: CancelButton] please",
    references: [{ id: "element1", source: "src/SaveButton.vue:10:3" }, { id: "element2", source: "src/CancelButton.vue:20:5" }],
  }]);

  await page.reload();
  await page.locator(".vpg-annotator-marker").click();
  await expect(comment.locator("[data-reference-id]")).toHaveCount(2);
  // Select all and delete through the browser's native contenteditable behavior.
  await comment.press("ControlOrMeta+a");
  await comment.press("Backspace");
  await page.keyboard.type("Plain feedback");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(await records(page)).toMatchObject([{ comment: "Plain feedback", references: [], targetLabel: "SaveButton" }]);
});

test("backspace removes a single atomic pill and typing continues after a newly picked pill", async ({ page }) => {
  await page.getByRole("button", { name: "Select element", exact: true }).click();
  await pick(page, "save");
  const comment = page.getByRole("textbox", { name: "Comment", exact: true });
  await comment.press("End");
  await comment.press("Backspace");
  await expect(comment.locator("[data-reference-id]")).toHaveCount(0);
  await page.keyboard.type("Match ");
  await page.getByRole("button", { name: "Add element", exact: true }).click();
  await pick(page, "cancel");
  await page.keyboard.type(" to ");
  await page.getByRole("button", { name: "Add element", exact: true }).click();
  await pick(page, "reset");
  await page.keyboard.type(".");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  expect(await records(page)).toMatchObject([{
    comment: "Match [element2: CancelButton] to [element3: ResetButton].",
    references: [{ id: "element2" }, { id: "element3" }],
  }]);
});
