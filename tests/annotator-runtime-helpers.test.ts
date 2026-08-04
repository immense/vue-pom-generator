// @vitest-environment node
//
// Covers the pure, side-effect-free helpers in the annotator runtime. These
// helpers operate on plain strings (display text, file paths, placement tokens)
// — no DOM access — so they can be exercised directly in a node environment.
import { describe, expect, it } from "vitest";

import { __internal as clientInternal } from "../plugin/runtime/annotator/client";
import { __internal as pluginInternal } from "../plugin/runtime/annotator/plugin";
import { normalizeInlineText } from "../plugin/runtime/annotator/text-utils";
import { __internal as vueDetectorInternal, formatSourceLabel } from "../plugin/runtime/annotator/vue-detector";

describe("normalizeInlineText", () => {
  it("collapses whitespace runs and trims ends", () => {
    expect(normalizeInlineText("  foo\n  bar ")).toBe("foo bar");
  });

  it("returns undefined for blank input", () => {
    expect(normalizeInlineText("   ")).toBeUndefined();
    expect(normalizeInlineText("")).toBeUndefined();
    expect(normalizeInlineText(undefined)).toBeUndefined();
  });

  it("preserves non-blank single-token input", () => {
    expect(normalizeInlineText("save")).toBe("save");
  });
});

describe("normalizePathSeparators", () => {
  it("converts backslashes to forward slashes", () => {
    expect(pluginInternal.normalizePathSeparators("src\\widgets\\Item.vue")).toBe("src/widgets/Item.vue");
  });

  it("leaves posix paths unchanged", () => {
    expect(pluginInternal.normalizePathSeparators("src/widgets/Item.vue")).toBe("src/widgets/Item.vue");
  });

  it("handles mixed separators", () => {
    expect(pluginInternal.normalizePathSeparators("src\\widgets/Item.vue")).toBe("src/widgets/Item.vue");
  });
});

describe("placementPrimarySide", () => {
  it("returns the side before the first dash", () => {
    expect(clientInternal.placementPrimarySide("top-start")).toBe("top");
    expect(clientInternal.placementPrimarySide("right-end")).toBe("right");
  });

  it("returns the whole token when there is no dash", () => {
    expect(clientInternal.placementPrimarySide("bottom")).toBe("bottom");
  });
});

describe("vue-detector string helpers", () => {
  it("ignoredComponentNamePattern matches synthetic runtime names", () => {
    expect(vueDetectorInternal.ignoredComponentNamePattern.test("template")).toBe(true);
    expect(vueDetectorInternal.ignoredComponentNamePattern.test("slot")).toBe(true);
    expect(vueDetectorInternal.ignoredComponentNamePattern.test("items[0].template")).toBe(true);
    expect(vueDetectorInternal.ignoredComponentNamePattern.test("UserCard")).toBe(false);
  });

  it("stripSourcePosition drops a trailing line:column", () => {
    expect(vueDetectorInternal.stripSourcePosition("src/Foo.vue:12:3")).toBe("src/Foo.vue");
    expect(vueDetectorInternal.stripSourcePosition("src/Foo.vue")).toBe("src/Foo.vue");
  });

  it("inferNameFromFile derives a name from a file path", () => {
    expect(vueDetectorInternal.inferNameFromFile("src/widgets/Item.vue")).toBe("Item");
    expect(vueDetectorInternal.inferNameFromFile("src/widgets/Item.vue:4:2")).toBe("Item");
    expect(vueDetectorInternal.inferNameFromFile("")).toBeNull();
  });

  it("isComponentLikeSourceTag recognizes Vue component tags", () => {
    expect(vueDetectorInternal.isComponentLikeSourceTag("UserCard")).toBe(true);
    expect(vueDetectorInternal.isComponentLikeSourceTag("my-button")).toBe(true);
    expect(vueDetectorInternal.isComponentLikeSourceTag("div")).toBe(false);
    expect(vueDetectorInternal.isComponentLikeSourceTag(null)).toBe(false);
  });

  it("formatSourceLabel trims to the frontend/src portion and optionally keeps position", () => {
    expect(formatSourceLabel("/x/frontend/src/Foo.vue:4:2")).toBe("src/Foo.vue:4:2");
    expect(formatSourceLabel("/x/frontend/src/Foo.vue:4:2", false)).toBe("src/Foo.vue");
    expect(formatSourceLabel("src/Foo.vue")).toBe("src/Foo.vue");
  });
});
