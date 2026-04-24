import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginOption } from "vite";

import type { ElementMetadata } from "../metadata-collector";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";
import type { VuePomGeneratorLogger } from "./logger";
import type { ResolvedGenerationSupportOptions } from "./resolved-generation-options";
import { createBuildProcessorPlugin } from "./support/build-plugin";
import { createDevProcessorPlugin } from "./support/dev-plugin";
import { createTestIdsVirtualModulesPlugin } from "./support/virtual-modules";

interface SupportFactoryOptions {
  componentHierarchyMap: Map<string, IComponentDependencies>;
  elementMetadata: Map<string, Map<string, ElementMetadata>>;
  vueFilesPathMap: Map<string, string>;
  nativeWrappers: NativeWrappersMap;
  excludedComponents: string[];
  getPageDirs: () => string[];
  getComponentDirs: () => string[];
  getLayoutDirs: () => string[];
  getViewsDir: () => string;
  getSourceDirs: () => string[];
  getWrapperSearchRoots: () => string[];
  generation: ResolvedGenerationSupportOptions;
  projectRootRef: { current: string };
  basePageClassPath?: string;
  loggerRef: { current: VuePomGeneratorLogger };
}

export function createSupportPlugins(options: SupportFactoryOptions): PluginOption[] {
  const {
    componentHierarchyMap,
    elementMetadata,
    vueFilesPathMap,
    nativeWrappers,
    excludedComponents,
    getPageDirs,
    getComponentDirs,
    getLayoutDirs,
    getViewsDir,
    getSourceDirs,
    getWrapperSearchRoots,
    generation,
    projectRootRef,
    basePageClassPath: basePageClassPathOverride,
    loggerRef,
  } = options;
  const {
    outDir,
    emitLanguages,
    typescriptOutputStructure,
    csharp,
    generateFixtures,
    customPomAttachments,
    customPomDir,
    requireCustomPomDir,
    customPomImportAliases,
    customPomImportNameCollisionBehavior,
    nameCollisionBehavior,
    existingIdBehavior,
    testIdAttribute,
    routerAwarePoms,
    routerEntry,
    routerType,
    routerModuleShims,
  } = generation;

  const resolveRouterEntry = () => {
    if (!routerAwarePoms)
      return undefined;
    if (routerType === "nuxt")
      return undefined; // Nuxt uses directory walking, no router entry file.
    if (!routerEntry)
      throw new Error("[vue-pom-generator] router.entry is required when router introspection is enabled.");
    return path.isAbsolute(routerEntry) ? routerEntry : path.resolve(projectRootRef.current, routerEntry);
  };

  const getDefaultBasePageClassPath = () => {
    // Prefer resolving relative to this package so consumers don't need a repo-specific layout.
    // Works in ESM output.
    try {
      return fileURLToPath(new URL("../class-generation/base-page.ts", import.meta.url));
    }
    catch {
      // Fallback for CJS output.
      return path.resolve(__dirname, "..", "class-generation", "base-page.ts");
    }
  };

  const basePageClassPath = basePageClassPathOverride ?? getDefaultBasePageClassPath();

  // Vite normalizes resolved ids to posix-style paths for plugin hooks.
  const normalizedBasePagePath = path.posix.normalize(basePageClassPath);

  const tsProcessor = createBuildProcessorPlugin({
    componentHierarchyMap,
    vueFilesPathMap,
    getPageDirs,
    getComponentDirs,
    getLayoutDirs,
    getViewsDir,
    getSourceDirs,
    basePageClassPath,
    normalizedBasePagePath,
    generation,
    projectRootRef,
    nativeWrappers,
    excludedComponents,
    getWrapperSearchRoots,
    getResolvedRouterEntry: resolveRouterEntry,
    loggerRef,
  });

  const devProcessor = createDevProcessorPlugin({
    nativeWrappers,
    excludedComponents,
    getPageDirs,
    getComponentDirs,
    getLayoutDirs,
    getViewsDir,
    getSourceDirs,
    getWrapperSearchRoots,
    projectRootRef,
    normalizedBasePagePath,
    basePageClassPath,
    generation,
    getResolvedRouterEntry: resolveRouterEntry,
    loggerRef,
  });

  const virtualModules = createTestIdsVirtualModulesPlugin(componentHierarchyMap, elementMetadata, testIdAttribute);

  return [tsProcessor, devProcessor, virtualModules];
}
