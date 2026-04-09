// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createVuePomGeneratorPlugins, defineVuePomGeneratorConfig, vuePomGenerator } from "../index";

describe("createVuePomGeneratorPlugins options", () => {
  interface TestViteLogger {
    info: () => void;
    warn: () => void;
    error: () => void;
  }

  interface ConfigPlugin {
    name?: string;
    configResolved?: (config: { root: string; logger: TestViteLogger; plugins?: Array<{ name?: string; api?: { options?: unknown } }> }) => void;
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

  it("patches the resolved vite:vue plugin when vuePluginOwnership is external", () => {
    const plugins = createVuePomGeneratorPlugins({
      vuePluginOwnership: "external",
      generation: false,
    });

    expect(plugins).toHaveLength(3);

    const names = plugins
      .map(p => (typeof p === "object" && p && "name" in p ? (p as { name?: string }).name : undefined))
      .filter((v): v is string => typeof v === "string");

    expect(names).not.toContain("vite:vue");

    const configPlugin = plugins
      .map((p) => {
        if (typeof p !== "object" || !p || !("name" in p))
          return null;
        return p as ConfigPlugin;
      })
      .find(p => p?.name === "vue-pom-generator-config");

    if (!configPlugin?.configResolved)
      throw new Error("config plugin not found");

    const viteVuePlugin = {
      name: "vite:vue",
      api: {
        options: {
          template: {
            compilerOptions: {
              expressionPlugins: ["typescript"],
            },
          },
        },
      },
    };

    configPlugin.configResolved({
      root: "/project",
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      plugins: [viteVuePlugin],
    });

    const compilerOptions = (viteVuePlugin.api.options as { template?: { compilerOptions?: { nodeTransforms?: unknown[]; expressionPlugins?: string[]; prefixIdentifiers?: boolean } } })
      .template?.compilerOptions;

    expect(compilerOptions?.nodeTransforms?.length).toBeGreaterThan(0);
    expect(compilerOptions?.expressionPlugins).toContain("typescript");
    expect(compilerOptions?.prefixIdentifiers).toBe(true);
  });

  it("fails fast when vuePluginOwnership is external but no resolved vite:vue plugin exists", () => {
    const plugins = createVuePomGeneratorPlugins({
      vuePluginOwnership: "external",
      generation: false,
    });

    expect(() => runConfigResolved(plugins)).toThrow("vuePluginOwnership=\"external\"");
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

  it("accepts root-level errorBehavior as a string", () => {
    const plugins = createVuePomGeneratorPlugins({
      errorBehavior: "error",
      generation: {
        outDir: "./tests/playwright/generated",
      },
    });

    expect(() => runConfigResolved(plugins)).not.toThrow();
  });

  it("accepts root-level errorBehavior as an object", () => {
    const plugins = createVuePomGeneratorPlugins({
      errorBehavior: {
        missingSemanticNameBehavior: "error",
      },
      generation: {
        outDir: "./tests/playwright/generated",
      },
    });

    expect(() => runConfigResolved(plugins)).not.toThrow();
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

  it("fails fast for invalid root-level errorBehavior string", () => {
    const plugins = createVuePomGeneratorPlugins({
      errorBehavior: "strict" as "ignore",
      generation: {
        outDir: "tests/playwright/generated",
      },
    });

    expect(() => runConfigResolved(plugins)).toThrow("errorBehavior");
  });

  it("fails fast for invalid root-level errorBehavior object", () => {
    const plugins = createVuePomGeneratorPlugins({
      errorBehavior: {
        missingSemanticNameBehavior: "strict" as "ignore",
      },
      generation: {
        outDir: "tests/playwright/generated",
      },
    });

    expect(() => runConfigResolved(plugins)).toThrow("errorBehavior.missingSemanticNameBehavior");
  });

  it("fails fast when generation.router.moduleShims has an empty export list", () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { entry: "src/router.ts", moduleShims: { "@/fake/module": [] } },
      },
    });

    expect(() => runConfigResolved(plugins)).toThrow("generation.router.moduleShims");
  });

  it("fails fast when generation.router.moduleShims uses '*' wildcard export names", () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { entry: "src/router.ts", moduleShims: { "@/fake/module": ["*"] } },
      },
    });

    expect(() => runConfigResolved(plugins)).toThrow("generation.router.moduleShims");
  });

  it("throws a helpful error when plugin-like options are passed", () => {
    const mistakenPluginLikeOptions = {
      name: "vite:vue",
      enforce: "pre",
    } as Parameters<typeof createVuePomGeneratorPlugins>[0];

    expect(() => createVuePomGeneratorPlugins(mistakenPluginLikeOptions)).toThrow("Do not pass vue() into createVuePomGeneratorPlugins(...)");
  });

  it("supports alias and typed config helper exports", () => {
    const config = defineVuePomGeneratorConfig({
      errorBehavior: {
        missingSemanticNameBehavior: "error",
      },
      generation: false,
      vueOptions: {
        script: { defineModel: true },
      },
    });

    const plugins = vuePomGenerator(config);
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThan(0);
    expect(config.errorBehavior).toEqual({
      missingSemanticNameBehavior: "error",
    });
  });

  it("patches the resolved vite:vue plugin for Nuxt projects", () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { type: "nuxt" },
      },
    });

    const configPlugin = plugins
      .map((p) => {
        if (typeof p !== "object" || !p || !("name" in p))
          return null;
        return p as ConfigPlugin;
      })
      .find(p => p?.name === "vue-pom-generator-config");

    if (!configPlugin?.configResolved)
      throw new Error("config plugin not found");

    const viteVuePlugin = {
      name: "vite:vue",
      api: {
        options: {
          template: {
            compilerOptions: {
              expressionPlugins: ["typescript"],
            },
          },
        },
      },
    };

    configPlugin.configResolved({
      root: "/project",
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      plugins: [viteVuePlugin],
    });

    const compilerOptions = (viteVuePlugin.api.options as { template?: { compilerOptions?: { nodeTransforms?: unknown[]; expressionPlugins?: string[]; prefixIdentifiers?: boolean } } })
      .template?.compilerOptions;

    expect(compilerOptions?.nodeTransforms?.length).toBeGreaterThan(0);
    expect(compilerOptions?.expressionPlugins).toContain("typescript");
    expect(compilerOptions?.prefixIdentifiers).toBe(true);
  });
});
