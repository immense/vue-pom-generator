import { expect, test } from "@playwright/test";

import { Callout } from "../../class-generation/callout";
import { createFloatingUiCalloutRenderer } from "../../class-generation/floating-ui-callout";
import { Pointer, setPlaywrightAnimationOptions } from "../../class-generation/pointer";

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

function boxesIntersect(first: Box, second: Box): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

function resetAnimationOptions() {
  setPlaywrightAnimationOptions({
    enabled: true,
    extraDelayMs: 0,
    pointer: {
      durationMilliseconds: 250,
      transitionStyle: "ease-in-out",
      clickDelayMilliseconds: 0,
    },
    keyboard: {
      typeDelayMilliseconds: 100,
    },
  });
}

test.describe("pointer callout", () => {
  test.afterEach(() => {
    resetAnimationOptions();
  });

  test("avoids nearby visible elements while keeping the callout anchored to the target region", async ({ page }) => {
    await page.goto("/tests/playwright/fixtures/pointer-callout/index.html");

    const target = page.getByTestId("callout-target");
    const targetPanel = page.getByTestId("target-panel");
    const northEastCard = page.getByTestId("north-east-card");
    const southEastCard = page.getByTestId("south-east-card");
    const southWestCard = page.getByTestId("south-west-card");
    const annotation = page.locator("#__pw_pointer_callout__");
    const arrow = page.locator("#__pw_pointer_callout_arrow__");

    await expect(target).toBeVisible();
    await expect(targetPanel).toBeVisible();
    await expect(northEastCard).toBeVisible();
    await expect(southEastCard).toBeVisible();
    await expect(southWestCard).toBeVisible();

    setPlaywrightAnimationOptions({
      enabled: true,
      pointer: {
        durationMilliseconds: 0,
        clickDelayMilliseconds: 0,
      },
      keyboard: {
        typeDelayMilliseconds: 0,
      },
    });

    const callout = new Callout(page as never, {
      renderer: createFloatingUiCalloutRenderer(),
    });
    const pointer = new Pointer(page as never, "data-testid", callout);
    await pointer.animateCursorToElement(
      target as never,
      false,
      0,
      "Capture the primary action without hiding the nearby cards",
    );

    await expect(annotation).toBeVisible();
    await expect(arrow).toBeVisible();

    const [annotationBox, targetBox, targetPanelBox, northEastBox, southEastBox, southWestBox] = await Promise.all([
      annotation.boundingBox(),
      target.boundingBox(),
      targetPanel.boundingBox(),
      northEastCard.boundingBox(),
      southEastCard.boundingBox(),
      southWestCard.boundingBox(),
    ]);

    if (!annotationBox || !targetBox || !targetPanelBox || !northEastBox || !southEastBox || !southWestBox) {
      throw new Error("Expected all fixture elements to produce bounding boxes.");
    }

    expect(boxesIntersect(annotationBox, targetBox)).toBe(false);
    expect(boxesIntersect(annotationBox, targetPanelBox)).toBe(false);
    expect(boxesIntersect(annotationBox, northEastBox)).toBe(false);
    expect(boxesIntersect(annotationBox, southEastBox)).toBe(false);
    expect(boxesIntersect(annotationBox, southWestBox)).toBe(false);

    const arrowState = await arrow.evaluate((element) => ({
      bottom: window.getComputedStyle(element).bottom,
      left: window.getComputedStyle(element).left,
      opacity: window.getComputedStyle(element).opacity,
      right: window.getComputedStyle(element).right,
      top: window.getComputedStyle(element).top,
    }));
    const annotationStyle = await annotation.evaluate((element) => ({
      backgroundColor: window.getComputedStyle(element).backgroundColor,
      borderRadius: window.getComputedStyle(element).borderRadius,
    }));

    expect(arrowState.opacity).toBe("1");
    expect(
      [arrowState.top, arrowState.right, arrowState.bottom, arrowState.left]
        .filter((value) => value !== "auto")
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(annotationStyle.backgroundColor).toBe("rgb(220, 38, 38)");
    expect(annotationStyle.borderRadius).toBe("0px");
  });

  test("shows the simple fallback callout without creating the pointer overlay", async ({ page }) => {
    await page.goto("/tests/playwright/fixtures/pointer-callout/index.html");

    const target = page.getByTestId("callout-target");
    const annotation = page.locator("#__pw_pointer_callout__");
    const pointerOverlay = page.locator("#__pw_pointer__");

    await expect(target).toBeVisible();
    await expect(pointerOverlay).toHaveCount(0);

    const callout = new Callout(page as never);
    await callout.showForElement(target as never, "Capture the primary action without moving the pointer");

    await expect(annotation).toBeVisible();
    await expect(pointerOverlay).toHaveCount(0);
    await expect(annotation).toHaveCSS("background-color", "rgb(220, 38, 38)");
  });

  test("cycles through two floating-ui callouts in one video", async ({ page }) => {
    await page.goto("/tests/playwright/fixtures/pointer-callout/index.html");

    const annotation = page.locator("#__pw_pointer_callout__");
    const arrow = page.locator("#__pw_pointer_callout_arrow__");
    const pointerOverlay = page.locator("#__pw_pointer__");
    const callout = new Callout(page as never, {
      renderer: createFloatingUiCalloutRenderer(),
    });
    const steps = [
      {
        message: "Start with the release notes action in the top-right card.",
        target: page.getByTestId("north-east-card").getByRole("button"),
      },
      {
        message: "Then move to the primary publish action in the focused panel.",
        target: page.getByTestId("callout-target"),
      },
    ] as const;

    await expect(pointerOverlay).toHaveCount(0);

    for (const step of steps) {
      await callout.showForElement(step.target as never, step.message);
      await expect(annotation).toBeVisible();
      await expect(arrow).toBeVisible();
      await expect(annotation).toContainText(step.message);
      await page.waitForTimeout(1000);
    }

    await callout.hide();
    await expect(pointerOverlay).toHaveCount(0);
    await expect(annotation).toHaveCSS("opacity", "0");
    await page.waitForTimeout(250);
  });
});
