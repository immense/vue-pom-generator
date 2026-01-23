// @vitest-environment node
import { describe, expect, it } from "vitest";

import { toPascalCase } from "../utils";

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
});


