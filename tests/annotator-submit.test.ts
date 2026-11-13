// @vitest-environment jsdom
//
// Submit hook: an app registers a handler on window at runtime, the toolbar then offers Submit, and
// Submit hands over the whole queue at once so feedback that belongs together is sent together.
// Failure keeps the queue, double-clicks during flight are ignored, and annotations added while the
// handler runs survive a resolving submit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __internal, mountAnnotatorClient } from "../plugin/runtime/annotator/client";
import type { AnnotatorSubmitHandler } from "../plugin/runtime/annotator/client";

const PAGE_URL = window.location.href;
const ANNOTATIONS_STORAGE_KEY = __internal.annotationsStorageKey;

function seedAnnotations(count: number) {
  const records = Array.from({ length: count }, (_, index) => ({
    id: `annotation-${index + 1}`,
    comment: `feedback item ${index + 1}`,
    targetLabel: `Button ${index + 1}`,
    source: `/w/app/src/Page.vue:${10 + index}:3`,
    pageUrl: PAGE_URL,
    pageX: 100,
    pageY: 100,
  }));
  sessionStorage.setItem(ANNOTATIONS_STORAGE_KEY, JSON.stringify({ [PAGE_URL]: records }));
}

function mount() {
  return mountAnnotatorClient({
    sourceAttribute: "data-testid",
    metadataAttributePrefix: "data-v-pom",
    outputDetail: "standard",
    copyToClipboard: true,
    showComponentTree: false,
  });
}

const submitButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Submit annotations"]');
const storedCount = () => (JSON.parse(sessionStorage.getItem(ANNOTATIONS_STORAGE_KEY) ?? "{}")[PAGE_URL] ?? []).length;
const toast = () => document.querySelector(".vpg-annotator-toast")?.textContent;

function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("annotator submit hook", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sessionStorage.clear();
    delete window.__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__;
    delete window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__;
  });
  afterEach(() => vi.restoreAllMocks());

  it("offers no Submit button until an app registers a handler", () => {
    seedAnnotations(1);
    mount();
    expect(submitButton()).toBeNull();
  });

  it("shows and removes Submit as the handler registers and unregisters", () => {
    seedAnnotations(1);
    const runtime = mount();
    expect(submitButton()).toBeNull();

    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = () => true;
    runtime.refresh();
    expect(submitButton()).not.toBeNull();

    delete window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__;
    runtime.refresh();
    expect(submitButton()).toBeNull();
  });

  it("hands over every queued annotation at once, then clears the queue", async () => {
    seedAnnotations(2);
    const runtime = mount();
    const handler = vi.fn<AnnotatorSubmitHandler>(async () => true);
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = handler;
    runtime.refresh();

    submitButton()!.click();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const [annotations, context] = handler.mock.calls[0]!;
    expect(annotations.map(a => a.source)).toEqual(["/w/app/src/Page.vue:10:3", "/w/app/src/Page.vue:11:3"]);
    expect(annotations.map(a => a.pageUrl)).toEqual([PAGE_URL, PAGE_URL]);
    expect(context.pageUrl).toBe(PAGE_URL);
    await vi.waitFor(() => expect(storedCount()).toBe(0));
    await vi.waitFor(() => expect(toast()).toBe("Submitted"));
  });

  it("retains the queue with visible feedback unless the handler resolves true", async () => {
    seedAnnotations(1);
    const runtime = mount();
    const failureLog = vi.spyOn(console, "error").mockImplementation(() => {});

    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = () => false;
    runtime.refresh();
    submitButton()!.click();
    await vi.waitFor(() => expect(toast()).toBe("Submit failed"));
    expect(storedCount()).toBe(1);
    expect(failureLog).not.toHaveBeenCalled();

    const failure = new Error("offline");
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = () => {
      throw failure;
    };
    submitButton()!.click();
    await vi.waitFor(() => expect(toast()).toBe("Submit failed"));
    expect(storedCount()).toBe(1);
    expect(failureLog).toHaveBeenCalledExactlyOnceWith("[vue-pom-generator] Annotator submit handler failed", failure);

    // A JS caller can bypass the type and resolve without a boolean; the runtime must
    // defensively retain with the same visible feedback.
    // reason: exercising that defense requires an off-type handler.
    /* eslint-disable-next-line no-restricted-syntax */
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = (() => undefined) as unknown as AnnotatorSubmitHandler;
    submitButton()!.click();
    await vi.waitFor(() => expect(toast()).toBe("Submit failed"));
    expect(storedCount()).toBe(1);
  });

  it("retains an annotation edited while a submit is pending, clearing by id and content", async () => {
    seedAnnotations(2);
    const runtime = mount();
    const gate = deferred<boolean>();
    const handler = vi.fn<AnnotatorSubmitHandler>(() => gate.promise);
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = handler;
    runtime.refresh();

    submitButton()!.click();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0]![0].map(a => a.comment)).toEqual(["feedback item 1", "feedback item 2"]);

    // The user edits annotation 1 while the submit is pending.
    document.querySelector<HTMLButtonElement>(".vpg-annotator-marker")!.click();
    const comment = document.querySelector<HTMLTextAreaElement>(".vpg-annotator-comment")!;
    comment.value = "edited while pending";
    document.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!.click();

    gate.release(true);
    await vi.waitFor(() => expect(storedCount()).toBe(1));

    const remaining = JSON.parse(sessionStorage.getItem(ANNOTATIONS_STORAGE_KEY) ?? "{}")[PAGE_URL];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("annotation-1");
    expect(remaining[0]!.comment).toBe("edited while pending");
  });

  it("retains a record the handler mutated in place, since its content no longer matches", async () => {
    seedAnnotations(1);
    const runtime = mount();
    const gate = deferred<boolean>();
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = (annotations) => {
      annotations[0]!.comment = "mutated by handler";
      return gate.promise;
    };
    runtime.refresh();

    submitButton()!.click();
    gate.release(true);
    await vi.waitFor(() => expect(storedCount()).toBe(1));

    const remaining = JSON.parse(sessionStorage.getItem(ANNOTATIONS_STORAGE_KEY) ?? "{}")[PAGE_URL];
    expect(remaining[0]!.comment).toBe("mutated by handler");
  });

  it("ignores duplicate clicks while a submit is in flight, then submits again", async () => {
    seedAnnotations(2);
    const runtime = mount();
    const gate = deferred<boolean>();
    const handler = vi.fn<AnnotatorSubmitHandler>(() => gate.promise);
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = handler;
    runtime.refresh();

    submitButton()!.click();
    submitButton()!.click();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(storedCount()).toBe(2);

    gate.release(false); // decline so the queue is kept
    await vi.waitFor(() => expect(submitButton()!.disabled).toBe(false));
    submitButton()!.click();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls[1]![0]).toHaveLength(2);
    expect(storedCount()).toBe(2);
  });

  it("invokes the handler synchronously within the click gesture, before any await", () => {
    seedAnnotations(1);
    const runtime = mount();
    const order: string[] = [];
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = () => {
      order.push("handler");
      return true;
    };
    runtime.refresh();

    submitButton()!.click();
    order.push("after-click");

    // Popup flows rely on this: the handler runs inside the user gesture, so a
    // window.open before the handler's first await is allowed.
    expect(order).toEqual(["handler", "after-click"]);
  });

  it("keeps annotations added while a submit is in flight", async () => {
    seedAnnotations(1);
    const runtime = mount();
    const gate = deferred<boolean>();
    const handler = vi.fn<AnnotatorSubmitHandler>(() => gate.promise);
    window.__VUE_POM_GENERATOR_ANNOTATOR_SUBMIT__ = handler;
    runtime.refresh();

    submitButton()!.click();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    // A user adds another annotation through the normal inspect flow while the submit runs.
    // jsdom has no layout, so `elementsFromPoint` is undefined; stub the hit-test for the shield click.
    const target = document.createElement("button");
    target.textContent = "Late button";
    document.body.appendChild(target);
    Object.defineProperty(document, "elementsFromPoint", { value: () => [target], configurable: true });
    document.querySelector<HTMLButtonElement>('button[aria-label="Select element"]')!.click();
    document.querySelector(".vpg-annotator-shield")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 8, clientY: 8 }),
    );
    const comment = document.querySelector<HTMLTextAreaElement>(".vpg-annotator-comment")!;
    comment.value = "late feedback";
    document.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click();

    gate.release(true);
    await vi.waitFor(() => expect(storedCount()).toBe(1));

    const remaining = JSON.parse(sessionStorage.getItem(ANNOTATIONS_STORAGE_KEY) ?? "{}")[PAGE_URL];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.comment).toBe("late feedback");
    expect(handler.mock.calls[0]![0]).toHaveLength(1); // handler got the pre-flight snapshot only
    Reflect.deleteProperty(document, "elementsFromPoint");
  });
});
