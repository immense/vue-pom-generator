// @vitest-environment jsdom
//
// Inspect mode: elements with a source location are outlined while selecting, and hover/click
// snap to the nearest element that has one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mountAnnotatorClient } from "../plugin/runtime/annotator/client";

const OUTLINES_CLASS = "vpg-annotator-source-outlines";

function mount() {
  return mountAnnotatorClient({
    sourceAttribute: "data-source",
    metadataAttributePrefix: "data-v-pom",
    outputDetail: "standard",
    copyToClipboard: true,
    showComponentTree: false,
  });
}
function button(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
function outlined() {
  return document.documentElement.classList.contains(OUTLINES_CLASS);
}
function outlinesSetting() {
  button("Annotator settings").click();
  const checkbox = Array.from(document.querySelectorAll<HTMLLabelElement>(".vpg-annotator-settings label"))
    .find(label => label.textContent === "Outline source elements")!
    .querySelector<HTMLInputElement>("input[type=checkbox]")!;
  return checkbox;
}
/** Points the page at `stack` (topmost first) and sends `type` to the shield. */
function pointAt(type: "mousemove" | "click", ...stack: Element[]) {
  Object.defineProperty(document, "elementsFromPoint", { value: () => stack, configurable: true });
  document.querySelector(".vpg-annotator-shield")!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  document.documentElement.className = "";
  sessionStorage.clear();
  localStorage.clear();
  delete window.__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__;
});
afterEach(() => {
  Reflect.deleteProperty(document, "elementsFromPoint");
});

describe("inspect-mode source outlines", () => {
  it("outlines elements with the configured source attribute, excluding the annotator UI", () => {
    mount();
    const css = document.getElementById("vpg-annotator-styles")!.textContent!;
    expect(css).toContain(`html.${OUTLINES_CLASS} [data-source]:not([data-vpg-annotator-root])`);
    expect(css).toContain("outline: 1px dashed");
  });

  it("shows outlines only while selecting, including an Add element pick", () => {
    mount();
    expect(outlined()).toBe(false);

    button("Select element").click();
    expect(outlined()).toBe(true);
    button("Stop selecting").click();
    expect(outlined()).toBe(false);

    const target = document.createElement("button");
    target.setAttribute("data-source", "src/views/Page.vue:3:5");
    document.body.append(target);
    button("Select element").click();
    pointAt("click", target);
    // The draft editor is open and selecting has ended.
    expect(outlined()).toBe(false);
    button("Add element").click();
    expect(outlined()).toBe(true);
    button("Stop selecting").click();
    expect(outlined()).toBe(false);
  });

  it("turns outlines off from settings and remembers the choice", () => {
    mount();
    button("Select element").click();
    const settingsButton = button("Annotator settings");
    const checkbox = outlinesSetting();
    expect(checkbox.checked).toBe(true);

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect(outlined()).toBe(false);
    expect(JSON.parse(localStorage.getItem("vpg-annotator-settings")!)).toMatchObject({ showSourceOutlines: false });
    // The open panel is anchored to the Settings button, so a setting change must not replace it.
    expect(checkbox.isConnected).toBe(true);
    expect(button("Annotator settings")).toBe(settingsButton);

    document.body.innerHTML = "";
    delete window.__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__;
    mount();
    button("Select element").click();
    expect(outlined()).toBe(false);
    expect(outlinesSetting().checked).toBe(false);
  });
});

describe("inspect-mode snapping", () => {
  function page() {
    document.body.insertAdjacentHTML("afterbegin", `
      <main data-source="src/views/Page.vue:1:1">
        <section data-source="src/views/Page.vue:4:3"><span><b>Unstamped text</b></span></section>
      </main>
      <div class="third-party"><i>Library popup</i></div>`);
    const section = document.querySelector("section")!;
    section.getBoundingClientRect = () => DOMRect.fromRect({ x: 40, y: 60, width: 300, height: 120 });
    return { bold: document.querySelector("b")!, span: document.querySelector("span")!, popup: document.querySelector("i")! };
  }

  it("highlights and labels the nearest element with a source location", () => {
    const { bold, span } = page();
    mount();
    button("Select element").click();

    pointAt("mousemove", bold, span);

    const highlight = document.querySelector<HTMLElement>(".vpg-annotator-highlight")!;
    expect(highlight.hidden).toBe(false);
    expect(highlight.style).toMatchObject({ left: "40px", top: "60px", width: "300px", height: "120px" });
    expect(highlight.querySelector(".vpg-annotator-highlight-label")!.textContent).toBe("Page · Source: src/views/Page.vue:4:3");
  });

  it("annotates the snapped element on click", () => {
    const { bold } = page();
    mount();
    button("Select element").click();

    pointAt("click", bold);
    button("Add").click();

    const [annotation] = JSON.parse(sessionStorage.getItem("vpg-annotator-annotations")!)[window.location.href];
    expect(annotation).toMatchObject({ source: "src/views/Page.vue:4:3", targetLabel: "Page", domHint: "main > section" });
  });

  it("selects DOM with no source location above it as is", () => {
    const { popup } = page();
    mount();
    button("Select element").click();

    pointAt("mousemove", popup);

    expect(document.querySelector(".vpg-annotator-highlight-label")!.textContent).toBe("i");
  });
});
