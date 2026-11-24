import { referenceText, type AnnotationReference } from "./format";

/** A plain-text comment with atomic element pills. No page or clipboard HTML is inserted. */
export class AnnotationCommentEditor {
  readonly element = document.createElement("div");
  private readonly references = new Map<string, AnnotationReference>();
  private selection: Range | null = null;
  private nextId = 1;

  constructor(comment: string, references: AnnotationReference[], private readonly onChange: () => void) {
    this.element.className = "vpg-annotator-comment";
    this.element.contentEditable = "true";
    this.element.setAttribute("role", "textbox");
    this.element.setAttribute("aria-label", "Comment");
    this.element.setAttribute("aria-multiline", "true");
    this.element.setAttribute("data-placeholder", "Add a comment...");
    for (const reference of references) {
      this.references.set(reference.id, { ...reference });
    }
    this.element.append(this.fragment(comment));
    this.element.addEventListener("input", () => {
      this.captureSelection();
      this.onChange();
    });
    this.element.addEventListener("beforeinput", (event) => {
      if (event.isComposing || (event.inputType !== "deleteContentBackward" && event.inputType !== "deleteContentForward")) {
        return;
      }
      this.captureSelection();
      const range = this.range();
      if (range.collapsed) {
        const pill = this.adjacentPill(range, event.inputType === "deleteContentBackward");
        if (pill) {
          event.preventDefault();
          this.removePill(pill);
        }
      }
    });
    for (const event of ["keyup", "mouseup", "blur"]) {
      this.element.addEventListener(event, () => this.captureSelection());
    }
    this.element.addEventListener("paste", (event) => {
      event.preventDefault();
      if (event.clipboardData) {
        this.captureSelection();
        this.insert(this.fragment(event.clipboardData.getData("text/plain")));
      }
    });
    // Dropped HTML must not create editable markup or counterfeit reference nodes.
    this.element.addEventListener("drop", event => event.preventDefault());
    for (const type of ["copy", "cut"] as const) {
      this.element.addEventListener(type, (event) => {
        if (!event.clipboardData) {
          return;
        }
        this.captureSelection();
        const range = this.range();
        event.preventDefault();
        event.clipboardData.setData("text/plain", this.text(range.cloneContents()));
        if (type === "cut") {
          range.deleteContents();
          this.selection = range;
          this.onChange();
        }
      });
    }
  }

  captureSelection() {
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (this.element.contains(range.commonAncestorContainer)) {
        this.selection = range.cloneRange();
      }
    }
  }

  focus() {
    this.element.focus();
    const selection = window.getSelection();
    const range = this.range();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  addReference(target: Omit<AnnotationReference, "id">) {
    while (this.references.has(`element${this.nextId}`)) {
      this.nextId += 1;
    }
    const reference = { ...target, id: `element${this.nextId++}` };
    this.references.set(reference.id, reference);
    this.insert(this.pill(reference));
  }

  read(): { comment: string; references: AnnotationReference[] } {
    const ids = new Set(Array.from(this.element.querySelectorAll<HTMLElement>("[data-reference-id]"), pill => pill.dataset.referenceId!));
    return {
      comment: this.text(this.element),
      references: Array.from(ids, id => ({ ...this.reference(id) })),
    };
  }

  private reference(id: string): AnnotationReference {
    const reference = this.references.get(id);
    if (!reference) {
      throw new Error(`Unknown annotation reference: ${id}`);
    }
    return reference;
  }

  private range(): Range {
    if (this.selection && this.element.contains(this.selection.commonAncestorContainer)) {
      return this.selection;
    }
    const range = document.createRange();
    range.selectNodeContents(this.element);
    range.collapse(false);
    return range;
  }

  private insert(node: Node) {
    const range = this.range();
    range.deleteContents();
    // A trailing text node gives the caret a position outside a noneditable pill.
    const caret = document.createTextNode("");
    const fragment = document.createDocumentFragment();
    fragment.append(node, caret);
    range.insertNode(fragment);
    range.setStart(caret, 0);
    range.collapse(true);
    this.selection = range;
    this.focus();
    this.onChange();
  }

  private adjacentPill(range: Range, backward: boolean): HTMLElement | null {
    let node = range.startContainer;
    const offset = range.startOffset;
    if (node.nodeType === Node.TEXT_NODE && offset !== (backward ? 0 : node.textContent!.length)) {
      return null;
    }
    let neighbor: Node | null = node.nodeType === Node.TEXT_NODE
      ? null
      : node.childNodes[backward ? offset - 1 : offset] ?? null;
    while (true) {
      while (!neighbor && node !== this.element) {
        if (node instanceof HTMLElement && (node.tagName === "DIV" || node.tagName === "P")) {
          return null;
        }
        neighbor = backward ? node.previousSibling : node.nextSibling;
        node = node.parentNode!;
      }
      if (!neighbor) {
        return null;
      }
      if (neighbor instanceof HTMLElement && neighbor.dataset.referenceId) {
        return neighbor;
      }
      if (neighbor.nodeType !== Node.TEXT_NODE || neighbor.textContent) {
        return null;
      }
      node = neighbor;
      neighbor = null;
    }
  }

  private removePill(pill: HTMLElement) {
    const range = document.createRange();
    range.setStartBefore(pill);
    range.collapse(true);
    pill.remove();
    this.selection = range;
    this.focus();
    this.onChange();
  }

  private pill(reference: AnnotationReference): HTMLElement {
    const pill = document.createElement("span");
    pill.className = "vpg-annotator-reference";
    pill.contentEditable = "false";
    pill.dataset.referenceId = reference.id;
    pill.title = [reference.source, reference.locator].filter(Boolean).join("\n");
    pill.append(document.createTextNode(referenceText(reference)));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "vpg-annotator-reference-remove";
    remove.setAttribute("aria-label", `Remove ${reference.id}`);
    remove.textContent = "×";
    remove.addEventListener("mousedown", event => event.preventDefault());
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.removePill(pill);
    });
    pill.append(remove);
    return pill;
  }

  private fragment(text: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    while (offset < text.length) {
      let next: AnnotationReference | undefined;
      let nextIndex = text.length;
      for (const reference of this.references.values()) {
        const index = text.indexOf(referenceText(reference), offset);
        if (index >= 0 && index < nextIndex) {
          next = reference;
          nextIndex = index;
        }
      }
      fragment.append(document.createTextNode(text.slice(offset, nextIndex)));
      if (!next) {
        break;
      }
      fragment.append(this.pill(next));
      offset = nextIndex + referenceText(next).length;
    }
    return fragment;
  }

  private text(node: Node): string {
    let result = "";
    let afterPill = false;
    const append = (value: string, pill = false) => {
      if (!value) {
        return;
      }
      if ((pill || afterPill) && result.slice(-1).trim() && value.slice(0, 1).trim()) {
        result += " ";
      }
      result += value;
      afterPill = pill;
    };
    // Share pill boundaries across inline wrappers and empty caret text nodes.
    const visit = (current: Node) => {
      if (current.nodeType === Node.TEXT_NODE) {
        append(current.textContent ?? "");
        return;
      }
      if (current instanceof HTMLElement && current.dataset.referenceId) {
        append(referenceText(this.reference(current.dataset.referenceId)), true);
        return;
      }
      if (current instanceof HTMLBRElement) {
        append("\n");
        return;
      }
      for (const child of current.childNodes) {
        const block = child instanceof HTMLElement && (child.tagName === "DIV" || child.tagName === "P");
        if (block && result && !result.endsWith("\n")) {
          append("\n");
        }
        visit(child);
        if (block && child.nextSibling && !result.endsWith("\n")) {
          append("\n");
        }
      }
    };
    visit(node);
    return result;
  }
}
