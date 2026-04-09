// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { Pointer, setPlaywrightAnimationOptions } from "../class-generation/Pointer";

class FakeKeyboard {
  public readonly typed: Array<{ text: string; delay: number }> = [];

  async type(text: string, options: { delay: number }) {
    this.typed.push({ text, delay: options.delay });
  }
}

class FakePage {
  public readonly keyboard = new FakeKeyboard();

  async evaluate<TResult, TArg>(_fn: ((arg: TArg) => TResult) | string, arg?: TArg): Promise<TResult> {
    if (typeof arg === "string") {
      return false as TResult;
    }

    return undefined as TResult;
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
});
