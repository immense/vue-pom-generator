// @vitest-environment node
import { describe, expect, it } from "vitest";

import { __internal, toPascalCase } from "../utils";

describe("utils", () => {
  it("toPascalCase converts separators into PascalCase", () => {
    expect(toPascalCase("hello world")).toBe("HelloWorld");
    expect(toPascalCase("hello-world")).toBe("HelloWorld");
    expect(toPascalCase("hello_world")).toBe("HelloWorld");
    expect(toPascalCase("user.profile.name")).toBe("UserProfileName");
  });

  it("toPascalCase strips interpolation remnants", () => {
    expect(toPascalCase("text_${id}_more")).toBe("TextMore");
  });

  it("isSimpleScopeIdentifier uses the AST to distinguish bare identifiers from expressions", () => {
    expect(__internal.isSimpleScopeIdentifier("data")).toBe(true);
    expect(__internal.isSimpleScopeIdentifier("$slot")).toBe(true);
    expect(__internal.isSimpleScopeIdentifier("data.key")).toBe(false);
    expect(__internal.isSimpleScopeIdentifier("{ data }")).toBe(false);
    expect(__internal.isSimpleScopeIdentifier("data ?? fallback")).toBe(false);
  });

  it("splitNullishCoalescingExpression flattens top-level nullish chains with AST source slices", () => {
    expect(__internal.splitNullishCoalescingExpression("data.key ?? getKey(data) ?? data")).toEqual([
      "data.key",
      "getKey(data)",
      "data",
    ]);
  });
});

