import process from "node:process";

import type { PluginOption } from "vite";

import { createSupportPlugins } from "./support-plugins";
import { createTestIdsVirtualModulesPlugin } from "./support/virtual-modules";
import type { ExistingIdBehavior, VuePomGeneratorPluginOptions } from "./types";
import { createVuePluginWithTestIds } from "./vue-plugin";
import type { ElementMetadata } from "../metadata-collector";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";

export function createVueTestIdPlugins(options: VuePomGeneratorPluginOptions = {}): PluginOption[] {
  const injection = options.injection ?? {};
  const generation = options.generation === false ? null : (options.generation ?? {});

  const vueOptions = options.vueOptions;

  const injectTestIds = injection.enabled !== false;
  const viewsDir = injection.viewsDir ?? "src/views";
  const nativeWrappers = (injection.nativeWrappers ?? {}) as NativeWrappersMap;
  const excludedComponents = injection.excludeComponents ?? [];
  const testIdAttribute = (injection.attribute ?? "data-testid").trim() || "data-testid";
  const existingIdBehavior: ExistingIdBehavior = injection.existingIdBehavior ?? "preserve";

  const outDir = generation?.outDir ?? "./pom";
  const routerEntry = generation?.router?.entry;
  const generateFixtures = generation?.playwright?.fixtures;
  const customPoms = generation?.playwright?.customPoms;

  const resolvedCustomPomAttachments = customPoms?.attachments ?? [];
  const resolvedCustomPomDir = customPoms?.dir;
  const resolvedCustomPomImportAliases = customPoms?.importAliases;

  const projectRoot = process.cwd();
  const basePageClassPathOverride = generation?.basePageClassPath;

  const componentTestIds = new Map<string, Set<string>>();
  const elementMetadata = new Map<string, Map<string, ElementMetadata>>();
  const semanticNameMap = new Map<string, string>();
  const componentHierarchyMap = new Map<string, IComponentDependencies>();
  const vueFilesPathMap = new Map<string, string>();

  const vuePlugin = createVuePluginWithTestIds({
    vueOptions,
    enableTestIds: true,
    debugTestIds: false,
    injectTestIds,
    existingIdBehavior,
    nativeWrappers,
    elementMetadata,
    semanticNameMap,
    componentHierarchyMap,
    vueFilesPathMap,
    excludedComponents,
    viewsDir,
    testIdAttribute,
  });

  if (generation === null) {
    const virtualModules = createTestIdsVirtualModulesPlugin(componentTestIds);
    return [vuePlugin, virtualModules];
  }

  const vueRouterFluentChaining = typeof routerEntry === "string" && routerEntry.length > 0;

  const supportPlugins = createSupportPlugins({
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
    projectRoot,
    basePageClassPath: basePageClassPathOverride,
    customPomAttachments: resolvedCustomPomAttachments,
    customPomDir: resolvedCustomPomDir,
    customPomImportAliases: resolvedCustomPomImportAliases,
    testIdAttribute,
  });

  return [vuePlugin, ...supportPlugins];
}

export default createVueTestIdPlugins;
