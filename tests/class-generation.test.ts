// @vitest-environment node
import { describe, expect, it } from "vitest";

import { __internal, templateAttributeValue } from "../utils";

describe("class-generation getMethodTools helpers", () => {
  it("replaces any ${...} interpolation with ${key}", () => {
    expect(__internal.toPomKeyPattern(templateAttributeValue("submenu-item-${item.id}"))).toEqual({ formatted: "submenu-item-${key}", templateVariables: ["key"] });
    expect(__internal.toPomKeyPattern(templateAttributeValue("Foo-${bar.baz}-routerlink"))).toEqual({ formatted: "Foo-${key}-routerlink", templateVariables: ["key"] });
  });

  it("replaces multiple and nested template expressions safely", () => {
    // Multiple expressions become multiple `${key}` placeholders (one `key` variable)
    expect(__internal.toPomKeyPattern(templateAttributeValue("a-${x}-b-${y}-c"))).toEqual({ formatted: "a-${key}-b-${key}-c", templateVariables: ["key"] });

    // Nested braces inside an expression should be consumed as part of the expression
    expect(__internal.toPomKeyPattern(templateAttributeValue("x-${fn({ a: 1, b: { c: 2 } })}-y"))).toEqual({ formatted: "x-${key}-y", templateVariables: ["key"] });

    // Expressions that contain `${...}` text inside string literals should not be split into fragments
    // (this simulates the real-world failure mode described in the generator comment)
    expect(__internal.toPomKeyPattern(templateAttributeValue("x-${str.replace('${notATemplate}', 'ok')}-y"))).toEqual({ formatted: "x-${key}-y", templateVariables: ["key"] });
  });

  it("creates a safe method name even with dynamic placeholders", () => {
    // placeholders should be removed from method names to avoid invalid identifiers
    expect(__internal.safeMethodNameFromParts(["submenu", "item", "${key}"])).toBe("SubmenuItem");
    expect(__internal.safeMethodNameFromParts(["${key}"])).toBe("Element");
  });
});
