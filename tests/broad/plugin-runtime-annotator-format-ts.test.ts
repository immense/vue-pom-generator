// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { formatAnnotations, formatSingleAnnotationPreview, type FormattedAnnotation } from "../../plugin/runtime/annotator/format";

const baseAnnotation: FormattedAnnotation = {
  comment: "  broken   link  ",
  targetLabel: "SubmitButton",
  source: "src/widgets/Submit.vue",
  component: "SubmitButton",
  uiText: "  submit  ",
  locator: "near `[data-testid=\"submit\"]`",
  domHint: "div > button#submit",
};

describe("formatAnnotations", () => {
  it("strips the URL scheme and renders header + url + viewport in forensic mode", () => {
    const out = formatAnnotations([baseAnnotation], "forensic", "https://app.example.com/page");
    expect(out).toContain("## Feedback — app.example.com/page");
    expect(out).toContain("- **URL:** https://app.example.com/page");
    // jsdom defines window, so the viewport line is present in forensic mode.
    expect(out).toMatch(/- \*\*Viewport:\*\* \d+x\d+/);
  });

  it("omits the viewport line in standard mode", () => {
    const out = formatAnnotations([baseAnnotation], "standard", "http://app.example.com/page");
    expect(out).not.toContain("Viewport");
    expect(out).toContain("## Feedback — app.example.com/page");
  });

  it("renders component, normalized UI text, locator, and forensic DOM hint", () => {
    const out = formatAnnotations([baseAnnotation], "forensic", "https://app.example.com");
    expect(out).toContain("### 1. broken link");
    expect(out).toContain("- **Source:** src/widgets/Submit.vue");
    expect(out).toContain("- **Component:** SubmitButton");
    expect(out).toContain("- **Target:** `SubmitButton`");
    expect(out).toContain("- **UI text:** `submit`");
    expect(out).toContain("- **Locator:** near `[data-testid=\"submit\"]`");
    expect(out).toContain("- **DOM hint:** `div > button#submit`");
  });

  it("falls back to targetLabel for the title when the comment is blank", () => {
    const out = formatAnnotations(
      [{ ...baseAnnotation, comment: "   " }],
      "standard",
      "https://app.example.com",
    );
    expect(out).toContain("### 1. SubmitButton");
  });

  it("falls back to a default source message when source is missing", () => {
    const out = formatAnnotations(
      [{ ...baseAnnotation, source: undefined }],
      "standard",
      "https://app.example.com",
    );
    expect(out).toContain("- **Source:** Unable to find component file path.");
  });

  it("omits component, UI text, locator, and DOM hint lines when those fields are absent/blank", () => {
    const out = formatAnnotations(
      [{
        comment: "note",
        targetLabel: "Thing",
        component: undefined,
        uiText: "   ",
        locator: "",
        domHint: "  ",
      }],
      "forensic",
      "https://app.example.com",
    );
    expect(out).not.toContain("**Component:**");
    expect(out).not.toContain("**UI text:**");
    expect(out).not.toContain("**Locator:**");
    expect(out).not.toContain("**DOM hint:**");
  });

  it("numbers multiple annotations sequentially", () => {
    const out = formatAnnotations(
      [baseAnnotation, { ...baseAnnotation, comment: "second" }],
      "standard",
      "https://app.example.com",
    );
    expect(out).toContain("### 1. broken link");
    expect(out).toContain("### 2. second");
  });
});

describe("formatSingleAnnotationPreview", () => {
  it("slices from the first heading and trims", () => {
    const preview = formatSingleAnnotationPreview(baseAnnotation, "standard", "https://app.example.com");
    expect(preview.startsWith("### 1.")).toBe(true);
    expect(preview).not.toContain("## Feedback");
  });
});
