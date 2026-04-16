// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createVuePomGeneratorPlugins, defineNuxtPomGeneratorConfig, defineVuePomGeneratorConfig, vuePomGenerator } from "../index";

vi.mock("../plugin/nuxt-discovery", () => ({
  loadNuxtProjectDiscovery: vi.fn(async () => ({
    rootDir: "/project",
    srcDir: "/project/app",
    pageDirs: ["/project/app/views"],
    layoutDirs: ["/project/app/layouts"],
    componentDirs: ["/project/app/components"],
    wrapperSearchRoots: [],
  })),
}));

describe("createVuePomGeneratorPlugins options", () => {
  interface TestViteLogger {
    info: () => void;
    warn: () => void;
    error: () => void;
  }

  interface ConfigPlugin {
    name?: string;
    configResolved?: (config: {
      root: string;
      logger: TestViteLogger;
      plugins?: Array<{
        name?: string;
        api?: {
          options?: {
            template?: {
              compilerOptions?: {
                nodeTransforms?: object[];
                expressionPlugins?: string[];
                prefixIdentifiers?: boolean;
              };
            };
          };
        };
      }>;
    }) => void | Promise<void>;
  }

  const runConfigResolved = async (plugins: Array<object | null | undefined | false>, root: string = "/project") => {
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

    await configPlugin.configResolved({
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

  it("patches the resolved vite:vue plugin when vuePluginOwnership is external", async () => {
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

    await configPlugin.configResolved({
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

  it("fails fast when vuePluginOwnership is external but no resolved vite:vue plugin exists", async () => {
    const plugins = createVuePomGeneratorPlugins({
      vuePluginOwnership: "external",
      generation: false,
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("vuePluginOwnership=\"external\"");
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

  it("accepts root-level errorBehavior as a string", async () => {
    const plugins = createVuePomGeneratorPlugins({
      errorBehavior: "error",
      generation: {
        outDir: "./tests/playwright/generated",
      },
    });

    await expect(runConfigResolved(plugins)).resolves.toBeUndefined();
  });

  it("accepts root-level errorBehavior as an object", async () => {
    const plugins = createVuePomGeneratorPlugins({
      errorBehavior: {
        missingSemanticNameBehavior: "error",
      },
      generation: {
        outDir: "./tests/playwright/generated",
      },
    });

    await expect(runConfigResolved(plugins)).resolves.toBeUndefined();
  });

  it("accepts split Playwright output structure", async () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "./tests/playwright/generated",
        playwright: {
          outputStructure: "split",
        },
      },
    });

    await expect(runConfigResolved(plugins)).resolves.toBeUndefined();
  });
  it("fails fast for invalid injection.viewsDir", async () => {
    const plugins = createVuePomGeneratorPlugins({
      injection: { viewsDir: "   " },
      generation: false,
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("injection.viewsDir");
  });

  it("fails fast for invalid injection.componentDirs entries", async () => {
    const plugins = createVuePomGeneratorPlugins({
      injection: { componentDirs: ["src/components", "   "] },
      generation: false,
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("injection.componentDirs");
  });

  it("fails fast for invalid generation.outDir", async () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: { outDir: "   " },
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("generation.outDir");
  });

  it("fails fast when generation.router is present but router.entry is empty", async () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { entry: "   " },
      },
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("generation.router.entry");
  });

  it("fails fast for invalid root-level errorBehavior string", async () => {
    const plugins = createVuePomGeneratorPlugins({
      errorBehavior: "strict" as "ignore",
      generation: {
        outDir: "tests/playwright/generated",
      },
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("errorBehavior");
  });

  it("fails fast for invalid root-level errorBehavior object", async () => {
    const plugins = createVuePomGeneratorPlugins({
      errorBehavior: {
        missingSemanticNameBehavior: "strict" as "ignore",
      },
      generation: {
        outDir: "tests/playwright/generated",
      },
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("errorBehavior.missingSemanticNameBehavior");
  });

  it("fails fast for invalid generation.playwright.outputStructure", async () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        playwright: {
          outputStructure: "directory" as "aggregated",
        },
      },
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("generation.playwright.outputStructure");
  });
  it("fails fast when generation.router.moduleShims has an empty export list", async () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { entry: "src/router.ts", moduleShims: { "@/fake/module": [] } },
      },
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("generation.router.moduleShims");
  });

  it("fails fast when generation.router.moduleShims uses '*' wildcard export names", async () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { entry: "src/router.ts", moduleShims: { "@/fake/module": ["*"] } },
      },
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("generation.router.moduleShims");
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

    const nuxtConfig = defineNuxtPomGeneratorConfig({
      generation: false,
    });
    expect(nuxtConfig.framework).toBe("nuxt");
  });

  it("fails fast when legacy generation.router.type=\"nuxt\" is used without framework: \"nuxt\"", async () => {
    const plugins = createVuePomGeneratorPlugins({
      generation: {
        outDir: "tests/playwright/generated",
        router: { type: "nuxt" },
      },
    });

    await expect(runConfigResolved(plugins)).rejects.toThrow("defineNuxtPomGeneratorConfig");
  });

  it("patches the resolved vite:vue plugin for Nuxt projects", async () => {
    const plugins = createVuePomGeneratorPlugins({
      framework: "nuxt",
      generation: {
        outDir: "tests/playwright/generated",
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

    await configPlugin.configResolved({
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
