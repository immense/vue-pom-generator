// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ElementMetadata } from "../../metadata-collector";
import { buildAccessibilityAudit, collectAccessibilityReviewWarnings } from "../../accessibility-audit";

function makeMetadata(overrides: Partial<ElementMetadata> = {}): ElementMetadata {
  return {
    testId: "test",
    tag: "button",
    tagType: 0,
    dynamicProps: [],
    ...overrides,
  } as ElementMetadata;
}

describe("accessibility-audit.ts buildAccessibilityAudit", () => {
  it("returns undefined when metadata is missing or role is null", () => {
    expect(buildAccessibilityAudit(undefined, "button")).toBeUndefined();
    expect(buildAccessibilityAudit(makeMetadata(), null)).toBeUndefined();
  });

  it("treats missing dynamicProps as an empty set (missing branch)", () => {
    const meta = { testId: "x", tag: "div", tagType: 0 } as ElementMetadata;
    const result = buildAccessibilityAudit(meta, "link");
    expect(result?.accessibleNameSource).toBe("missing");
  });

  it("prefers static aria-label as the accessible name source", () => {
    const result = buildAccessibilityAudit(
      makeMetadata({ staticAriaLabel: "Save" }),
      "button",
    );
    expect(result?.accessibleNameSource).toBe("aria-label");
    expect(result?.needsReview).toBe(false);
    expect(result?.staticAriaLabel).toBe("Save");
  });

  it("uses static text content for inline-text roles (button/radio)", () => {
    const result = buildAccessibilityAudit(
      makeMetadata({ staticTextContent: "Submit" }),
      "button",
    );
    expect(result?.accessibleNameSource).toBe("text");
    expect(result?.staticTextContent).toBe("Submit");
    expect(result?.needsReview).toBe(false);
  });

  it("falls back to title when role does not support inline text and no aria-label", () => {
    const result = buildAccessibilityAudit(
      makeMetadata({ staticTitle: "Info" }),
      "link",
    );
    expect(result?.accessibleNameSource).toBe("title");
    expect(result?.staticTitle).toBe("Info");
  });

  it("reports dynamic when only dynamic accessible-name signals are present", () => {
    const result = buildAccessibilityAudit(
      makeMetadata({ dynamicProps: ["aria-label"], hasDynamicText: false }),
      "button",
    );
    expect(result?.accessibleNameSource).toBe("dynamic");
    expect(result?.needsReview).toBe(false);
  });

  it("reports dynamic for dynamic title prop", () => {
    const result = buildAccessibilityAudit(
      makeMetadata({ dynamicProps: ["title"] }),
      "link",
    );
    expect(result?.accessibleNameSource).toBe("dynamic");
  });

  it("reports dynamic when hasDynamicText is set", () => {
    const result = buildAccessibilityAudit(
      makeMetadata({ hasDynamicText: true }),
      "link",
    );
    expect(result?.accessibleNameSource).toBe("dynamic");
  });

  it("reports unknown for input role with no accessible-name signal and pushes a reason", () => {
    const result = buildAccessibilityAudit(makeMetadata(), "input");
    expect(result?.accessibleNameSource).toBe("unknown");
    expect(result?.needsReview).toBe(true);
    expect(result?.reasons.length).toBeGreaterThan(0);
    expect(result?.reasons[0]).toMatch(/label/i);
  });

  it("reports unknown for select role with no accessible-name signal", () => {
    const result = buildAccessibilityAudit(makeMetadata(), "select");
    expect(result?.accessibleNameSource).toBe("unknown");
    expect(result?.needsReview).toBe(true);
  });

  it("reports missing for other roles with no accessible-name signal", () => {
    const result = buildAccessibilityAudit(makeMetadata(), "link");
    expect(result?.accessibleNameSource).toBe("missing");
    expect(result?.needsReview).toBe(true);
    expect(result?.reasons[0]).toMatch(/no compile-time/i);
  });

  it("includes staticRole in the result when present", () => {
    const result = buildAccessibilityAudit(
      makeMetadata({ staticRole: "navigation", staticAriaLabel: "Main" }),
      "link",
    );
    expect(result?.staticRole).toBe("navigation");
  });

  it("normalizes vselect role to select when choosing input/select branch", () => {
    const result = buildAccessibilityAudit(makeMetadata(), "vselect");
    expect(result?.accessibleNameSource).toBe("unknown");
  });
});

describe("accessibility-audit.ts collectAccessibilityReviewWarnings", () => {
  it("collects warnings for entries that need review, using generatedPropertyName", () => {
    const manifest: Parameters<typeof collectAccessibilityReviewWarnings>[0] = {
      MyComp: {
        entries: [
          {
            testId: "my-input",
            generatedPropertyName: "myInput",
            inferredRole: "input",
            accessibility: {
              needsReview: true,
              accessibleNameSource: "unknown",
              reasons: ["No inline accessible-name signal was found."],
            },
          },
        ],
      },
    };

    const warnings = collectAccessibilityReviewWarnings(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MyComp.myInput");
    expect(warnings[0]).toContain("role=input");
    expect(warnings[0]).toContain('"my-input"');
  });

  it("falls back to testId in the warning label when generatedPropertyName is null", () => {
    const manifest: Parameters<typeof collectAccessibilityReviewWarnings>[0] = {
      OtherComp: {
        entries: [
          {
            testId: "raw-link",
            generatedPropertyName: null,
            inferredRole: null,
            accessibility: {
              needsReview: true,
              accessibleNameSource: "missing",
              reasons: ["No compile-time accessible-name signal was found."],
            },
          },
        ],
      },
    };

    const warnings = collectAccessibilityReviewWarnings(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OtherComp.raw-link");
    expect(warnings[0]).toContain("role=unknown");
  });

  it("skips entries that do not need review", () => {
    const manifest: Parameters<typeof collectAccessibilityReviewWarnings>[0] = {
      A: {
        entries: [
          {
            testId: "ok",
            generatedPropertyName: "ok",
            inferredRole: "button",
            accessibility: { needsReview: false, accessibleNameSource: "aria-label", reasons: [] },
          },
          {
            testId: "bad",
            generatedPropertyName: null,
            inferredRole: "link",
            accessibility: { needsReview: true, accessibleNameSource: "missing", reasons: ["x"] },
          },
        ],
      },
    };

    const warnings = collectAccessibilityReviewWarnings(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("A.bad");
  });

  it("returns no warnings for an empty manifest", () => {
    expect(collectAccessibilityReviewWarnings({})).toEqual([]);
  });
});
