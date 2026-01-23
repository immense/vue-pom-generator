// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createVueTestIdPlugins } from "../index";

describe("createVueTestIdPlugins options", () => {
  it("returns only vue + virtual modules when generation is disabled", () => {
    const plugins = createVueTestIdPlugins({ generation: false });

    // Vue SFC plugin + virtual:testids module.
    expect(plugins.length).toBe(2);

    const names = plugins
      .map(p => (typeof p === "object" && p && "name" in p ? (p as { name?: string }).name : undefined))
      .filter((v): v is string => typeof v === "string");

    expect(names.some(n => n.includes("vue"))).toBe(true);
    expect(names.some(n => n.includes("virtual"))).toBe(true);
  });

  it("includes build/serve support plugins when generation is enabled", () => {
    const plugins = createVueTestIdPlugins({
      generation: {
        // keep generation enabled but avoid any repo-specific requirements
        outDir: "./pom",
      },
    });

    const names = plugins
      .map(p => (typeof p === "object" && p && "name" in p ? (p as { name?: string }).name : undefined))
      .filter((v): v is string => typeof v === "string");

    expect(names).toContain("vue-testid-ts-processor");
    expect(names).toContain("vue-testid-dev-processor");
  });
});
