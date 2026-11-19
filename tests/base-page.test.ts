// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { BasePage } from "../class-generation/base-page";
import { POINTER_CALLOUT_IDS, type CalloutRenderer, setDefaultCalloutRenderer, simpleCalloutRenderer } from "../class-generation/callout";
import { FakeLocator, FakePage } from "./broad/helpers/fake-runtime";

function createRecordingCalloutRenderer(): CalloutRenderer & { hide: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> } {
  return { hide: vi.fn(async () => {}), show: vi.fn(async () => {}) };
}

class TestBasePage extends BasePage {
  public getLocator(testId: string, description?: string) {
    return this.locatorByTestId(testId, description);
  }

  public getComponentInstance(instanceId: string) {
    return this.componentInstanceLocator(instanceId);
  }
}

describe("BasePage", () => {
  it("exposes page.screencast through a getter", () => {
    const screencast = { path: "/tmp/demo.webm" };
    const page = new FakePage();
    Object.defineProperty(page, "screencast", { configurable: true, value: screencast });

    const basePage = new BasePage(page);

    expect(basePage.screencast).toBe(screencast);
  });

  it("describes locators when a human-readable label is provided", () => {
    const describedLocator = new FakeLocator({ tagName: "DIV" });
    const rawLocator = new FakeLocator({ tagName: "DIV" });
    vi.spyOn(rawLocator, "describe").mockReturnValue(describedLocator);
    const page = new FakePage();
    page.locator = vi.fn(() => rawLocator);

    const basePage = new TestBasePage(page);

    expect(basePage.getLocator("save-button", "Tenant editor save button")).toBe(describedLocator);
    expect(page.locator).toHaveBeenCalledWith('[data-testid="save-button"]');
    expect(rawLocator.describe).toHaveBeenCalledWith("Tenant editor save button");
  });

  it("resolves generated selectors and nested component instances inside the supplied root", () => {
    const testIdLocator = new FakeLocator({ tagName: "INPUT" });
    const componentLocator = new FakeLocator({ tagName: "DIV" });
    const root = new FakeLocator({ tagName: "SECTION" });
    root.locator = vi.fn((selector: string) => {
      return selector.includes("data-pom-instance") ? componentLocator : testIdLocator;
    });
    const page = new FakePage();
    page.locator = vi.fn(() => {
      throw new Error("Scoped POMs must not query the page root");
    });

    const basePage = new TestBasePage(page, { root });

    expect(basePage.getLocator("required-option")).toBe(testIdLocator);
    expect(basePage.getComponentInstance("field-name-component")).toBe(componentLocator);
    expect(root.locator).toHaveBeenNthCalledWith(1, '[data-testid="required-option"]');
    expect(root.locator).toHaveBeenNthCalledWith(2, '[data-pom-instance="field-name-component"]');
    expect(page.locator).not.toHaveBeenCalled();
  });

  it("renders callouts with the process-wide default renderer when no per-instance renderer is given", async () => {
    const processDefault = createRecordingCalloutRenderer();
    const perInstance = createRecordingCalloutRenderer();
    setDefaultCalloutRenderer(processDefault);
    try {
      const page = new FakePage();
      const target = new FakeLocator({ tagName: "BUTTON" });

      await new BasePage(page).showCallout(target, "Save the tenant");
      await new BasePage(page, { renderers: { callout: perInstance } }).showCallout(target, "Per-instance wins");

      expect(processDefault.show).toHaveBeenCalledTimes(1);
      expect(processDefault.show).toHaveBeenCalledWith(page, expect.objectContaining({ target, text: "Save the tenant" }));
      expect(perInstance.show).toHaveBeenCalledWith(page, expect.objectContaining({ text: "Per-instance wins" }));
      expect(page.dom.window.document.getElementById(POINTER_CALLOUT_IDS.annotation)).toBeNull();
    }
    finally {
      setDefaultCalloutRenderer(simpleCalloutRenderer);
    }
  });

  it("keeps the built-in callout when no default renderer has been set", async () => {
    const page = new FakePage();

    await new BasePage(page).showCallout(new FakeLocator({ tagName: "BUTTON" }), "Built-in bubble");

    const annotation = page.dom.window.document.getElementById(POINTER_CALLOUT_IDS.annotation);
    expect(annotation?.textContent).toBe("Built-in bubble");
  });
});
