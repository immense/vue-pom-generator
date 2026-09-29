// @vitest-environment jsdom
//
// Preview affordances: the preview button carries a live count badge (how
// many pieces of feedback will be previewed/copied), and the preview popout
// is sized so the full feedback text is readable in one view.
import { beforeEach, describe, expect, it } from "vitest";

import { mountAnnotatorClient } from "../plugin/runtime/annotator/client";

const PAGE_URL = window.location.href;

function seedAnnotations(count: number) {
  const records = Array.from({ length: count }, (_, index) => ({
    id: `annotation-${index + 1}`,
    comment: `feedback item ${index + 1}`,
    targetLabel: `Button ${index + 1}`,
    pageX: 100 + index * 20,
    pageY: 100,
  }));
  sessionStorage.setItem("vpg-annotator-annotations", JSON.stringify({ [PAGE_URL]: records }));
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

function previewButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Preview annotations"]');
  expect(button).not.toBeNull();
  return button!;
}

describe("annotator preview affordances", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sessionStorage.clear();
    delete (window as unknown as Record<string, unknown>).__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__;
  });

  it("opens a preview panel sized to read everything together", () => {
    seedAnnotations(2);
    mount();

    previewButton().click();

    const panel = document.querySelector<HTMLElement>(".vpg-annotator-panel--preview");
    expect(panel).not.toBeNull();
    const textarea = panel!.querySelector<HTMLTextAreaElement>(".vpg-annotator-textarea");
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toContain("feedback item 1");
    expect(textarea!.value).toContain("feedback item 2");
  });
});
