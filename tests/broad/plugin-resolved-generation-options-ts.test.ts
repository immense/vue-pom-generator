// @vitest-environment node
import { describe, expect, it } from "vitest";

import { resolveGenerationSupportOptions } from "../../plugin/resolved-generation-options";

describe("resolveGenerationSupportOptions", () => {
  it("uses default outDir when not provided", () => {
    expect(resolveGenerationSupportOptions({}).outDir).toBe("tests/playwright/__generated__");
  });

  it("trims a provided outDir", () => {
    expect(resolveGenerationSupportOptions({ outDir: "  out/dir  " }).outDir).toBe("out/dir");
  });

  it("falls back to default testIdAttribute when the provided one trims to empty", () => {
    expect(resolveGenerationSupportOptions({ testIdAttribute: "   " }).testIdAttribute).toBe("data-testid");
  });

  it("trims a provided non-empty testIdAttribute", () => {
    expect(resolveGenerationSupportOptions({ testIdAttribute: "  data-qa  " }).testIdAttribute).toBe("data-qa");
  });

  it("defaults emitLanguages to ['ts']", () => {
    expect(resolveGenerationSupportOptions({}).emitLanguages).toEqual(["ts"]);
  });

  it("uses provided emitLanguages when non-empty", () => {
    expect(resolveGenerationSupportOptions({ emitLanguages: ["ts", "csharp"] }).emitLanguages).toEqual(["ts", "csharp"]);
  });
});
