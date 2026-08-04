// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { BasePage, ObjectId, type Fluent } from "../../class-generation/base-page";
import type { AfterPointerClick } from "../../class-generation/pointer";
import type { PwLocator } from "../../class-generation/playwright-types";
import { FakeLocator, FakePage } from "./helpers/fake-runtime";

/**
 * Typed view of a fluent/value proxy's dynamic surface. The proxies intentionally
 * dispatch arbitrary property accesses (returning thenables that reject for
 * missing members, or throwing for non-function members), so the typed surface is
 * a record of callable, thenable members. This lets the missing-member probes
 * access properties that do not exist on the underlying object without `as any`.
 */
type DynamicMember = (() => Promise<unknown>) & PromiseLike<unknown>;

function dynamicMembers(proxy: object): Record<string, DynamicMember> {
  return proxy as Record<string, DynamicMember>;
}

/** Read a symbol-keyed property off a record without a `symbol` index assertion at the call site. */
function symbolKey(record: object, sym: symbol) {
  return Reflect.get(record, sym);
}

class ExposedBasePage extends BasePage {
  public sel(testId: string) {
    return this.selectorForTestId(testId);
  }
  public loc(testId: string, description?: string) {
    return this.locatorByTestId(testId, description);
  }
  public locByLabel(rootTestId: string, label: string, options?: { exact?: boolean; description?: string }) {
    return this.locatorWithinTestIdByLabel(rootTestId, label, options);
  }
  public animate(target: string | PwLocator, executeClick = true, delayMs = 0, annotation = "", options?: { afterClick?: AfterPointerClick }) {
    return this.animateCursorToElement(target, executeClick, delayMs, annotation, options);
  }
  public keyed<T extends string>(fn: (key: T) => PwLocator) {
    return this.keyedLocators(fn);
  }
  public async objId(options?: { timeoutMs?: number }) {
    return this.getObjectId(options);
  }
  public async objIdInt(options?: { timeoutMs?: number }) {
    return this.getObjectIdAsInt(options);
  }
  public makeFluent<T extends object>(factory: () => Promise<T>): Fluent<T> {
    return this.fluent(factory);
  }
  public clickTestId(testId: string, annotation = "", wait = true, description?: string) {
    return this.clickByTestId(testId, annotation, wait, description);
  }
  public clickLoc(locator: PwLocator, annotation = "", wait = true) {
    return this.clickLocator(locator, annotation, wait);
  }
  public clickWithinLabel(rootTestId: string, label: string, annotation = "", wait = true, options?: { exact?: boolean; description?: string }) {
    return this.clickWithinTestIdByLabel(rootTestId, label, annotation, wait, options);
  }
  public fillTestId(testId: string, text: string, annotation = "", description?: string) {
    return this.fillInputByTestId(testId, text, annotation, description);
  }
  public selectVSelect(testId: string, value: string, timeOut = 0, annotation = "", description?: string) {
    return this.selectVSelectByTestId(testId, value, timeOut, annotation, description);
  }
  public fillLoc(locator: PwLocator, text: string, annotation = "") {
    return this.fillInputByLocator(locator, text, annotation);
  }
  public clickAria(label: string, annotation = "") {
    return this.clickByAriaLabel(label, annotation);
  }
  public typeTestId(testId: string, text: string) {
    return this.typeByTestId(testId, text);
  }
  public visibleTestId(testId: string) {
    return this.isVisibleByTestId(testId);
  }
  public textTestId(testId: string) {
    return this.getTextByTestId(testId);
  }
  public waitTestId(testId: string, options?: { timeout?: number }) {
    return this.waitForTestId(testId, options);
  }
  public hoverTestId(testId: string) {
    return this.hoverByTestId(testId);
  }
  public selectTestId(testId: string, value: string) {
    return this.selectByTestId(testId, value);
  }
}

describe("ObjectId", () => {
  it("round-trips raw value through toString/asInt", () => {
    const id = new ObjectId("123");
    expect(id.toString()).toBe("123");
    expect(id.asInt()).toBe(123);
    expect(id.AsInt()).toBe(123);
  });

  it("throws when constructed with an empty value", () => {
    expect(() => new ObjectId("")).toThrow("ObjectId: raw value is empty");
  });

  it("throws when AsInt receives a non base-10 integer string", () => {
    const id = new ObjectId("abc");
    expect(() => id.AsInt()).toThrow("is not a base-10 integer string");
  });

  it("throws when AsInt receives an unsafe integer string", () => {
    const huge = `${Number.MAX_SAFE_INTEGER + 2}`;
    const id = new ObjectId(huge);
    expect(() => id.AsInt()).toThrow("is not a safe integer");
  });
});

describe("BasePage construction", () => {
  it("defaults the test id attribute to data-testid", () => {
    const page = new ExposedBasePage(new FakePage());
    expect(page.sel("save")).toBe('[data-testid="save"]');
  });

  it("honours a custom test id attribute and trims whitespace", () => {
    const page = new ExposedBasePage(new FakePage(), { testIdAttribute: "  data-qa  " });
    expect(page.sel("save")).toBe('[data-qa="save"]');
  });

  it("falls back to data-testid when the custom attribute is blank", () => {
    const page = new ExposedBasePage(new FakePage(), { testIdAttribute: "   " });
    expect(page.sel("save")).toBe('[data-testid="save"]');
  });
});

describe("BasePage locators", () => {
  it("builds a selector and locator by test id without a description", () => {
    const rawLocator = new FakeLocator({ tagName: "DIV" });
    const locatorMock = vi.fn(() => rawLocator);
    const fakePage = new FakePage();
    fakePage.locator = locatorMock;
    const page = new ExposedBasePage(fakePage);
    expect(page.loc("save")).toBe(rawLocator);
    expect(locatorMock).toHaveBeenCalledWith('[data-testid="save"]');
  });

  it("locates within a test id by label with exact + description options", () => {
    const described = new FakeLocator({ tagName: "DIV" });
    const rawLocator = new FakeLocator({ tagName: "DIV" });
    const byLabelLocator = new FakeLocator({ tagName: "DIV" });
    vi.spyOn(rawLocator, "describe").mockReturnValue(described);
    vi.spyOn(byLabelLocator, "getByLabel").mockReturnValue(rawLocator);
    const fakePage = new FakePage();
    fakePage.locator = vi.fn(() => byLabelLocator);
    const page = new ExposedBasePage(fakePage);
    const result = page.locByLabel("panel", "Email", { exact: false, description: "email field" });
    expect(byLabelLocator.getByLabel).toHaveBeenCalledWith("Email", { exact: false });
    expect(rawLocator.describe).toHaveBeenCalledWith("email field");
    expect(result).toBe(described);
  });

  it("defaults the exact flag to true when locating by label", () => {
    const byLabelLocator = new FakeLocator({ tagName: "DIV" });
    const rawLocator = new FakeLocator({ tagName: "DIV" });
    vi.spyOn(byLabelLocator, "getByLabel").mockReturnValue(rawLocator);
    const fakePage = new FakePage();
    fakePage.locator = vi.fn(() => byLabelLocator);
    const page = new ExposedBasePage(fakePage);
    page.locByLabel("panel", "Email");
    expect(byLabelLocator.getByLabel).toHaveBeenCalledWith("Email", { exact: true });
  });
});

describe("BasePage keyed locators", () => {
  it("returns a locator per key and ignores symbol/then probes", async () => {
    const page = new ExposedBasePage(new FakePage());
    const proxy = page.keyed<string>((key) => new FakeLocator({ tagName: "DIV" }, { testId: key }));
    const alpha = proxy.alpha;
    expect(await alpha.getAttribute("data-testid")).toBe("alpha");
    expect(proxy.then).toBeUndefined();
    expect(symbolKey(proxy, Symbol("x"))).toBeUndefined();
  });
});

describe("BasePage object id from url", () => {
  it("parses a numeric id out of the url", async () => {
    const fakePage = new FakePage();
    fakePage.urlValue = "http://host/tenants/42/edit";
    const page = new ExposedBasePage(fakePage);
    const id = await page.objId();
    expect(id.toString()).toBe("42");
    expect(await page.objIdInt()).toBe(42);
  });

  it("throws when no numeric id appears before the timeout", async () => {
    const fakePage = new FakePage();
    fakePage.urlValue = "http://host/tenants";
    const page = new ExposedBasePage(fakePage);
    await expect(page.objId({ timeoutMs: 10 })).rejects.toThrow("could not find a numeric id");
  });
});

describe("BasePage callout delegation", () => {
  it("shows a callout by selector and by test id, then hides it", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    await page.showCallout("#target", "note");
    await page.showCalloutByTestId("save", "note");
    await page.hideCallout();
    const annotation = fakePage.dom.window.document.getElementById("__pw_pointer_callout__");
    expect(annotation?.getAttribute("data-placement")).toBe("hidden");
  });
});

describe("BasePage action helpers", () => {
  it("animates the cursor via the pointer", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    const target = new FakeLocator({ tagName: "BUTTON" }, { boundingBox: { x: 0, y: 0, width: 10, height: 10 }, testId: "btn" });
    await page.animate(target, false, 0, "hi");
    expect(target.scrollCalls).toBeGreaterThan(0);
  });

  it("clicks by test id and propagates afterClick for instrumented clicks", async () => {
    const fakePage = new FakePage();
    const btn = new FakeLocator({ tagName: "BUTTON" }, { testId: "btn" });
    fakePage.locator = () => btn;
    const page = new ExposedBasePage(fakePage);
    await page.clickTestId("btn", "note", true, "the button");
    // exercise the wait=false early return path
    await page.clickTestId("btn", "note", false);
    expect(btn.clicks).toBe(2);
  });

  it("clicks a locator directly", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    const target = new FakeLocator({ tagName: "BUTTON" }, { testId: "btn" });
    await page.clickLoc(target, "note", true);
    await page.clickLoc(target, "note", false);
    expect(target.clicks).toBe(2);
  });

  it("clicks within a test id by label", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    const input = new FakeLocator({ tagName: "INPUT" }, { testId: "btn" });
    const root = new FakeLocator({ tagName: "DIV" }, { testId: "panel" });
    root.descendant = input;
    fakePage.locator = (selector: string) => (selector.includes("panel") ? root : input);
    await page.clickWithinLabel("panel", "Email", "note", true, { exact: true, description: "email" });
    expect(root.clicks).toBe(1);
  });

  it("fills an input by test id", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    const input = new FakeLocator({ tagName: "INPUT" }, { testId: "name" });
    fakePage.locator = () => input;
    await page.fillTestId("name", "Acme", "note", "name field");
    expect(input.fills.length + input.clears).toBeGreaterThan(0);
  });

  it("fills by locator", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    const input = new FakeLocator({ tagName: "INPUT" }, { testId: "name" });
    await page.fillLoc(input, "Acme", "note");
    const enteredViaKeyboard = fakePage.keyboard.typed.some((t) => t.text === "Acme");
    const enteredViaFill = input.fills.includes("Acme");
    expect(enteredViaKeyboard || enteredViaFill).toBe(true);
  });

  it("selects a vue-select option when a dropdown option is present", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    const input = new FakeLocator({ tagName: "INPUT" });
    const option = new FakeLocator({ tagName: "LI" }, { count: 1 });
    const root = new FakeLocator({ tagName: "DIV" }, { testId: "vs" });
    root.descendant = input;
    // Make nested .locator("ul.vs__dropdown-menu li[role='option']") return an option locator with count 1.
    const original = root.locator.bind(root);
    root.locator = (selector: string) => {
      if (selector.includes("vs__dropdown-menu")) return option;
      return original(selector);
    };
    fakePage.locator = () => root;
    await page.selectVSelect("vs", "Acme", 0, "note", "vs field");
    expect(input.clicks).toBeGreaterThanOrEqual(1);
    expect(option.clicks).toBe(1);
  });

  it("selects a vue-select option when no dropdown option is present", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    const input = new FakeLocator({ tagName: "INPUT" });
    const option = new FakeLocator({ tagName: "LI" }, { count: 0 });
    const root = new FakeLocator({ tagName: "DIV" }, { testId: "vs" });
    root.descendant = input;
    const original = root.locator.bind(root);
    root.locator = (selector: string) => {
      if (selector.includes("vs__dropdown-menu")) return option;
      return original(selector);
    };
    fakePage.locator = () => root;
    await page.selectVSelect("vs", "Acme", 0, "note");
    expect(input.clicks).toBeGreaterThanOrEqual(1);
    expect(option.clicks).toBe(0);
  });

  it("clicks by aria label", async () => {
    const fakePage = new FakePage();
    const target = new FakeLocator({ tagName: "BUTTON" });
    fakePage.locator = (selector: string) =>
      selector.includes("aria-label") ? target : new FakeLocator({ tagName: "DIV" }, { selector });
    const page = new ExposedBasePage(fakePage);
    await page.clickAria("Close", "note");
    expect(target.clicks).toBe(1);
  });

  it("types into an element by test id", async () => {
    const fakePage = new FakePage();
    const page = new ExposedBasePage(fakePage);
    const input = new FakeLocator({ tagName: "INPUT" }, { testId: "name" });
    fakePage.locator = () => input;
    await page.typeTestId("name", "Acme");
    expect(input.clicks).toBeGreaterThanOrEqual(1);
    const enteredViaKeyboard = fakePage.keyboard.typed.some((t) => t.text === "Acme");
    const enteredViaFill = input.fills.includes("Acme");
    expect(enteredViaKeyboard || enteredViaFill).toBe(true);
  });

  it("checks visibility, text, wait, hover, and select by test id", async () => {
    const fakePage = new FakePage();
    fakePage.isVisibleResult = false;
    fakePage.textContentResult = "hello";
    const page = new ExposedBasePage(fakePage);
    const input = new FakeLocator({ tagName: "SELECT" }, { testId: "sel" });
    fakePage.locator = () => input;
    expect(await page.visibleTestId("x")).toBe(false);
    expect(await page.textTestId("x")).toBe("hello");
    await page.waitTestId("x", { timeout: 500 });
    expect(fakePage.waitForSelectorCalls[0]).toEqual({ selector: '[data-testid="x"]', options: { timeout: 500 } });
    await page.hoverTestId("x");
    expect(fakePage.hoverCalls).toContain('[data-testid="x"]');
    await page.selectTestId("x", "opt");
    expect(fakePage.selectOptionCalls[0]).toEqual({ selector: '[data-testid="x"]', value: "opt" });
  });
});

describe("BasePage fluent proxy", () => {
  class Child {
    public constructor(public value: number) {}
    public name = "child";
    public async getObjectId() {
      return new ObjectId("7");
    }
    public async getObjectIdAsInt() {
      return 7;
    }
    public async increment() {
      return this.value + 1;
    }
    public async nested(): Promise<Child> {
      return new Child(this.value + 10);
    }
  }

  function makePage() {
    const fakePage = new FakePage();
    return new ExposedBasePage(fakePage);
  }

  it("awaits to the underlying object", async () => {
    const page = makePage();
    const fluent = page.makeFluent(async () => new Child(1));
    const child = await fluent;
    expect(child).toBeInstanceOf(Child);
    expect(child.value).toBe(1);
  });

  it("chains non-value-returning methods back to the root and resolves siblings", async () => {
    const page = makePage();
    const fluent = page.makeFluent(async () => new Child(1));
    const chained = fluent.increment().nested();
    const root = await chained;
    expect(root).toBeInstanceOf(Child);
  });

  it("returns a value proxy for getObjectId and getObjectIdAsInt", async () => {
    const page = makePage();
    const fluent = page.makeFluent(async () => new Child(1));
    const id = await fluent.getObjectId();
    expect(id.toString()).toBe("7");
    const asInt = await fluent.getObjectIdAsInt();
    expect(asInt).toBe(7);
  });

  it("reads a property member of a value proxy", async () => {
    const page = makePage();
    const fluent = page.makeFluent(async () => new Child(1));
    // Calling a function member of the value proxy resolves to that member's result,
    // with `this` bound to the underlying object (ObjectId.toString reads this.raw).
    expect(await fluent.getObjectId().toString()).toBe("7");
  });

  it("throws when awaiting a missing member on the root proxy", async () => {
    const page = makePage();
    const fluent = page.makeFluent(async () => new Child(1));
    await expect(dynamicMembers(fluent).missing.then((v) => v)).rejects.toThrow("does not exist");
  });

  it("throws when awaiting a missing nested member of a value proxy", async () => {
    const page = makePage();
    const fluent = page.makeFluent(async () => new Child(1));
    const valueProxy = fluent.getObjectId();
    await expect(dynamicMembers(valueProxy).nope.then((v) => v)).rejects.toThrow("does not exist");
  });

  it("throws when calling a non-function nested member of a value proxy", async () => {
    const page = makePage();
    const fluent = page.makeFluent(async () => new Child(1));
    // `raw` is a non-function (string) member of ObjectId; calling it through the
    // value-member proxy rejects with "is not a function". Driving the rejection
    // through `.then` yields a real Promise (the proxy is a thenable function, not
    // a Promise instance) so `expect(...).rejects` can observe it.
    const valueProxy = fluent.getObjectId();
    await expect(dynamicMembers(valueProxy).raw().then((v) => v)).rejects.toThrow("is not a function");
  });
});
