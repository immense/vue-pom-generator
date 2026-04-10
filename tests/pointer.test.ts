// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { Pointer, setPlaywrightAnimationOptions } from "../class-generation/Pointer";

class FakeKeyboard {
  public readonly typed: Array<{ text: string; delay: number }> = [];

  async type(text: string, options: { delay: number }) {
    this.typed.push({ text, delay: options.delay });
  }
}

class FakePage {
  public readonly keyboard = new FakeKeyboard();
  public readonly dom = new JSDOM("<!doctype html><html><body></body></html>");

  async evaluate<TResult, TArg>(fn: ((arg: TArg) => TResult) | string, arg?: TArg): Promise<TResult> {
    if (typeof fn === "string") {
      return undefined as TResult;
    }

    const globalWithDom = globalThis as Record<string, unknown>;
    const previousDocument = globalWithDom.document;
    const previousHTMLElement = globalWithDom.HTMLElement;

    globalWithDom.document = this.dom.window.document;
    globalWithDom.HTMLElement = this.dom.window.HTMLElement;

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
    }
  }

  async waitForTimeout(_milliseconds: number) {}
}

type FakeElement = {
  tagName: string;
  isContentEditable?: boolean;
};

class FakeLocator {
  public clicks = 0;
  public clears = 0;
  public readonly fills: string[] = [];
  public descendant?: FakeLocator;

  public constructor(
    private readonly element: FakeElement,
    private readonly options: {
      count?: number;
      testId?: string;
    } = {},
  ) {}

  first() {
    return this;
  }

  locator(selector: string) {
    if (selector.includes("input") || selector.includes("textarea") || selector.includes("contenteditable")) {
      return this.descendant ?? new FakeLocator({ tagName: "DIV" }, { count: 0 });
    }

    return new FakeLocator({ tagName: "DIV" }, { count: 0 });
  }

  async count() {
    return this.options.count ?? 1;
  }

  async scrollIntoViewIfNeeded() {}

  async boundingBox() {
    return { x: 0, y: 0, width: 10, height: 10 };
  }

  async getAttribute(name: string) {
    if (name === "data-testid") {
      return this.options.testId ?? null;
    }

    return null;
  }

  async click(_options?: { delay?: number; force?: boolean }) {
    this.clicks += 1;
  }

  async clear() {
    if (!this.isEditable()) {
      throw new Error("clear called on non-editable locator");
    }

    this.clears += 1;
  }

  async fill(text: string) {
    if (!this.isEditable()) {
      throw new Error("fill called on non-editable locator");
    }

    this.fills.push(text);
  }

  async evaluate<TResult>(fn: (element: FakeElement) => TResult) {
    return fn(this.element);
  }

  private isEditable() {
    const tagName = this.element.tagName.toLowerCase();
    return tagName === "input"
      || tagName === "textarea"
      || tagName === "select"
      || this.element.isContentEditable === true;
  }
}

describe("Pointer", () => {
  beforeEach(() => {
    setPlaywrightAnimationOptions({
      enabled: true,
      pointer: {
        durationMilliseconds: 0,
        clickDelayMilliseconds: 0,
      },
      keyboard: {
        typeDelayMilliseconds: 25,
      },
    });
  });

  it("types into a nested input when the target locator is a wrapper element", async () => {
    const page = new FakePage();
    const wrapper = new FakeLocator({ tagName: "DIV" }, { testId: "TenantSelectBox-StateSelectedTenant-input" });
    const input = new FakeLocator({ tagName: "INPUT" });
    wrapper.descendant = input;

    const pointer = new Pointer(page as never, "data-testid");
    await pointer.animateCursorToElementAndClickAndFill(wrapper as never, "Acme", true, 0);

    expect(wrapper.clicks).toBe(1);
    expect(input.clears).toBe(1);
    expect(page.keyboard.typed).toEqual([{ text: "Acme", delay: 25 }]);
  });

  it("fills a nested input when animations are disabled", async () => {
    setPlaywrightAnimationOptions({ enabled: false });

    const page = new FakePage();
    const wrapper = new FakeLocator({ tagName: "DIV" }, { testId: "TenantSelectBox-StateSelectedTenant-input" });
    const input = new FakeLocator({ tagName: "INPUT" });
    wrapper.descendant = input;

    const pointer = new Pointer(page as never, "data-testid");
    await pointer.animateCursorToElementAndClickAndFill(wrapper as never, "Acme", true, 0);

    expect(wrapper.clicks).toBe(1);
    expect(input.fills).toEqual(["Acme"]);
  });

  it("renders annotation text next to the animated cursor", async () => {
    const page = new FakePage();
    const target = new FakeLocator({ tagName: "BUTTON" }, { testId: "AdministrationTemplatesIndex-521-TogglePreview-button" });

    const pointer = new Pointer(page as never, "data-testid");
    await pointer.animateCursorToElement(
      target as never,
      false,
      0,
      "Choose the Motion to Set Divorce Trial saved answer set",
    );

    const annotation = page.dom.window.document.getElementById("__pw_cursor_annotation__");
    expect(annotation).not.toBeNull();
    expect(annotation?.textContent).toBe("Choose the Motion to Set Divorce Trial saved answer set");
    expect(annotation?.getAttribute("style")).toContain("opacity: 1");
  });
});
