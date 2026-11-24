// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountAnnotatorClient, type AnnotatorSubmitHandler } from "../plugin/runtime/annotator/client";
import { AnnotationCommentEditor } from "../plugin/runtime/annotator/comment-editor";
import { formatAnnotations, formatSingleAnnotationPreview, type AnnotationReference, type FormattedAnnotation } from "../plugin/runtime/annotator/format";

const PAGE_URL = window.location.href;
const STORAGE_KEY = "vpg-annotator-annotations";
const first: AnnotationReference = {
  id: "element1",
  targetLabel: "SaveButton",
  source: "shared/ui/src/SaveButton.vue:10:3",
  usageSource: "frontend/src/views/Page.vue:44:9",
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
  source: "shared/ui/src/CancelButton.vue:20:5",
  usageSource: "frontend/src/views/Page.vue:45:9",
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
  target.setAttribute("data-v-pom-usage", reference.usageSource!);
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
  it.each([
    ["", "[element1: SaveButton]"],
    ["Swap", "Swap [element1: SaveButton]"],
    ["Swap ", "Swap [element1: SaveButton]"],
    ["Swap\n", "Swap\n[element1: SaveButton]"],
  ])("separates the initial draft pill from %j", (comment, expected) => {
    const runtime = mount();
    const target = document.createElement("button");
    target.setAttribute("data-v-pom-component", first.targetLabel);
    // eslint-disable-next-line dot-notation -- exercise draft spacing without making the runtime method public
    expect(runtime["buildAnnotationDraft"](target, comment).comment).toBe(expected);
  });

  it("spaces text typed against pills and keeps the saved comment stable when reopened", () => {
    mount();
    button("Select element").click();
    pick(first);
    editor().prepend(document.createTextNode("Swap"));
    editor().append(document.createTextNode("with "));
    caret(editor().lastChild!, 5);
    input();
    button("Add element").click();
    pick(second);
    button("Add").click();
    expect(stored()[0]!.comment).toBe(multi.comment);

    for (let round = 0; round < 3; round += 1) {
      document.querySelector<HTMLButtonElement>(".vpg-annotator-marker")!.click();
      expect(editor().querySelectorAll("[data-reference-id]")).toHaveLength(2);
      button("Save").click();
      expect(stored()[0]!.comment).toBe(multi.comment);
    }
  });

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
      usageSource: first.usageSource,
      component: first.component,
      locator: first.locator,
      pageUrl: PAGE_URL,
      references: [
        { id: first.id, targetLabel: first.targetLabel, source: first.source, usageSource: first.usageSource, component: first.component, locator: first.locator },
        { id: second.id, targetLabel: second.targetLabel, source: second.source, usageSource: second.usageSource, component: second.component, locator: second.locator },
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

  it.each(["Preview annotations", "Annotator settings", "marker"])("cancels a pick when %s replaces its draft panel", (destination) => {
    seed(multi);
    mount();
    button("Select element").click();
    pick(first);
    const draftEditor = editor();
    button("Add element").click();

    const marker = () => document.querySelector<HTMLButtonElement>(".vpg-annotator-marker")!;
    if (destination === "marker") {
      marker().click();
    }
    else {
      button(destination).click();
    }

    expect(draftEditor.isConnected).toBe(false);
    expect(document.querySelector<HTMLElement>(".vpg-annotator-shield")!.hidden).toBe(true);
    expect(button("Select element")).not.toBeNull();
    pick(second);
    expect(draftEditor.querySelectorAll("[data-reference-id]")).toHaveLength(1);
    expect(stored()[0]).toMatchObject(multi);

    if (destination !== "marker") {
      expect(editor()).toBeNull();
      marker().click();
    }
    expect(editor().querySelectorAll("[data-reference-id]")).toHaveLength(2);
    button("Add element").click();
    pick(second);
    button("Save").click();
    expect(stored()[0]!.references).toEqual([first, second, expect.objectContaining({ id: "element3", targetLabel: second.targetLabel })]);
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
    expect(stored()[0]!.comment).toBe("Fix [element1: SaveButton] [element1: CancelButton]");
  });

  it.each(["standard", "forensic"] as const)("copies every reference in %s output", async (detail) => {
    const formatted = formatAnnotations([multi], detail, PAGE_URL);
    expect(formatted).toContain(`### 1. ${multi.comment}\n\n#### [element1: SaveButton]`);
    expect(formatted.match(/^- \*\*URL:\*\*/gm)).toHaveLength(1);
    for (const reference of [first, second]) {
      for (const line of [
        `#### [${reference.id}: ${reference.targetLabel}]`,
        `- **Source:** ${reference.source}`,
        `- **Used at:** ${reference.usageSource}`,
        `- **Component:** ${reference.component}`,
        `- **Target:** \`${reference.targetLabel}\``,
        `- **UI text:** \`${reference.uiText}\``,
        `- **Locator:** ${reference.locator}`,
        ...(detail === "forensic" ? [`- **DOM hint:** \`${reference.domHint}\``] : []),
      ]) {
        expect(formatted.split("\n").filter(value => value === line)).toHaveLength(1);
      }
      expect(formatted.includes(reference.domHint!)).toBe(detail === "forensic");
    }
    expect(formatSingleAnnotationPreview(multi, detail, PAGE_URL)).toBe(formatted.slice(formatted.indexOf("### 1.")).trim());
    seed(multi);
    localStorage.setItem("vpg-annotator-settings", JSON.stringify({ outputDetail: detail }));
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mount();
    button("Preview annotations").click();
    expect(document.querySelector<HTMLTextAreaElement>(".vpg-annotator-panel--preview textarea")!.value).toBe(formatted);
    button("Copy annotations").click();
    expect(writeText).toHaveBeenCalledWith(formatted);
  });

  it.each([{ references: undefined }, { references: [] }, { references: [second] }])("keeps the original target when its pill is absent: %j", ({ references }) => {
    const formatted = formatAnnotations([{ ...multi, references }], "standard", PAGE_URL);
    expect(formatted).toContain(`### 1. ${multi.comment}\n- **Source:** ${first.source}`);
    expect(formatted).toContain(`- **Used at:** ${first.usageSource}`);
  });

  it.each(["targetLabel", "source", "usageSource", "locator", "domHint"] as const)("keeps the original target when a reference differs in %s", (field) => {
    const formatted = formatAnnotations([{ ...multi, references: [{ ...first, [field]: "different target" }] }], "standard", PAGE_URL);
    expect(formatted).toContain(`### 1. ${multi.comment}\n- **Source:** ${first.source}`);
  });

  it("finds a matching target beyond the first reference, ignoring display text and component changes", () => {
    const formatted = formatAnnotations([{
      ...multi,
      references: [second, { ...first, component: "UpdatedButton", uiText: "Save changes" }],
    }], "standard", PAGE_URL);
    expect(formatted).toContain(`### 1. ${multi.comment}\n\n#### [element2: CancelButton]`);
    expect(formatted).not.toContain("- **UI text:** `Save`");
  });

  it.each([PAGE_URL, "https://example.com/note", "https://example.com/other", undefined])("prints only reference URLs distinct from the note and batch: %j", (pageUrl) => {
    const formatted = formatAnnotations([{
      ...multi,
      pageUrl: "https://example.com/note",
      references: [{ ...first, pageUrl }],
    }], "standard", PAGE_URL);
    const urls = formatted.split("\n").filter(line => line.startsWith("- **URL:**"));
    expect(urls).toEqual([
      `- **URL:** ${PAGE_URL}`,
      ...(pageUrl === "https://example.com/other" ? [`- **URL:** ${pageUrl}`] : []),
    ]);
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

  it.each(["locator", "usageSource", "component", "uiText", "pageUrl"] as const)("keeps a note when a handler mutates nested %s", async (field) => {
    seed(multi);
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = (annotations) => {
      annotations[0]!.references![1]![field] = "updated metadata";
      return true;
    };
    mount();
    button("Submit annotations").click();
    await vi.waitFor(() => expect(stored()[0]!.references![1]![field]).toBe("updated metadata"));
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
  it.each([
    ["Swap[element1: SaveButton]with [element2: CancelButton]", multi.comment],
    ["[element1: SaveButton][element2: CancelButton]", "[element1: SaveButton] [element2: CancelButton]"],
    ["([element1: SaveButton])", "( [element1: SaveButton] )"],
    ["Swap  [element1: SaveButton]\twith\n[element2: CancelButton]", "Swap  [element1: SaveButton]\twith\n[element2: CancelButton]"],
    ["[element1: SaveButton]", "[element1: SaveButton]"],
    ["literal[element3: AppSidebar]text", "literal[element3: AppSidebar]text"],
  ])("serializes pill boundaries idempotently: %j", (input, expected) => {
    let comment = new AnnotationCommentEditor(input, [first, second], vi.fn());
    for (let round = 0; round < 3; round += 1) {
      const saved = comment.read();
      expect(saved.comment).toBe(expected);
      comment = new AnnotationCommentEditor(saved.comment, saved.references, vi.fn());
    }
  });

  it("spaces pills across inline wrappers and empty text nodes, preserving line breaks", () => {
    const comment = new AnnotationCommentEditor("[element1: SaveButton]", [first], vi.fn());
    const pill = comment.element.querySelector("[data-reference-id]")!;
    const wrapper = document.createElement("span");
    wrapper.append(pill);
    const suffix = document.createElement("span");
    suffix.textContent = "with";
    comment.element.replaceChildren(document.createTextNode("Swap"), wrapper, document.createTextNode(""), suffix);
    expect(comment.read().comment).toBe("Swap [element1: SaveButton] with");

    comment.element.insertBefore(document.createElement("br"), suffix);
    const line = document.createElement("div");
    line.textContent = "next line";
    comment.element.append(line);
    expect(comment.read().comment).toBe("Swap [element1: SaveButton]\nwith\nnext line");
  });

  it("leaves deletion across a line break to the browser", () => {
    const comment = new AnnotationCommentEditor("[element1: SaveButton]", [first], vi.fn());
    document.body.append(comment.element);
    const line = document.createElement("div");
    line.textContent = "Next line";
    comment.element.append(line);
    caret(line.firstChild!, 0);
    const event = new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true });
    comment.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(comment.read().references).toEqual([first]);
  });

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
