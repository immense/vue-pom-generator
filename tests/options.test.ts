// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createVuePomGeneratorPlugins } from "../index";

describe("createVuePomGeneratorPlugins options", () => {
  interface TestViteLogger {
    info: () => void;
    warn: () => void;
    error: () => void;
  }

  interface ConfigPlugin {
    name?: string;
    configResolved?: (config: { root: string; logger: TestViteLogger }) => void;
  }

  const runConfigResolved = (plugins: unknown[], root: string = "/project") => {
    const configPlugin = plugins
      .map((p) => {
        if (typeof p !== "object" || !p || !("name" in p))
          return null;
        return p as ConfigPlugin;
      })
      .find(p => p?.name === "vue-pom-generator-config");

    if (!configPlugin?.configResolved)
      throw new Error("config plugin not found");

    const logger: TestViteLogger = {
      info() {},
      warn() {},
      error() {},
    };

    configPlugin.configResolved({
      root,
      logger,
    });
  };

  it("returns only vue + virtual modules when generation is disabled", () => {
    const plugins = createVuePomGeneratorPlugins({ generation: false });

    // Config plugin + Metadata collector + Vue SFC plugin + virtual:testids module.
    expect(plugins.length).toBe(4);

    const names = plugins
      .map(p => (typeof p === "object" && p && "name" in p ? (p as { name?: string }).name : undefined))
      .filter((v): v is string => typeof v === "string");

    expect(names.some(n => n.includes("vue"))).toBe(true);
    expect(names.some(n => n.includes("virtual"))).toBe(true);
    expect(names).toContain("vue-pom-generator-config");
  });

  it("includes build/serve support plugins when generation is enabled", () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        // keep generation enabled but avoid any repo-specific requirements
        outDir: "./tests/playwright/generated",
      },
    });

    const names = plugins
      .map(p => (typeof p === "object" && p && "name" in p ? (p as { name?: string }).name : undefined))
      .filter((v): v is string => typeof v === "string");

    expect(names).toContain("vue-pom-generator-build");
    expect(names).toContain("vue-pom-generator-dev");
  });

  it("fails fast for invalid injection.viewsDir", () => {
    const plugins = createVuePomGeneratorPlugins({
      injection: { viewsDir: "   " },
      generation: false,
    });

    expect(() => runConfigResolved(plugins)).toThrow("injection.viewsDir");
  });

  it("fails fast for invalid generation.outDir", () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: { outDir: "   " },
    });

    expect(() => runConfigResolved(plugins)).toThrow("generation.outDir");
  });

  it("fails fast when generation.router is present but router.entry is empty", () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { entry: "   " },
      },
    });

    expect(() => runConfigResolved(plugins)).toThrow("generation.router.entry");
  });

  it("fails fast when generation.router.moduleShims has an empty value", () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { entry: "src/router.ts", moduleShims: { "@/fake/module": "   " } },
      },
    });

    expect(() => runConfigResolved(plugins)).toThrow("generation.router.moduleShims");
  });
});
