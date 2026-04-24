// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDevProcessorPlugin } from "../plugin/support/dev-plugin";
import { resolveGenerationSupportOptions } from "../plugin/resolved-generation-options";
import { createTestIdsVirtualModulesPlugin } from "../plugin/support/virtual-modules";
import type { ElementMetadata } from "../metadata-collector";
import type { IComponentDependencies } from "../utils";

vi.mock("../class-generation", () => ({
  generateFiles: vi.fn(async () => undefined),
}));

function extractCode(loaded: unknown): string {
  return typeof loaded === "string"
    ? loaded
    : (loaded && typeof loaded === "object" && "code" in loaded)
      ? (loaded as { code: string }).code
      : "";
}

function createDevServerStub() {
  return {
    watcher: {
      add: vi.fn(),
      on: vi.fn(),
    },
    config: {
      logger: {
        error: vi.fn(),
      },
    },
    restart: vi.fn(),
  };
}

describe("dev plugin shared state", () => {
  it("populates virtual WebMCP modules from the full dev snapshot", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-dev-state-"));

    try {
      fs.mkdirSync(path.join(projectRoot, "src", "views"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, "src", "views", "LandingPage.vue"),
        "<template><button>Request Access</button></template>",
        "utf8",
      );

      const componentHierarchyMap = new Map<string, IComponentDependencies>();
      const elementMetadata = new Map<string, Map<string, ElementMetadata>>();
      const semanticNameMap = new Map<string, string>();
      const vueFilesPathMap = new Map<string, string>();

      const plugin = createDevProcessorPlugin({
        elementMetadata,
        semanticNameMap,
        componentHierarchyMap,
        vueFilesPathMap,
        nativeWrappers: {},
        excludedComponents: [],
        getPageDirs: () => ["src/views"],
        getComponentDirs: () => ["src/components"],
        getLayoutDirs: () => ["src/layouts"],
        getViewsDir: () => "src/views",
        getSourceDirs: () => ["src/views", "src/components", "src/layouts"],
        getWrapperSearchRoots: () => [],
        projectRootRef: { current: projectRoot },
        normalizedBasePagePath: path.posix.normalize(path.join(projectRoot, "base-page.ts")),
        basePageClassPath: path.join(projectRoot, "base-page.ts"),
        generation: resolveGenerationSupportOptions({
          customPomAttachments: [],
          nameCollisionBehavior: "error",
          existingIdBehavior: "error",
          testIdAttribute: "data-testid",
          routerAwarePoms: false,
        }),
        getResolvedRouterEntry: () => undefined,
        loggerRef: {
          current: {
            info() {},
            debug() {},
            warn() {},
          },
        },
      });

      const configureServer = (plugin as { configureServer?: (server: ReturnType<typeof createDevServerStub>) => Promise<void> | void }).configureServer;
      if (!configureServer) {
        throw new Error("Expected configureServer to exist");
      }

      await configureServer(createDevServerStub());

      expect(componentHierarchyMap.has("LandingPage")).toBe(true);
      expect(vueFilesPathMap.get("LandingPage")).toBe(path.join(projectRoot, "src", "views", "LandingPage.vue"));

      const virtualModules = createTestIdsVirtualModulesPlugin(componentHierarchyMap, elementMetadata, "data-testid");
      const resolvedBridge = await (virtualModules as { resolveId?: (id: string) => Promise<string | { id: string }> | string | { id: string } }).resolveId?.("virtual:webmcp-bridge");
      const resolvedBridgeId = typeof resolvedBridge === "string" ? resolvedBridge : resolvedBridge?.id;
      const loadedBridge = await (virtualModules as { load?: (id: string | undefined) => Promise<unknown> | unknown }).load?.(resolvedBridgeId);
      const bridgeCode = extractCode(loadedBridge);

      expect(bridgeCode).toContain("\"componentName\": \"LandingPage\"");
      expect(bridgeCode).not.toContain("export const webMcpManifest = {};");
    }
    finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
