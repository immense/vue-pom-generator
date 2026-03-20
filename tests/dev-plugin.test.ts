// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as classGeneration from "../class-generation";
import { createDevProcessorPlugin } from "../plugin/support/dev-plugin";

interface DevPluginLike {
  configureServer?: (server: unknown) => void;
}

function createFakeWatcher() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  return {
    add: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return undefined;
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
  };
}

async function waitUntil(assertion: () => void, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    }
    catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  throw lastError ?? new Error("Timed out waiting for assertion.");
}

function writeVueFile(tempRoot: string, relativePath: string, content: string) {
  const filePath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("createDevProcessorPlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips selector-less startup scans instead of overwriting generated output", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-dev-empty-"));
    const outDir = path.join(tempRoot, "generated", "pom");
    const existingGeneratedFile = path.join(outDir, "page-object-models.g.cs");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(existingGeneratedFile, "// existing rich output");

    writeVueFile(
      tempRoot,
      path.join("app", "pages", "home", "index.vue"),
      `<template><div>Static home</div></template>`,
    );

    try {
      const generateFilesSpy = vi.spyOn(classGeneration, "generateFiles").mockResolvedValue();
      const watcher = createFakeWatcher();
      const loggerRef = {
        current: {
          info: vi.fn(),
          debug: vi.fn(),
          warn: vi.fn(),
        },
      };

      const plugin = createDevProcessorPlugin({
        nativeWrappers: {},
        excludedComponents: [],
        viewsDir: "app/pages",
        scanDirs: ["app"],
        projectRootRef: { current: tempRoot },
        normalizedBasePagePath: "/tmp/BasePage.ts",
        basePageClassPath: "/tmp/BasePage.ts",
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
        testIdAttribute: "data-testid",
        routerAwarePoms: false,
        loggerRef,
      }) as DevPluginLike;

      if (typeof plugin.configureServer !== "function") {
        throw new Error("Expected a dev plugin with a configureServer hook.");
      }

      plugin.configureServer({
        watcher,
        restart: vi.fn(),
      } as never);

      await new Promise(resolve => setTimeout(resolve, 150));

      expect(generateFilesSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(existingGeneratedFile, "utf8")).toBe("// existing rich output");
      expect(loggerRef.current.info).toHaveBeenCalledWith(expect.stringContaining("skipped: no selectors collected"));
    }
    finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("generates startup output when the scan finds interactive selectors", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-dev-rich-"));
    const outDir = path.join(tempRoot, "generated", "pom");

    writeVueFile(
      tempRoot,
      path.join("app", "pages", "home", "index.vue"),
      `<template><button @click="openCreateNewMatter">New Matter</button></template>`,
    );

    try {
      const generateFilesSpy = vi.spyOn(classGeneration, "generateFiles").mockResolvedValue();
      const watcher = createFakeWatcher();
      const loggerRef = {
        current: {
          info: vi.fn(),
          debug: vi.fn(),
          warn: vi.fn(),
        },
      };

      const plugin = createDevProcessorPlugin({
        nativeWrappers: {},
        excludedComponents: [],
        viewsDir: "app/pages",
        scanDirs: ["app"],
        projectRootRef: { current: tempRoot },
        normalizedBasePagePath: "/tmp/BasePage.ts",
        basePageClassPath: "/tmp/BasePage.ts",
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
        testIdAttribute: "data-testid",
        routerAwarePoms: false,
        loggerRef,
      }) as DevPluginLike;

      if (typeof plugin.configureServer !== "function") {
        throw new Error("Expected a dev plugin with a configureServer hook.");
      }

      plugin.configureServer({
        watcher,
        restart: vi.fn(),
      } as never);

      await waitUntil(() => {
        expect(generateFilesSpy).toHaveBeenCalledTimes(1);
      });

      const hierarchyMap = generateFilesSpy.mock.calls[0]?.[0] as Map<string, { dataTestIdSet?: Set<unknown> }> | undefined;
      const home = hierarchyMap?.get("HomeIndex");

      expect(home).toBeDefined();
      expect(home?.dataTestIdSet?.size ?? 0).toBeGreaterThan(0);
    }
    finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not let a later smaller dev startup clobber a richer earlier startup", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-dev-richness-"));
    const outDir = path.join(tempRoot, "generated", "pom");
    const homeFile = path.join(tempRoot, "app", "pages", "home", "index.vue");
    const sharedMetricsRef = {
      current: {
        entryCount: 0,
        interactiveComponentCount: 0,
        dataTestIdCount: 0,
      },
    };

    writeVueFile(
      tempRoot,
      path.join("app", "pages", "home", "index.vue"),
      `<template>
  <div>
    <button @click="openCreateNewMatter">New Matter</button>
    <input v-model="state.clientName" type="text" />
  </div>
</template>`,
    );

    try {
      const generateFilesSpy = vi.spyOn(classGeneration, "generateFiles").mockResolvedValue();
      const firstWatcher = createFakeWatcher();
      const secondWatcher = createFakeWatcher();
      const loggerRef = {
        current: {
          info: vi.fn(),
          debug: vi.fn(),
          warn: vi.fn(),
        },
      };

      const firstPlugin = createDevProcessorPlugin({
        nativeWrappers: {},
        excludedComponents: [],
        viewsDir: "app/pages",
        scanDirs: ["app"],
        projectRootRef: { current: tempRoot },
        normalizedBasePagePath: "/tmp/BasePage.ts",
        basePageClassPath: "/tmp/BasePage.ts",
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
        testIdAttribute: "data-testid",
        devGenerationMetricsRef: sharedMetricsRef,
        routerAwarePoms: false,
        loggerRef,
      }) as DevPluginLike;

      const secondPlugin = createDevProcessorPlugin({
        nativeWrappers: {},
        excludedComponents: [],
        viewsDir: "app/pages",
        scanDirs: ["app"],
        projectRootRef: { current: tempRoot },
        normalizedBasePagePath: "/tmp/BasePage.ts",
        basePageClassPath: "/tmp/BasePage.ts",
        outDir,
        emitLanguages: ["csharp"],
        csharp: { namespace: "Test.Generated" },
        testIdAttribute: "data-testid",
        devGenerationMetricsRef: sharedMetricsRef,
        routerAwarePoms: false,
        loggerRef,
      }) as DevPluginLike;

      if (typeof firstPlugin.configureServer !== "function" || typeof secondPlugin.configureServer !== "function") {
        throw new Error("Expected dev plugins with configureServer hooks.");
      }

      firstPlugin.configureServer({
        watcher: firstWatcher,
        restart: vi.fn(),
      } as never);

      await waitUntil(() => {
        expect(generateFilesSpy).toHaveBeenCalledTimes(1);
      });

      writeVueFile(
        tempRoot,
        path.join("app", "pages", "home", "index.vue"),
        `<template><button @click="openCreateNewMatter">New Matter</button></template>`,
      );

      secondPlugin.configureServer({
        watcher: secondWatcher,
        restart: vi.fn(),
      } as never);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(generateFilesSpy).toHaveBeenCalledTimes(1);
    }
    finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
