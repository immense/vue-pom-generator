// @vitest-environment jsdom
//
// The annotator ships in built applications (PR release builds run Vite in
// preview mode, where the annotator is enabled), so it must stay completely
// inert to keyboard input: global single-letter shortcuts break text entry
// surfaces like the Monaco terminal editor, where the annotator's capture
// phase keydown handler fires before the editor's own keybinding service and
// isEditableTarget does not recognize Monaco's event target. All control
// surface is toolbar-driven.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountAnnotatorClient } from "../plugin/runtime/annotator/client";

const SHORTCUT_KEYS = ["s", "p", "c", "x", ",", "Escape"];

describe("annotator keyboard policy", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete (window as unknown as Record<string, unknown>).__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__;
  });

  it("binds no window keydown listener at mount", () => {
    const keydownListeners: EventListener[] = [];
    const original = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "keydown") {
        keydownListeners.push(listener as EventListener);
      }
      return original(type, listener, options);
    });

    mountAnnotatorClient({
      sourceAttribute: "data-testid",
      metadataAttributePrefix: "data-v-pom",
      outputDetail: "standard",
      copyToClipboard: true,
      showComponentTree: false,
    });

    expect(keydownListeners).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("ignores every former shortcut key", () => {
    mountAnnotatorClient({
      sourceAttribute: "data-testid",
      metadataAttributePrefix: "data-v-pom",
      outputDetail: "standard",
      copyToClipboard: true,
      showComponentTree: false,
    });

    for (const key of SHORTCUT_KEYS) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }

    const highlight = document.querySelector<HTMLElement>(".vpg-annotator-highlight");
    expect(highlight).not.toBeNull();
    expect(highlight!.hidden).toBe(true);
  });
});

