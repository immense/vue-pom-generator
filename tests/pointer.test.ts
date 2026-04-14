// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { Callout, type CalloutRenderer } from "../class-generation/callout";
import { Pointer, type PointerRenderer, setPlaywrightAnimationOptions } from "../class-generation/pointer";

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxesIntersect(first: BoundingBox, second: BoundingBox): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

class FakeKeyboard {
  public readonly typed: Array<{ text: string; delay: number }> = [];

  async type(text: string, options: { delay: number }) {
    this.typed.push({ text, delay: options.delay });
  }
}

class FakePage {
  public readonly keyboard = new FakeKeyboard();
  public readonly dom = new JSDOM("<!doctype html><html><body></body></html>");

  public constructor() {
    this.setViewport(1280, 720);
  }

  public setViewport(width: number, height: number) {
    Object.defineProperty(this.dom.window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(this.dom.window, "innerHeight", { configurable: true, value: height });
    Object.defineProperty(this.dom.window.document.documentElement, "clientWidth", { configurable: true, value: width });
    Object.defineProperty(this.dom.window.document.documentElement, "clientHeight", { configurable: true, value: height });
  }

  async evaluate<TResult, TArg>(fn: ((arg: TArg) => TResult) | string, arg?: TArg): Promise<TResult> {
    if (typeof fn === "string") {
      return undefined as TResult;
    }

    const globalWithDom = globalThis as Record<string, unknown>;
    const previousDocument = globalWithDom.document;
    const previousHTMLElement = globalWithDom.HTMLElement;
    const previousWindow = globalWithDom.window;
    const previousGetComputedStyle = globalWithDom.getComputedStyle;

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
    }
  }

  async waitForTimeout(_milliseconds: number) {}
}

interface FakeElement {
  tagName: string;
  isContentEditable?: boolean;
}

class FakeLocator {
  public clicks = 0;
  public clears = 0;
  public readonly fills: string[] = [];
  public descendant?: FakeLocator;

  public constructor(
    private readonly element: FakeElement,
    private readonly options: {
      boundingBox?: BoundingBox;
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
    return this.options.boundingBox ?? { x: 0, y: 0, width: 10, height: 10 };
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

function createAvoidElement(page: FakePage, id: string, rect: BoundingBox) {
  const element = page.dom.window.document.createElement("div");
  element.id = id;
  element.setAttribute("data-callout-avoid", "");
  element.style.display = "block";
  element.style.visibility = "visible";
  element.style.opacity = "1";
  element.getBoundingClientRect = () => new page.dom.window.DOMRect(rect.x, rect.y, rect.width, rect.height);
  page.dom.window.document.body.appendChild(element);
  return element;
}

function createVisibleElement(
  page: FakePage,
  id: string,
  rect: BoundingBox,
  options: {
    parent?: HTMLElement;
    tagName?: string;
    testId?: string;
  } = {},
) {
  const element = page.dom.window.document.createElement(options.tagName ?? "div");
  element.id = id;
  if (options.testId) {
    element.setAttribute("data-testid", options.testId);
  }
  element.style.display = "block";
  element.style.visibility = "visible";
  element.style.opacity = "1";
  element.getBoundingClientRect = () => new page.dom.window.DOMRect(rect.x, rect.y, rect.width, rect.height);
  (options.parent ?? page.dom.window.document.body).appendChild(element);
  return element;
}

describe("pointer", () => {
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

  it("renders a red square annotation bubble", async () => {
    const page = new FakePage();
    const target = new FakeLocator(
      { tagName: "BUTTON" },
      {
        boundingBox: { x: 0, y: 0, width: 10, height: 10 },
        testId: "AdministrationTemplatesIndex-521-TogglePreview-button",
      },
    );

    const pointer = new Pointer(page as never, "data-testid");
    await pointer.animateCursorToElement(
      target as never,
      false,
      0,
      "Choose the Motion to Set Divorce Trial saved answer set",
    );

    const annotation = page.dom.window.document.getElementById("__pw_pointer_callout__") as HTMLDivElement | null;
    const arrowEl = page.dom.window.document.getElementById("__pw_pointer_callout_arrow__") as HTMLDivElement | null;
    const annotationStyle = annotation?.getAttribute("style") ?? "";

    expect(annotation).not.toBeNull();
    expect(annotation?.textContent).toBe("Choose the Motion to Set Divorce Trial saved answer set");
    expect(annotation?.style.opacity).toBe("1");
    expect(annotation?.style.background).toBe("rgb(220, 38, 38)");
    expect(annotation?.style.borderRadius).toBe("0px");
    expect(annotationStyle).toContain("border: 0px solid transparent");
    expect(annotation?.getAttribute("data-placement")).toBeTruthy();
    expect(arrowEl).not.toBeNull();
    expect(arrowEl?.style.transform).toContain("rotate(45deg)");
    expect(arrowEl?.style.opacity).toBe("1");
  });

  it("shows and hides a callout without creating the pointer overlay", async () => {
    const page = new FakePage();
    const target = new FakeLocator(
      { tagName: "BUTTON" },
      {
        boundingBox: { x: 470, y: 295, width: 80, height: 36 },
        testId: "CalloutTarget-button",
      },
    );

    const callout = new Callout(page as never);
    await callout.showForElement(target as never, "Keep the nearby controls visible while pointing here");

    const annotation = page.dom.window.document.getElementById("__pw_pointer_callout__") as HTMLDivElement | null;
    const pointerOverlay = page.dom.window.document.getElementById("__pw_pointer__");

    expect(annotation?.style.opacity).toBe("1");
    expect(annotation?.textContent).toBe("Keep the nearby controls visible while pointing here");
    expect(pointerOverlay).toBeNull();

    await callout.hide();

    expect(annotation?.style.opacity).toBe("0");
    expect(annotation?.getAttribute("data-placement")).toBe("hidden");
  });

  it("chooses an open quadrant when nearby visible elements occupy the others", async () => {
    const page = new FakePage();
    page.setViewport(960, 720);

    createAvoidElement(page, "north-east-card", { x: 610, y: 170, width: 210, height: 120 });
    createAvoidElement(page, "south-east-card", { x: 610, y: 360, width: 210, height: 120 });
    createAvoidElement(page, "south-west-card", { x: 280, y: 360, width: 210, height: 120 });

    const target = new FakeLocator(
      { tagName: "BUTTON" },
      {
        boundingBox: { x: 470, y: 295, width: 80, height: 36 },
        testId: "CalloutTarget-button",
      },
    );

    const pointer = new Pointer(page as never, "data-testid");
    await pointer.animateCursorToElement(target as never, false, 0, "Keep the nearby controls visible while pointing here");

    const annotation = page.dom.window.document.getElementById("__pw_pointer_callout__") as HTMLDivElement | null;
    const annotationBox = {
      x: Number.parseFloat(annotation?.style.left ?? "0"),
      y: Number.parseFloat(annotation?.style.top ?? "0"),
      width: Number.parseFloat(annotation?.style.width ?? "0"),
      height: Number.parseFloat(annotation?.style.minHeight ?? "0"),
    };
    expect(annotation?.getAttribute("data-placement")).toBeTruthy();
    expect(boxesIntersect(annotationBox, { x: 470, y: 295, width: 80, height: 36 })).toBe(false);
    expect(boxesIntersect(annotationBox, { x: 610, y: 170, width: 210, height: 120 })).toBe(false);
    expect(boxesIntersect(annotationBox, { x: 610, y: 360, width: 210, height: 120 })).toBe(false);
    expect(boxesIntersect(annotationBox, { x: 280, y: 360, width: 210, height: 120 })).toBe(false);
  });

  it("protects the target's visible parent panel without overlapping the target button", async () => {
    const page = new FakePage();
    page.setViewport(1280, 720);

    createAvoidElement(page, "north-east-card", { x: 710, y: 130, width: 220, height: 140 });
    createAvoidElement(page, "south-east-card", { x: 710, y: 360, width: 220, height: 140 });
    createAvoidElement(page, "south-west-card", { x: 250, y: 440, width: 220, height: 140 });

    const targetPanel = createVisibleElement(page, "target-panel", { x: 470, y: 265, width: 200, height: 200 });
    const targetButton = createVisibleElement(
      page,
      "target-button",
      { x: 500, y: 395, width: 140, height: 48 },
      { parent: targetPanel, tagName: "button", testId: "CalloutTarget-button" },
    );

    page.dom.window.document.elementFromPoint = ((x: number, y: number) => {
      if (x >= 500 && x <= 640 && y >= 395 && y <= 443) {
        return targetButton;
      }
      return page.dom.window.document.body;
    }) as typeof page.dom.window.document.elementFromPoint;

    const target = new FakeLocator(
      { tagName: "BUTTON" },
      {
        boundingBox: { x: 500, y: 395, width: 140, height: 48 },
        testId: "CalloutTarget-button",
      },
    );

    const pointer = new Pointer(page as never, "data-testid");
    await pointer.animateCursorToElement(target as never, false, 0, "Keep the nearby controls visible while pointing here");

    const annotation = page.dom.window.document.getElementById("__pw_pointer_callout__") as HTMLDivElement | null;
    const annotationText = "Keep the nearby controls visible while pointing here";
    const annotationLeft = Number.parseFloat(annotation?.style.left ?? "0");
    const annotationTop = Number.parseFloat(annotation?.style.top ?? "0");
    const annotationWidth = Number.parseFloat(annotation?.style.width ?? "0");
    const annotationHeight = Math.max(52, Math.ceil(annotationText.length / 28) * 20 + 24);
    const annotationRight = annotationLeft + annotationWidth;
    const annotationBottom = annotationTop + annotationHeight;
    const annotationBox = {
      x: annotationLeft,
      y: annotationTop,
      width: annotationWidth,
      height: annotationHeight,
    };

    expect(annotation?.getAttribute("data-placement")).toBeTruthy();
    expect(boxesIntersect(annotationBox, { x: 500, y: 395, width: 140, height: 48 })).toBe(false);
    expect(
      annotationRight <= 470
      || annotationLeft >= 670
      || annotationBottom <= 265
      || annotationTop >= 465,
    ).toBe(true);
  });

  it("supports custom pointer and callout renderers", async () => {
    setPlaywrightAnimationOptions({
      enabled: true,
      pointer: {
        durationMilliseconds: 120,
        clickDelayMilliseconds: 0,
      },
      keyboard: {
        typeDelayMilliseconds: 25,
      },
    });

    const page = new FakePage();
    const target = new FakeLocator(
      { tagName: "BUTTON" },
      {
        boundingBox: { x: 470, y: 295, width: 80, height: 36 },
        testId: "CalloutTarget-button",
      },
    );

    const pointerCalls: string[] = [];
    const calloutCalls: string[] = [];
    const pointerRenderer: PointerRenderer = {
      overlayIds: ["__custom_pointer__"],
      async ensure() {
        pointerCalls.push("ensure");
      },
      async move(_page, request) {
        pointerCalls.push(`move:${request.startX}->${request.endX}`);
      },
      async press(_page, request) {
        pointerCalls.push(`press:${request.durationMilliseconds}`);
      },
    };
    const calloutRenderer: CalloutRenderer = {
      overlayIds: ["__custom_callout__"],
      async hide() {
        calloutCalls.push("hide");
      },
      async show(_page, request) {
        calloutCalls.push(`${request.text}:${request.layout?.placement ?? "none"}`);
      },
    };

    const callout = new Callout(page as never, {
      extraOverlayIds: pointerRenderer.overlayIds,
      renderer: calloutRenderer,
    });
    const pointer = new Pointer(page as never, "data-testid", callout, pointerRenderer);

    await pointer.animateCursorToElement(target as never, true, 0, "Highlight the publish action");

    expect(pointerCalls).toEqual([
      "ensure",
      expect.stringMatching(/^move:/),
      expect.stringMatching(/^press:/),
    ]);
    expect(calloutCalls).toEqual([expect.stringContaining("Highlight the publish action")]);
    expect(page.dom.window.document.getElementById("__pw_pointer__")).toBeNull();
    expect(page.dom.window.document.getElementById("__pw_pointer_callout__")).toBeNull();
  });
});
