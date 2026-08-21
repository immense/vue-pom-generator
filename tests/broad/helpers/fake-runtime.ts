// @vitest-environment node
import type { Screencast } from "playwright";
import { JSDOM } from "jsdom";

import type { BasePageLocator, BasePagePage } from "../../../class-generation/playwright-types";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Minimal Playwright `Keyboard` double: records `type` calls so tests can
 * assert on them, and no-ops the remaining members so it satisfies the full
 * `Keyboard` interface that {@link BasePagePage.keyboard} requires.
 */
class FakeKeyboard {
  public readonly typed: Array<{ text: string; delay: number }> = [];
  public async type(text: string, options: { delay: number }) {
    this.typed.push({ text, delay: options.delay });
  }
  public async down(_key: string) {}
  public async up(_key: string) {}
  public async press(_key: string, _options?: { delay?: number }) {}
  public async insertText(_text: string) {}
}

export interface FakeElement {
  tagName: string;
  isContentEditable?: boolean;
}

/**
 * Minimal Playwright `Page` double satisfying the narrow {@link BasePagePage}
 * interface. It backs `evaluate` with a real JSDOM document (swapped onto
 * `globalThis` for the call) so the runtime's in-page `evaluate` functions run
 * against a DOM. Stateful counters (`waitForSelectorCalls`, `hoverCalls`, …)
 * let tests assert on the page-level interactions.
 */
export class FakePage implements BasePagePage {
  public readonly keyboard = new FakeKeyboard();
  public readonly screencast = {} as Screencast;
  public dom: JSDOM;
  public urlValue = "http://localhost/";
  public isVisibleResult = true;
  public textContentResult: string | null = "text";
  public waitForSelectorCalls: Array<{ selector: string; options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number; strict?: boolean } }> = [];
  public hoverCalls: string[] = [];
  public selectOptionCalls: Array<{ selector: string; value: string }> = [];

  public constructor() {
    this.dom = new JSDOM("<!doctype html><html><body></body></html>");
    this.setViewport(1280, 720);
  }

  public setViewport(width: number, height: number) {
    Object.defineProperty(this.dom.window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(this.dom.window, "innerHeight", { configurable: true, value: height });
    Object.defineProperty(this.dom.window.document.documentElement, "clientWidth", { configurable: true, value: width });
    Object.defineProperty(this.dom.window.document.documentElement, "clientHeight", { configurable: true, value: height });
  }

  public url(): string {
    return this.urlValue;
  }

  public async goto(_url: string): Promise<null> {
    return null;
  }

  public async isVisible(_selector: string): Promise<boolean> {
    return this.isVisibleResult;
  }

  public async textContent(_selector: string): Promise<string | null> {
    return this.textContentResult;
  }

  public async waitForSelector(selector: string, options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number; strict?: boolean }): Promise<void> {
    this.waitForSelectorCalls.push({ selector, options });
  }

  public async hover(selector: string): Promise<void> {
    this.hoverCalls.push(selector);
  }

  public async selectOption(selector: string, value: string): Promise<string[]> {
    this.selectOptionCalls.push({ selector, value });
    return [value];
  }

  public locator(selector: string): FakeLocator {
    return new FakeLocator({ tagName: "DIV" }, { selector });
  }

  public async evaluate<TResult, TArg = never>(fn: ((arg: TArg) => TResult | Promise<TResult>) | string, arg?: TArg): Promise<TResult> {
    if (typeof fn === "string") {
      return undefined as TResult;
    }

    const globalWithDom = globalThis as Record<string, unknown>;
    const previousDocument = globalWithDom.document as Document | undefined;
    const previousHTMLElement = globalWithDom.HTMLElement;
    const previousWindow = globalWithDom.window;
    const previousGetComputedStyle = globalWithDom.getComputedStyle;
    const previousElementFromPoint = previousDocument?.elementFromPoint;

    globalWithDom.document = this.dom.window.document;
    globalWithDom.HTMLElement = this.dom.window.HTMLElement;
    globalWithDom.window = this.dom.window;
    globalWithDom.getComputedStyle = this.dom.window.getComputedStyle.bind(this.dom.window);

    try {
      return fn(arg as TArg);
    }
    finally {
      if (previousDocument === undefined) {
        delete globalWithDom.document;
      }
      else {
        globalWithDom.document = previousDocument;
      }
      if (previousHTMLElement === undefined) {
        delete globalWithDom.HTMLElement;
      }
      else {
        globalWithDom.HTMLElement = previousHTMLElement;
      }
      if (previousWindow === undefined) {
        delete globalWithDom.window;
      }
      else {
        globalWithDom.window = previousWindow;
      }
      if (previousGetComputedStyle === undefined) {
        delete globalWithDom.getComputedStyle;
      }
      else {
        globalWithDom.getComputedStyle = previousGetComputedStyle;
      }
      if (previousElementFromPoint !== undefined && globalWithDom.document) {
        (globalWithDom.document as Document).elementFromPoint = previousElementFromPoint;
      }
    }
  }

  public async waitForTimeout(_milliseconds: number) {}
}

/**
 * Minimal Playwright `Locator` double satisfying the narrow {@link BasePageLocator}
 * interface. Stateful counters (`clicks`, `clears`, `fills`, `scrollCalls`) let
 * tests assert on interactions; `descendant` lets a locator resolve nested
 * editable elements for the vue-select / fill paths.
 */
export class FakeLocator implements BasePageLocator {
  public clicks = 0;
  public clears = 0;
  public readonly fills: string[] = [];
  public descendant?: FakeLocator;
  public lastClickOptions: { delay?: number; force?: boolean } | undefined;
  public hoverCalls = 0;
  public presses: string[] = [];
  public readonly selectedOptions: string[] = [];
  public readonly waitForCalls: Array<{ state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }> = [];
  public scrollCalls = 0;

  public constructor(
    public readonly element: FakeElement,
    public readonly options: {
      boundingBox?: BoundingBox;
      count?: number;
      id?: string;
      textContent?: string | null;
      testId?: string;
      selector?: string;
      visible?: boolean;
    } = {},
  ) {}

  first(): FakeLocator {
    return this;
  }

  last(): FakeLocator {
    return this;
  }

  nth(_index: number): FakeLocator {
    return this;
  }

  locator(selector: string): FakeLocator {
    if (selector.includes("input") || selector.includes("textarea") || selector.includes("contenteditable") || selector.includes("select")) {
      return this.descendant ?? new FakeLocator({ tagName: "DIV" }, { count: 0 });
    }
    return new FakeLocator({ tagName: "DIV" }, { count: 0 });
  }

  describe(_description: string): FakeLocator {
    return this;
  }

  filter(): FakeLocator {
    return this;
  }

  getByLabel(_text: string | RegExp, _options?: { exact?: boolean }): FakeLocator {
    return this;
  }

  getByText(_text: string | RegExp, _options?: { exact?: boolean }): FakeLocator {
    return this;
  }

  getByPlaceholder(_text: string | RegExp, _options?: { exact?: boolean }): FakeLocator {
    return this;
  }

  getByAltText(_text: string | RegExp, _options?: { exact?: boolean }): FakeLocator {
    return this;
  }

  getByTitle(_text: string | RegExp, _options?: { exact?: boolean }): FakeLocator {
    return this;
  }

  getByTestId(_testId: string | RegExp): FakeLocator {
    return this;
  }

  getByRole(_role: string, _options?: Record<string, boolean | number | string | RegExp>): FakeLocator {
    return this;
  }

  async count(): Promise<number> {
    return this.options.count ?? 1;
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    this.scrollCalls += 1;
  }

  async boundingBox(): Promise<BoundingBox | null> {
    return this.options.boundingBox ?? { x: 0, y: 0, width: 10, height: 10 };
  }

  async getAttribute(name: string): Promise<string | null> {
    if (name === "data-testid") {
      return this.options.testId ?? null;
    }
    if (name === "id") {
      return this.options.id ?? null;
    }
    return null;
  }

  async click(options?: { delay?: number; force?: boolean }): Promise<void> {
    this.clicks += 1;
    this.lastClickOptions = options;
  }

  async clear(): Promise<void> {
    if (!this.isEditable()) {
      throw new Error("clear called on non-editable locator");
    }
    this.clears += 1;
  }

  async fill(text: string): Promise<void> {
    if (!this.isEditable()) {
      throw new Error("fill called on non-editable locator");
    }
    this.fills.push(text);
  }

  async hover(): Promise<void> {
    this.hoverCalls += 1;
  }

  async press(key: string): Promise<void> {
    this.presses.push(key);
  }

  async check(): Promise<void> {}

  async uncheck(): Promise<void> {}

  async waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }): Promise<void> {
    this.waitForCalls.push(options ?? {});
    if ((this.options.count ?? 1) === 0) {
      throw new Error("locator did not become visible");
    }
  }

  async isVisible(): Promise<boolean> {
    return this.options.visible ?? true;
  }

  async isHidden(): Promise<boolean> {
    return false;
  }

  async isEnabled(): Promise<boolean> {
    return true;
  }

  async isDisabled(): Promise<boolean> {
    return false;
  }

  async textContent(): Promise<string | null> {
    return this.options.textContent ?? null;
  }

  async innerText(): Promise<string> {
    return "";
  }

  async innerHTML(): Promise<string> {
    return "";
  }

  async selectOption(value: null | string | ReadonlyArray<string> | { value?: string; label?: string; index?: number } | ReadonlyArray<{ value?: string; label?: string; index?: number }>): Promise<string[]> {
    const selected = typeof value === "string" ? value : "";
    if (selected) this.selectedOptions.push(selected);
    return selected ? [selected] : [];
  }

  async type(_text: string): Promise<void> {}

  async evaluate<R>(fn: (element: FakeElement) => R | Promise<R>): Promise<R> {
    return fn(this.element);
  }

  private isEditable(): boolean {
    const tagName = this.element.tagName.toLowerCase();
    return tagName === "input" || tagName === "textarea" || tagName === "select" || this.element.isContentEditable === true;
  }
}
