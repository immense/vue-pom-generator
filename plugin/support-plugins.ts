import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginOption } from "vite";

import type { IComponentDependencies, NativeWrappersMap } from "../utils";
import type { VuePomGeneratorLogger } from "./logger";
import type { RouterModuleShimDefinition } from "./types";
import { createBuildProcessorPlugin } from "./support/build-plugin";
import { createDevProcessorPlugin } from "./support/dev-plugin";
import { createTestIdsVirtualModulesPlugin } from "./support/virtual-modules";

interface SupportFactoryOptions {
  componentTestIds: Map<string, Set<string>>;
  componentHierarchyMap: Map<string, IComponentDependencies>;
  vueFilesPathMap: Map<string, string>;
  nativeWrappers: NativeWrappersMap;
  excludedComponents: string[];
  viewsDir: string;
  scanDirs: string[];

  /** Output directory for generated files (POMs + optional fixtures). */
  outDir?: string;

  /** Languages to emit POMs for. */
  emitLanguages?: Array<"ts" | "csharp">;

  csharp?: {
    namespace?: string;
  };

  routerAwarePoms: boolean;
  routerEntry?: string;
  routerType?: "vue-router" | "nuxt";
  routerModuleShims?: Record<string, RouterModuleShimDefinition>;

  /** Generate Playwright fixtures alongside generated POMs. */
  generateFixtures?: boolean | string | { outDir?: string };
  customPomAttachments?: Array<{ className: string; propertyName: string; attachWhenUsesComponents: string[]; attachTo?: "views" | "components" | "both" }>;
  projectRootRef: { current: string };
  basePageClassPath?: string;
  customPomDir?: string;
  customPomImportAliases?: Record<string, string>;
  customPomImportNameCollisionBehavior?: "error" | "alias";
  testIdAttribute: string;
  buildGenerationMetricsRef?: {
    current: {
      entryCount: number;
      interactiveComponentCount: number;
      dataTestIdCount: number;
    };
  };
  devGenerationMetricsRef?: {
    current: {
      entryCount: number;
      interactiveComponentCount: number;
      dataTestIdCount: number;
    };
  };

  loggerRef: { current: VuePomGeneratorLogger };
}

export function createSupportPlugins(options: SupportFactoryOptions): PluginOption[] {
  const {
    componentTestIds,
    componentHierarchyMap,
    vueFilesPathMap,
    nativeWrappers,
    excludedComponents,
    viewsDir,
    scanDirs,
    outDir,
    emitLanguages,
    csharp,
    routerAwarePoms,
    routerEntry,
    routerType,
    routerModuleShims,
    generateFixtures,
    customPomAttachments,
    projectRootRef,
    basePageClassPath: basePageClassPathOverride,
    customPomDir,
    customPomImportAliases,
    customPomImportNameCollisionBehavior,
    testIdAttribute,
    buildGenerationMetricsRef,
    devGenerationMetricsRef,
    loggerRef,
  } = options;

  const resolveRouterEntry = () => {
    if (!routerAwarePoms)
      return undefined;
    if (routerType === "nuxt")
      return undefined; // Nuxt uses directory walking, no router entry file.
    if (!routerEntry)
      throw new Error("[vue-pom-generator] router.entry is required when router introspection is enabled.");
    return path.isAbsolute(routerEntry) ? routerEntry : path.resolve(projectRootRef.current, routerEntry);
  };

  const resolvedRouterEntry = resolveRouterEntry();

  const getDefaultBasePageClassPath = () => {
    // Prefer resolving relative to this package so consumers don't need a repo-specific layout.
    // Works in ESM output.
    try {
      return fileURLToPath(new URL("../class-generation/BasePage.ts", import.meta.url));
    }
    catch {
      // Fallback for CJS output.
      return path.resolve(__dirname, "..", "class-generation", "BasePage.ts");
    }
  };

  const basePageClassPath = basePageClassPathOverride ?? getDefaultBasePageClassPath();

  // Vite normalizes resolved ids to posix-style paths for plugin hooks.
  const normalizedBasePagePath = path.posix.normalize(basePageClassPath);

  const tsProcessor = createBuildProcessorPlugin({
    componentHierarchyMap,
    vueFilesPathMap,
    basePageClassPath,
    normalizedBasePagePath,
    outDir,
    emitLanguages,
    csharp,
    generateFixtures,
    customPomAttachments,
    projectRootRef,
    customPomDir,
    customPomImportAliases,
    customPomImportNameCollisionBehavior,
    testIdAttribute,
    buildGenerationMetricsRef,
    routerAwarePoms,
    routerType,
    resolvedRouterEntry,
    routerModuleShims,
    loggerRef,
  });

  const devProcessor = createDevProcessorPlugin({
    nativeWrappers,
    excludedComponents,
    viewsDir,
    scanDirs,
    projectRootRef,
    normalizedBasePagePath,
    basePageClassPath,
    outDir,
    emitLanguages,
    csharp,
    generateFixtures,
    customPomAttachments,
    customPomDir,
    customPomImportAliases,
    customPomImportNameCollisionBehavior,
    testIdAttribute,
    devGenerationMetricsRef,
    routerAwarePoms,
    routerType,
    resolvedRouterEntry,
    routerModuleShims,
    loggerRef,
  });

  const virtualModules = createTestIdsVirtualModulesPlugin(componentTestIds);

  return [tsProcessor, devProcessor, virtualModules];
}
