// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { BasePage } from "../class-generation/base-page";
import { FakeLocator, FakePage } from "./broad/helpers/fake-runtime";

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
});
