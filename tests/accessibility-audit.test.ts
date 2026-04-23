// @vitest-environment node
import { ElementTypes } from "@vue/compiler-core";
import { describe, expect, it } from "vitest";

import { buildAccessibilityAudit, collectAccessibilityReviewWarnings } from "../accessibility-audit";

describe("accessibility audit", () => {
  it("treats static button text as an accessible-name signal", () => {
    expect(buildAccessibilityAudit({
      testId: "UserListPage-Save-button",
      tag: "button",
      tagType: ElementTypes.ELEMENT,
      staticTextContent: "Save",
    }, "button")).toEqual({
      needsReview: false,
      accessibleNameSource: "text",
      reasons: [],
      staticTextContent: "Save",
    });
  });

  it("flags form fields with no inline accessible-name signal for review", () => {
    expect(buildAccessibilityAudit({
      testId: "UserListPage-Search-input",
      tag: "input",
      tagType: ElementTypes.ELEMENT,
    }, "input")).toEqual({
      needsReview: true,
      accessibleNameSource: "unknown",
      reasons: [
        "No inline accessible-name signal was found; the element may rely on external markup such as a separate <label>.",
      ],
    });
  });

  it("formats review warnings from manifest-shaped data", () => {
    expect(collectAccessibilityReviewWarnings({
      UserListPage: {
        entries: [{
          testId: "UserListPage-Search-input",
          generatedPropertyName: "SearchInput",
          inferredRole: "input",
          accessibility: {
            needsReview: true,
            accessibleNameSource: "unknown",
            reasons: ["No inline accessible-name signal was found; the element may rely on external markup such as a separate <label>."],
          },
        }],
      },
    })).toEqual([
      "[vue-pom-generator] Accessibility review suggested for UserListPage.SearchInput (role=input, testId=\"UserListPage-Search-input\"): No inline accessible-name signal was found; the element may rely on external markup such as a separate <label>.",
    ]);
  });
});
