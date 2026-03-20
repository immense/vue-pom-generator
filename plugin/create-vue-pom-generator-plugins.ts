import path from "node:path";
import process from "node:process";

import type { PluginOption, ResolvedConfig } from "vite";

import type { VuePomGeneratorLogger, VuePomGeneratorVerbosity } from "./logger";
import { createLogger } from "./logger";
import { createSupportPlugins } from "./support-plugins";
import { createTestIdsVirtualModulesPlugin } from "./support/virtual-modules";
import type { ExistingIdBehavior, PomNameCollisionBehavior, RouterModuleShimDefinition, VuePomGeneratorPluginOptions } from "./types";
import { createVuePluginWithTestIds } from "./vue-plugin";

import type { ElementMetadata } from "../metadata-collector";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";

function assertNonEmptyString(value: string | undefined | null, name: string): asserts value is string {
  if (!value || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function assertRouterModuleShims(
  value: Record<string, RouterModuleShimDefinition> | undefined,
  name: string,
): asserts value is Record<string, RouterModuleShimDefinition> {
  if (!value)
    return;

  for (const [moduleSource, shimDefinition] of Object.entries(value)) {
    assertNonEmptyString(moduleSource, `${name} key`);

    if (Array.isArray(shimDefinition)) {
      if (!shimDefinition.length)
        throw new TypeError(`${name}[${JSON.stringify(moduleSource)}] must contain at least one export name.`);
      for (const exportName of shimDefinition) {
        assertNonEmptyString(exportName, `${name}[${JSON.stringify(moduleSource)}] export`);
        if (exportName === "*")
          throw new TypeError(`${name}[${JSON.stringify(moduleSource)}] does not support '*' export wildcard.`);
      }
      continue;
    }

    const entries = Object.entries(shimDefinition);
    if (!entries.length)
      throw new TypeError(`${name}[${JSON.stringify(moduleSource)}] must contain at least one export.`);
    for (const [exportName, shimValue] of entries) {
      assertNonEmptyString(exportName, `${name}[${JSON.stringify(moduleSource)}] export`);
      if (exportName === "*")
        throw new TypeError(`${name}[${JSON.stringify(moduleSource)}] does not support '*' export wildcard.`);
      if (typeof shimValue !== "function") {
        throw new TypeError(`${name}[${JSON.stringify(moduleSource)}][${JSON.stringify(exportName)}] must be a function.`);
      }
    }
  }
}

function resolveFromProjectRoot(projectRoot: string, maybePath: string): string {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(projectRoot, maybePath);
}

interface ViteVueCompilerOptions extends Record<string, unknown> {
  nodeTransforms?: unknown[];
  expressionPlugins?: string[];
}

interface ViteVuePluginApi {
  options?: {
    template?: {
      compilerOptions?: ViteVueCompilerOptions;
    };
  } & Record<string, unknown>;
}

interface ViteVuePluginLike {
  name: string;
  api?: ViteVuePluginApi;
}

interface SharedGeneratorState {
  componentTestIds: Map<string, Set<string>>;
  elementMetadata: Map<string, Map<string, ElementMetadata>>;
  semanticNameMap: Map<string, string>;
  componentHierarchyMap: Map<string, IComponentDependencies>;
  vueFilesPathMap: Map<string, string>;
  buildGenerationMetricsRef: {
    current: {
      entryCount: number;
      interactiveComponentCount: number;
      dataTestIdCount: number;
    };
  };
  devGenerationMetricsRef: {
    current: {
      entryCount: number;
      interactiveComponentCount: number;
      dataTestIdCount: number;
    };
  };
}

const sharedGeneratorStateRegistry = new Map<string, SharedGeneratorState>();

function toArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function getSharedGeneratorState(key: string): SharedGeneratorState {
  let state = sharedGeneratorStateRegistry.get(key);
  if (!state) {
    state = {
      componentTestIds: new Map<string, Set<string>>(),
      elementMetadata: new Map<string, Map<string, ElementMetadata>>(),
      semanticNameMap: new Map<string, string>(),
      componentHierarchyMap: new Map<string, IComponentDependencies>(),
      vueFilesPathMap: new Map<string, string>(),
      buildGenerationMetricsRef: {
        current: {
          entryCount: 0,
          interactiveComponentCount: 0,
          dataTestIdCount: 0,
        },
      },
      devGenerationMetricsRef: {
        current: {
          entryCount: 0,
          interactiveComponentCount: 0,
          dataTestIdCount: 0,
        },
      },
    };
    sharedGeneratorStateRegistry.set(key, state);
  }
  return state;
}

function applyTemplateCompilerOptionsToNuxtVuePlugin(
  config: ResolvedConfig,
  templateCompilerOptions: Record<string, unknown>,
): void {
  const viteVuePlugin = config.plugins.find((plugin): plugin is ViteVuePluginLike => plugin.name === "vite:vue");
  if (!viteVuePlugin?.api) {
    throw new Error("[vue-pom-generator] Nuxt mode requires the resolved Vite Vue plugin, but none was found.");
  }

  const currentOptions = viteVuePlugin.api.options ?? {};
  const currentTemplate = currentOptions.template ?? {};
  const currentCompilerOptions = currentTemplate.compilerOptions ?? {};

  const mergedNodeTransforms = [
    ...toArray(currentCompilerOptions.nodeTransforms),
    ...toArray(templateCompilerOptions.nodeTransforms as unknown[] | undefined),
  ];

  const mergedExpressionPlugins = Array.from(new Set([
    ...toArray(currentCompilerOptions.expressionPlugins),
    ...toArray(templateCompilerOptions.expressionPlugins as string[] | undefined),
  ]));

  viteVuePlugin.api.options = {
    ...currentOptions,
    template: {
      ...currentTemplate,
      compilerOptions: {
        ...currentCompilerOptions,
        ...templateCompilerOptions,
        ...(mergedExpressionPlugins.length > 0 ? { expressionPlugins: mergedExpressionPlugins } : {}),
        nodeTransforms: mergedNodeTransforms,
      },
    },
  };
}

function assertNotVitePluginInstance(options: VuePomGeneratorPluginOptions): void {
  const candidate = options as Record<string, unknown>;
  const pluginLikeKeys = [
    "name",
    "enforce",
    "apply",
    "transform",
    "resolveId",
    "load",
    "config",
    "configResolved",
    "handleHotUpdate",
  ];

  const pluginLikeKey = pluginLikeKeys.find(key => key in candidate);
  if (!pluginLikeKey) {
    return;
  }

  throw new TypeError(
    `[vue-pom-generator] Invalid options: received an object that looks like a Vite plugin (found key: "${pluginLikeKey}"). `
    + `Do not pass vue() into createVuePomGeneratorPlugins(...). `
    + `Pass Vue plugin options via { vueOptions: { ... } } instead.`
  );
}

export function createVuePomGeneratorPlugins(options: VuePomGeneratorPluginOptions = {}): PluginOption[] {
  assertNotVitePluginInstance(options);

  const injection = options.injection ?? {};
  type GenerationConfig = NonNullable<Exclude<VuePomGeneratorPluginOptions["generation"], false>>;

  const generationSetting = options.generation;
  const generationOptions: GenerationConfig | null = generationSetting === false ? null : (generationSetting ?? {});
  const generationEnabled = generationOptions !== null;

  const verbosity: VuePomGeneratorVerbosity = options.logging?.verbosity ?? "warn";

  const vueOptions = options.vueOptions;

  const viewsDir = injection.viewsDir ?? "src/views";
  const scanDirs = injection.scanDirs ?? ["src"];
  const nativeWrappers = (injection.nativeWrappers ?? {}) as NativeWrappersMap;
  const excludedComponents = injection.excludeComponents ?? [];
  const testIdAttribute = (injection.attribute ?? "data-testid").trim() || "data-testid";
  const existingIdBehavior: ExistingIdBehavior = injection.existingIdBehavior ?? "preserve";

  const outDir = (generationOptions?.outDir ?? "tests/playwright/generated").trim();
  const emitLanguages: Array<"ts" | "csharp"> = (generationOptions?.emit && generationOptions.emit.length)
    ? generationOptions.emit
    : ["ts"];
  const nameCollisionBehavior: PomNameCollisionBehavior = generationOptions?.nameCollisionBehavior ?? "suffix";
  const routerEntry = generationOptions?.router?.entry;
  const routerType = generationOptions?.router?.type ?? "vue-router";
  const routerModuleShims = generationOptions?.router?.moduleShims;
  const isNuxt = routerType === "nuxt";
  const csharp = generationOptions?.csharp;
  const generateFixtures = generationOptions?.playwright?.fixtures;
  const customPoms = generationOptions?.playwright?.customPoms;

  const resolvedCustomPomAttachments = customPoms?.attachments ?? [];
  const resolvedCustomPomDir = customPoms?.dir ?? "tests/playwright/pom/custom";
  const resolvedCustomPomImportAliases = customPoms?.importAliases;
  const resolvedCustomPomImportCollisionBehavior = customPoms?.importNameCollisionBehavior ?? "error";

  const basePageClassPathOverride = generationOptions?.basePageClassPath;
  const sharedStateKey = JSON.stringify({
    cwd: process.cwd(),
    viewsDir,
    scanDirs,
    outDir,
    testIdAttribute,
    routerType,
  });
  const sharedState = getSharedGeneratorState(sharedStateKey);

  // Shared state: initialized with process.cwd(), then updated in configResolved.
  const projectRootRef = { current: process.cwd() };
  const loggerRef: { current: VuePomGeneratorLogger } = {
    current: createLogger({ verbosity }),
  };

  const configPlugin: PluginOption = {
    name: "vue-pom-generator-config",
    enforce: "pre",
    configResolved(config: ResolvedConfig) {
      projectRootRef.current = config.root;
      loggerRef.current = createLogger({ verbosity, viteLogger: config.logger });

      // Fail-fast validation.
      assertNonEmptyString(testIdAttribute, "[vue-pom-generator] injection.attribute");
      assertNonEmptyString(viewsDir, "[vue-pom-generator] injection.viewsDir");

      if (generationEnabled) {
        assertNonEmptyString(outDir, "[vue-pom-generator] generation.outDir");
        assertRouterModuleShims(routerModuleShims, "[vue-pom-generator] generation.router.moduleShims");

        if (generationOptions?.router && routerType === "vue-router") {
          assertNonEmptyString(routerEntry, "[vue-pom-generator] generation.router.entry");
        }
      }

      if (isNuxt) {
        applyTemplateCompilerOptionsToNuxtVuePlugin(config, templateCompilerOptions);
      }

      // Small but helpful diagnostics.
      loggerRef.current.info(`projectRoot=${projectRootRef.current}`);
      loggerRef.current.info(`Active plugins: ${config.plugins.map(p => p.name).filter(n => n.includes('vue-pom')).join(', ')}`);
    }
  };

  const getViewsDirAbs = () => resolveFromProjectRoot(projectRootRef.current, viewsDir);

  const {
    componentTestIds,
    elementMetadata,
    semanticNameMap,
    componentHierarchyMap,
    vueFilesPathMap,
    buildGenerationMetricsRef,
    devGenerationMetricsRef,
  } = sharedState;

  const { metadataCollectorPlugin, internalVuePlugin, templateCompilerOptions } = createVuePluginWithTestIds({
    vueOptions,
    existingIdBehavior,
    nameCollisionBehavior,
    nativeWrappers,
    elementMetadata,
    semanticNameMap,
    componentHierarchyMap,
    vueFilesPathMap,
    excludedComponents,
    getViewsDirAbs,
    testIdAttribute,
    loggerRef,
    scanDirs,
    getProjectRoot: () => projectRootRef.current,
  });

  const routerAwarePoms = (typeof routerEntry === "string" && routerEntry.trim().length > 0) || routerType === "nuxt";

  const supportPlugins = createSupportPlugins({
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
    generateFixtures,
    projectRootRef,
    basePageClassPath: basePageClassPathOverride,
    customPomAttachments: resolvedCustomPomAttachments,
    customPomDir: resolvedCustomPomDir,
    customPomImportAliases: resolvedCustomPomImportAliases,
    customPomImportNameCollisionBehavior: resolvedCustomPomImportCollisionBehavior,
    testIdAttribute,
    buildGenerationMetricsRef,
    devGenerationMetricsRef,
    loggerRef,
    routerType,
    routerModuleShims,
  });

  if (isNuxt) {
    loggerRef.current.info("Nuxt environment detected. Skipping internal @vitejs/plugin-vue to avoid conflicts.");
  }

  const resultPlugins = [
    configPlugin,
    metadataCollectorPlugin,
    ...(isNuxt ? [] : [internalVuePlugin]),
    ...supportPlugins,
  ];

  if (!generationEnabled) {
    const virtualModules = createTestIdsVirtualModulesPlugin(componentTestIds);
    return [
      configPlugin,
      metadataCollectorPlugin,
      ...(isNuxt ? [] : [internalVuePlugin]),
      virtualModules,
    ];
  }

  return resultPlugins;
}

export default createVuePomGeneratorPlugins;
