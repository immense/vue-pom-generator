import path from "node:path";
import process from "node:process";

import type { PluginOption, ResolvedConfig } from "vite";

import type { VuePomGeneratorLogger, VuePomGeneratorVerbosity } from "./logger";
import { createLogger } from "./logger";
import { createSupportPlugins } from "./support-plugins";
import { createTestIdsVirtualModulesPlugin } from "./support/virtual-modules";
import type { ExistingIdBehavior, PomNameCollisionBehavior, VuePomGeneratorPluginOptions } from "./types";
import { createVuePluginWithTestIds } from "./vue-plugin";

import type { ElementMetadata } from "../metadata-collector";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";

function assertNonEmptyString(value: string | undefined | null, name: string): asserts value is string {
  if (!value || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function resolveFromProjectRoot(projectRoot: string, maybePath: string): string {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(projectRoot, maybePath);
}

export function createVuePomGeneratorPlugins(options: VuePomGeneratorPluginOptions = {}): PluginOption[] {
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
  const csharp = generationOptions?.csharp;
  const generateFixtures = generationOptions?.playwright?.fixtures;
  const customPoms = generationOptions?.playwright?.customPoms;

  const resolvedCustomPomAttachments = customPoms?.attachments ?? [];
  const resolvedCustomPomDir = customPoms?.dir ?? "tests/playwright/pom/custom";
  const resolvedCustomPomImportAliases = customPoms?.importAliases;

  const basePageClassPathOverride = generationOptions?.basePageClassPath;

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

        if (generationOptions?.router && routerType === "vue-router") {
          assertNonEmptyString(routerEntry, "[vue-pom-generator] generation.router.entry");
        }
      }

      // Small but helpful diagnostics.
      loggerRef.current.info(`projectRoot=${projectRootRef.current}`);
      loggerRef.current.info(`Active plugins: ${config.plugins.map(p => p.name).filter(n => n.includes('vue-pom')).join(', ')}`);
    }
  };

  const getViewsDirAbs = () => resolveFromProjectRoot(projectRootRef.current, viewsDir);

  const componentTestIds = new Map<string, Set<string>>();
  const elementMetadata = new Map<string, Map<string, ElementMetadata>>();
  const semanticNameMap = new Map<string, string>();
  const componentHierarchyMap = new Map<string, IComponentDependencies>();
  const vueFilesPathMap = new Map<string, string>();

  const { metadataCollectorPlugin, internalVuePlugin } = createVuePluginWithTestIds({
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
    testIdAttribute,
    loggerRef,
    routerType,
  });

  const isNuxt = routerType === "nuxt";

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
