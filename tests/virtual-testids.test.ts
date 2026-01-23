// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createTestIdsVirtualModulesPlugin } from "../plugin/support/virtual-modules";

describe("virtual:testids", () => {
  it("serves a generated module from collected ids", async () => {
    const componentTestIds = new Map<string, Set<string>>([
      ["Foo", new Set(["foo-root", "foo-button"])],
      ["Bar", new Set(["bar"])],
    ]);

    const plugin = createTestIdsVirtualModulesPlugin(componentTestIds);
    expect(typeof plugin).toBe("object");

    const resolved = await (plugin as any).resolveId?.("virtual:testids");
    const resolvedId = typeof resolved === "string" ? resolved : resolved?.id;

    expect(typeof resolvedId).toBe("string");

    const loaded = await (plugin as any).load?.(resolvedId);

    const code =
      typeof loaded === "string"
        ? loaded
        : (loaded && typeof loaded === "object" && "code" in loaded)
          ? (loaded as { code: string }).code
          : "";

    expect(code).toContain("export const testIdManifest");

    // Proves the content is derived from the Map we passed in.
    expect(code).toContain("\"Bar\"");
    expect(code).toContain("\"bar\"");
    expect(code).toContain("\"Foo\"");
    expect(code).toContain("\"foo-button\"");
    expect(code).toContain("\"foo-root\"");

    // Ensure the module is generated on-demand (not a one-time snapshot).
    componentTestIds.set("Baz", new Set(["baz"]));

    const loaded2 = await (plugin as any).load?.(resolvedId);
    const code2 =
      typeof loaded2 === "string"
        ? loaded2
        : (loaded2 && typeof loaded2 === "object" && "code" in loaded2)
          ? (loaded2 as { code: string }).code
          : "";

    expect(code2).toContain("\"Baz\"");
    expect(code2).toContain("\"baz\"");
  });
});
