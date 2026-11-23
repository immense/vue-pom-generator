// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountAnnotatorClient, type AnnotatorSubmitHandler } from "../plugin/runtime/annotator/client";
import { AnnotationCommentEditor } from "../plugin/runtime/annotator/comment-editor";
import { formatAnnotations, type AnnotationReference, type FormattedAnnotation } from "../plugin/runtime/annotator/format";

const PAGE_URL = window.location.href;
const STORAGE_KEY = "vpg-annotator-annotations";
const first: AnnotationReference = {
  id: "element1",
  targetLabel: "SaveButton",
  source: "src/SaveButton.vue:10:3",
  component: "SaveButton",
  locator: 'near `[data-testid="save"]`',
  uiText: "Save",
  domHint: 'main > [data-testid="save"]',
  pageUrl: PAGE_URL,
};
const second: AnnotationReference = {
  ...first,
  id: "element2",
  targetLabel: "CancelButton",
  source: "src/CancelButton.vue:20:5",
  component: "CancelButton",
  locator: 'near `[data-testid="cancel"]`',
  uiText: "Cancel",
  domHint: 'main > [data-testid="cancel"]',
};
const multi: FormattedAnnotation = {
  ...first,
  id: "annotation-1",
  comment: "Swap [element1: SaveButton] with [element2: CancelButton]",
  references: [first, second],
};

function button(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
function stored(): FormattedAnnotation[] {
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}")[PAGE_URL] ?? [];
}
function seed(annotation: FormattedAnnotation) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ [PAGE_URL]: [{ ...annotation, pageX: 100, pageY: 100 }] }));
}
function mount() {
  return mountAnnotatorClient({
    sourceAttribute: "data-source",
    metadataAttributePrefix: "data-v-pom",
    outputDetail: "standard",
    copyToClipboard: true,
    showComponentTree: true,
  });
}
function caret(node: Node, offset = 0, end = offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
function pick(reference: AnnotationReference) {
  const target = document.createElement("button");
  target.textContent = reference.uiText!;
  target.setAttribute("data-source", reference.source!);
  target.setAttribute("data-testid", reference.uiText!.toLowerCase());
  target.setAttribute("data-v-pom-component", reference.component!);
  document.body.append(target);
  Object.defineProperty(document, "elementsFromPoint", { value: () => [target], configurable: true });
  document.querySelector(".vpg-annotator-shield")!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
}
function editor() {
  return document.querySelector<HTMLDivElement>(".vpg-annotator-comment")!;
}
function input() {
  editor().dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
  localStorage.clear();
  delete window.__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__;
  delete window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__;
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementsFromPoint");
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("annotation references", () => {
  it("saves one multi-pill note with independent target metadata, then restores the pills", () => {
    mount();
    button("Select element").click();
    pick(first);
    editor().prepend(document.createTextNode("Swap "));
    editor().append(document.createTextNode(" with  please"));
    caret(editor().lastChild!, 6);
    input();
    button("Add element").click();
    expect(document.querySelector<HTMLElement>(".vpg-annotator-input")!.hidden).toBe(true);
    pick(second);
    expect(editor().querySelectorAll("[data-reference-id]")).toHaveLength(2);
    button("Add").click();

    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({
      comment: `${multi.comment} please`,
      targetLabel: first.targetLabel,
      source: first.source,
      component: first.component,
      locator: first.locator,
      pageUrl: PAGE_URL,
      references: [
        { id: first.id, targetLabel: first.targetLabel, source: first.source, component: first.component, locator: first.locator },
        { id: second.id, targetLabel: second.targetLabel, source: second.source, component: second.component, locator: second.locator },
      ],
    });
    document.querySelector<HTMLButtonElement>(".vpg-annotator-marker")!.click();
    expect(editor().querySelectorAll("[data-reference-id]")).toHaveLength(2);
    expect(editor().getAttribute("aria-label")).toBe("Comment");
    button("Save").click();
    expect(stored()[0]!.comment).toBe(`${multi.comment} please`);
  });

  it("cancels page picking without losing the draft or selection", () => {
    seed(multi);
    mount();
    document.querySelector<HTMLButtonElement>(".vpg-annotator-marker")!.click();
    caret(editor().firstChild!, 0);
    button("Add element").click();
    button("Stop selecting").click();
    expect(document.querySelector<HTMLElement>(".vpg-annotator-input")!.hidden).toBe(false);
    expect(editor().querySelectorAll("[data-reference-id]")).toHaveLength(2);
    expect(window.getSelection()!.anchorOffset).toBe(0);
    button("Save").click();
    expect(stored()[0]).toMatchObject(multi);
  });

  it("removes pills without renumbering and discards canceled edits", () => {
    seed(multi);
    mount();
    const marker = () => document.querySelector<HTMLButtonElement>(".vpg-annotator-marker")!;
    marker().click();
    button("Remove element1").click();
    button("Cancel").click();
    expect(stored()[0]).toMatchObject(multi);
    marker().click();
    button("Remove element1").click();
    button("Save").click();
    expect(stored()[0]!.comment).toBe("Swap  with [element2: CancelButton]");
    expect(stored()[0]!.references).toEqual([second]);
    expect(stored()[0]!.targetLabel).toBe(first.targetLabel);
  });

  it("edits legacy records without treating literal token-like text as a pill", () => {
    const legacy: FormattedAnnotation = { id: "annotation-legacy", comment: "Fix [element1: SaveButton]", targetLabel: "button" };
    seed(legacy);
    mount();
    document.querySelector<HTMLButtonElement>(".vpg-annotator-marker")!.click();
    expect(editor().querySelectorAll("[data-reference-id]")).toHaveLength(0);
    button("Add element").click();
    pick(second);
    button("Save").click();
    expect(stored()[0]).toMatchObject({ targetLabel: "button", references: [{ id: "element1", targetLabel: "CancelButton" }] });
    expect(stored()[0]!.comment).toBe("Fix [element1: SaveButton][element1: CancelButton]");
  });

  it.each(["standard", "forensic"] as const)("copies every reference in %s output", async (detail) => {
    const formatted = formatAnnotations([multi], detail, PAGE_URL);
    expect(formatted).toContain(`### 1. ${multi.comment}`);
    for (const reference of [first, second]) {
      expect(formatted).toContain(`#### [${reference.id}: ${reference.targetLabel}]`);
      expect(formatted).toContain(`- **Source:** ${reference.source}`);
      expect(formatted).toContain(`- **Component:** ${reference.component}`);
      expect(formatted).toContain(`- **Target:** \`${reference.targetLabel}\``);
      expect(formatted).toContain(`- **Locator:** ${reference.locator}`);
      expect(formatted.includes(reference.domHint!)).toBe(detail === "forensic");
    }
    seed(multi);
    localStorage.setItem("vpg-annotator-settings", JSON.stringify({ outputDetail: detail }));
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mount();
    button("Copy annotations").click();
    expect(writeText).toHaveBeenCalledWith(formatted);
  });

  it("submits all reference fields and readable comment tokens unchanged", async () => {
    seed(multi);
    const handler = vi.fn<AnnotatorSubmitHandler>(() => true);
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = handler;
    mount();
    button("Submit annotations").click();
    expect(handler).toHaveBeenCalledWith([expect.objectContaining(multi)], { pageUrl: PAGE_URL });
    await vi.waitFor(() => expect(stored()).toHaveLength(0));
  });

  it("keeps a note when a handler mutates nested reference metadata", async () => {
    seed(multi);
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = (annotations) => {
      annotations[0]!.references![1]!.locator = "updated locator";
      return true;
    };
    mount();
    button("Submit annotations").click();
    await vi.waitFor(() => expect(stored()[0]!.references![1]!.locator).toBe("updated locator"));
    expect(stored()).toHaveLength(1);
  });

  it("keeps saved pill edits made during submission without changing its payload", async () => {
    seed(multi);
    let release!: (accepted: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    const handler = vi.fn<AnnotatorSubmitHandler>(() => pending);
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = handler;
    mount();
    button("Submit annotations").click();
    document.querySelector<HTMLButtonElement>(".vpg-annotator-marker")!.click();
    button("Remove element2").click();
    button("Save").click();
    expect(handler.mock.calls[0]![0][0]!.references).toEqual([first, second]);
    release(true);
    await vi.waitFor(() => expect(button("Submit annotations").disabled).toBe(false));
    expect(stored()[0]!.references).toEqual([first]);
  });
});

describe("comment pill editor", () => {
  it.each(["deleteContentBackward", "deleteContentForward"])("removes an adjacent pill on %s without touching surrounding text", (inputType) => {
    const comment = new AnnotationCommentEditor(multi.comment, multi.references!, vi.fn());
    document.body.append(comment.element);
    const pill = comment.element.querySelector<HTMLElement>("[data-reference-id]")!;
    const index = Array.from(comment.element.childNodes).indexOf(pill);
    caret(comment.element, inputType === "deleteContentBackward" ? index + 1 : index);
    const event = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
    comment.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(comment.read()).toEqual({ comment: "Swap  with [element2: CancelButton]", references: [second] });
  });

  it("replaces selected text, serializes line breaks, and removes references deleted by typing", () => {
    const comment = new AnnotationCommentEditor("Make this match", [], vi.fn());
    document.body.append(comment.element);
    caret(comment.element.firstChild!, 5, 9);
    comment.captureSelection();
    comment.addReference(first);
    expect(comment.read().comment).toBe("Make [element1: SaveButton] match");
    const line = document.createElement("div");
    line.textContent = "on the next line";
    comment.element.append(line);
    expect(comment.read().comment).toBe("Make [element1: SaveButton] match\non the next line");
    comment.element.querySelector("[data-reference-id]")!.remove();
    comment.element.dispatchEvent(new Event("input"));
    expect(comment.read().references).toEqual([]);
  });

  it("copies and cuts readable tokens without remove-button glyphs", () => {
    const comment = new AnnotationCommentEditor(multi.comment, multi.references!, vi.fn());
    document.body.append(comment.element);
    caret(comment.element, 0, comment.element.childNodes.length);
    const setData = vi.fn();
    for (const type of ["copy", "cut"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { setData } });
      comment.element.dispatchEvent(event);
      expect(setData).toHaveBeenLastCalledWith("text/plain", multi.comment);
    }
    expect(comment.read()).toEqual({ comment: "", references: [] });
  });

  it("pastes plain text and restores known tokens without inserting HTML", () => {
    const comment = new AnnotationCommentEditor("", [first], vi.fn());
    document.body.append(comment.element);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: (type: string) => type === "text/plain" ? "<b>Match</b> [element1: SaveButton]" : "<img src=x>" },
    });
    comment.element.dispatchEvent(event);
    expect(comment.element.querySelector("b, img")).toBeNull();
    expect(comment.read()).toEqual({ comment: "<b>Match</b> [element1: SaveButton]", references: [first] });
  });
});
