import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginOption } from "vite";

import { createBuildProcessorPlugin } from "./support/build-plugin";
import { createDevProcessorPlugin } from "./support/dev-plugin";
import { createTestIdsVirtualModulesPlugin } from "./support/virtual-modules";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";

interface SupportFactoryOptions {
  componentTestIds: Map<string, Set<string>>;
  componentHierarchyMap: Map<string, IComponentDependencies>;
  vueFilesPathMap: Map<string, string>;
  nativeWrappers: NativeWrappersMap;
  excludedComponents: string[];
  viewsDir: string;

  /** Output directory for generated files (POMs + optional fixtures). */
  outDir?: string;
  vueRouterFluentChaining: boolean;
  routerEntry?: string;

  /** Generate Playwright fixtures alongside generated POMs. */
  generateFixtures?: boolean | string | { outDir?: string };
  customPomAttachments?: Array<{ className: string; propertyName: string; attachWhenUsesComponents: string[]; attachTo?: "views" | "components" | "both" }>;
  projectRoot: string;
  basePageClassPath?: string;
  customPomDir?: string;
  customPomImportAliases?: Record<string, string>;
  testIdAttribute: string;
}

export function createSupportPlugins(options: SupportFactoryOptions): PluginOption[] {
  const {
    componentTestIds,
    componentHierarchyMap,
    vueFilesPathMap,
    nativeWrappers,
    excludedComponents,
    viewsDir,
    outDir,
    vueRouterFluentChaining,
    routerEntry,
    generateFixtures,
    customPomAttachments,
    projectRoot,
    basePageClassPath: basePageClassPathOverride,
    customPomDir,
    customPomImportAliases,
    testIdAttribute,
  } = options;

  const resolveRouterEntry = () => {
    if (!vueRouterFluentChaining)
      return undefined;
    if (!routerEntry)
      throw new Error("[vue-pom-generator] router.entry is required when router introspection is enabled.");
    return path.isAbsolute(routerEntry) ? routerEntry : path.resolve(projectRoot, routerEntry);
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
    generateFixtures,
    customPomAttachments,
    projectRoot,
    customPomDir,
    customPomImportAliases,
    testIdAttribute,
    vueRouterFluentChaining,
    resolvedRouterEntry,
  });

  const devProcessor = createDevProcessorPlugin({
    nativeWrappers,
    excludedComponents,
    viewsDir,
    projectRoot,
    normalizedBasePagePath,
    basePageClassPath,
    outDir,
    generateFixtures,
    customPomAttachments,
    customPomDir,
    customPomImportAliases,
    testIdAttribute,
    vueRouterFluentChaining,
    resolvedRouterEntry,
  });

  const virtualModules = createTestIdsVirtualModulesPlugin(componentTestIds);

  return [tsProcessor, devProcessor, virtualModules];
}
