// @vitest-environment node
import { describe, expect, it } from "vitest";

import { resolveGenerationSupportOptions } from "../plugin/resolved-generation-options";

describe("resolved generation options", () => {
  it("defaults accessibilityAudit to false", () => {
    expect(resolveGenerationSupportOptions({}).accessibilityAudit).toBe(false);
  });

  it("preserves an explicit accessibilityAudit flag", () => {
    expect(resolveGenerationSupportOptions({ accessibilityAudit: true }).accessibilityAudit).toBe(true);
  });

  it("leaves Vue Test Utils generation disabled by default", () => {
    expect(resolveGenerationSupportOptions({}).vueTestUtilsOutDir).toBeUndefined();
  });

  it("normalizes a configured Vue Test Utils output directory", () => {
    expect(resolveGenerationSupportOptions({ vueTestUtilsOutDir: " tests/unit/generated " }).vueTestUtilsOutDir)
      .toBe("tests/unit/generated");
  });
});
