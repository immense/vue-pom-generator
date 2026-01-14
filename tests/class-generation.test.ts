import { describe, expect, it } from "vitest";

import { __internal } from "../utils";

describe("class-generation getMethodTools helpers", () => {
  it("replaces any ${...} interpolation with ${key}", () => {
    expect(__internal.replaceAllTemplateExpressionsWithKey("submenu-item-${item.id}")).toBe("submenu-item-${key}");
    expect(__internal.replaceAllTemplateExpressionsWithKey("Foo-${bar.baz}-routerlink")).toBe("Foo-${key}-routerlink");
  });

  it("replaces multiple and nested template expressions safely", () => {
    // Multiple expressions become multiple `${key}` placeholders
    expect(__internal.replaceAllTemplateExpressionsWithKey("a-${x}-b-${y}-c")).toBe("a-${key}-b-${key}-c");

    // Nested braces inside an expression should be consumed as part of the expression
    expect(__internal.replaceAllTemplateExpressionsWithKey("x-${fn({ a: 1, b: { c: 2 } })}-y")).toBe("x-${key}-y");

    // Expressions that contain `${...}` text inside string literals should not be split into fragments
    // (this simulates the real-world failure mode described in the generator comment)
    expect(__internal.replaceAllTemplateExpressionsWithKey("x-${str.replace('${notATemplate}', 'ok')}-y")).toBe("x-${key}-y");
  });

  it("creates a safe method name even with dynamic placeholders", () => {
    // placeholders should be removed from method names to avoid invalid identifiers
    expect(__internal.safeMethodNameFromParts(["submenu", "item", "${key}"])).toBe("SubmenuItem");
    expect(__internal.safeMethodNameFromParts(["${key}"])).toBe("Element");
  });
});
