import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { PluginOption, ResolvedConfig } from "vite";

import type { VuePomGeneratorLogger, VuePomGeneratorVerbosity } from "./logger";
import { createLogger } from "./logger";
import { loadNuxtProjectDiscovery } from "./nuxt-discovery";
import { createSupportPlugins } from "./support-plugins";
import { createTestIdsVirtualModulesPlugin } from "./support/virtual-modules";
import type { ErrorBehavior, ErrorBehaviorOptions, ExistingIdBehavior, MissingSemanticNameBehavior, PlaywrightOutputStructure, PomGeneratorPluginOptions, PomNameCollisionBehavior, RouterModuleShimDefinition, VuePluginOwnership, VuePomGeneratorPluginOptions } from "./types";
import { createVuePluginWithTestIds } from "./vue-plugin";

import type { ElementMetadata } from "../metadata-collector";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";

const nuxtConfigMarker = Symbol.for("@immense/vue-pom-generator.nuxt");
const nuxtConfigFileNames = [
  "nuxt.config.ts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.cjs",
  "nuxt.config.mts",
  "nuxt.config.cts",
  ".nuxtrc",
] as const;
const nuxtSourceMarkers = [
  "app.vue",
  "app",
  "pages",
  "layouts",
  "components",
  "layers",
  ".nuxt",
] as const;

interface NuxtMarkedOptions {
  [nuxtConfigMarker]?: true;
}

function assertNonEmptyString(value: string | undefined | null, name: string): asserts value is string {
  if (!value || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function assertNonEmptyStringArray(value: string[] | undefined, name: string): asserts value is string[] {
  if (!value)
    return;

  for (const [index, entry] of value.entries()) {
    assertNonEmptyString(entry, `${name}[${index}]`);
  }
}

function assertOneOf<T extends string>(value: T | undefined, allowed: readonly T[], name: string): asserts value is T {
  if (!value)
    return;
  if (allowed.includes(value)) {
    return;
  }
  throw new TypeError(`${name} must be one of: ${allowed.join(", ")}.`);
}

function assertErrorBehavior(
  value: ErrorBehavior | undefined,
  name: string,
): asserts value is ErrorBehavior {
  if (!value) {
    return;
  }

  if (value === "ignore" || value === "error") {
    return;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be "ignore", "error", or an object.`);
  }

  const supportedKeys = new Set<keyof ErrorBehaviorOptions>(["missingSemanticNameBehavior"]);
  for (const key of Object.keys(value)) {
    if (!supportedKeys.has(key as keyof ErrorBehaviorOptions)) {
      throw new TypeError(`${name} contains unsupported key "${key}".`);
    }
  }

  assertOneOf(value.missingSemanticNameBehavior, ["ignore", "error"], `${name}.missingSemanticNameBehavior`);
}

function resolveMissingSemanticNameBehavior(
  value: ErrorBehavior | undefined,
): MissingSemanticNameBehavior {
  if (!value) {
    return "error";
  }

  if (value === "ignore" || value === "error") {
    return value;
  }

  return value.missingSemanticNameBehavior ?? "error";
}

function readPackageJson(projectRoot: string): Record<string, unknown> | null {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  }
  catch {
    return null;
  }
}

function recordHasOwnStringKey(value: object | null | undefined, key: string): boolean {
  return value !== null
    && value !== undefined
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key)
    && typeof (value as Record<string, string | undefined>)[key] === "string";
}

function projectPackageLooksNuxt(projectRoot: string): boolean {
  const packageJson = readPackageJson(projectRoot);
  if (!packageJson) {
    return false;
  }

  const dependencyGroups = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.peerDependencies,
    packageJson.optionalDependencies,
  ];
  if (dependencyGroups.some((group) => {
    const dependencyGroup = typeof group === "object" && group !== null ? group : undefined;
    return recordHasOwnStringKey(dependencyGroup, "nuxt") || recordHasOwnStringKey(dependencyGroup, "nuxt-nightly");
  })) {
    return true;
  }

  if (typeof packageJson.scripts !== "object" || packageJson.scripts === null || Array.isArray(packageJson.scripts)) {
    return false;
  }

  return Object.values(packageJson.scripts).some((script) => {
    if (typeof script !== "string") {
      return false;
    }
    const normalizedScript = script.trim();
    return normalizedScript === "nuxt"
      || normalizedScript.startsWith("nuxt ")
      || normalizedScript === "nuxi"
      || normalizedScript.startsWith("nuxi ");
  });
}

function detectNuxtProject(options: PomGeneratorPluginOptions, projectRoot: string): boolean {
  if ((options as NuxtMarkedOptions)[nuxtConfigMarker] === true) {
    return true;
  }

  if (nuxtConfigFileNames.some(fileName => fs.existsSync(path.join(projectRoot, fileName)))) {
    return true;
  }

  return projectPackageLooksNuxt(projectRoot)
    && nuxtSourceMarkers.some(entry => fs.existsSync(path.join(projectRoot, entry)));
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
    };
    sharedGeneratorStateRegistry.set(key, state);
  }
  return state;
}

function applyTemplateCompilerOptionsToResolvedVuePlugin(
  config: ResolvedConfig,
  templateCompilerOptions: Record<string, unknown>,
  mode: "nuxt" | VuePluginOwnership,
): void {
  const viteVuePlugin = (config.plugins ?? []).find((plugin): plugin is ViteVuePluginLike => plugin.name === "vite:vue");
  if (!viteVuePlugin?.api) {
    if (mode === "external") {
      throw new Error(
        "[vue-pom-generator] vuePluginOwnership=\"external\" requires the resolved Vite Vue plugin, but none was found. "
        + "Add vue() to your Vite plugins before spreading createVuePomGeneratorPlugins(...)."
      );
    }

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

function assertNotVitePluginInstance(options: PomGeneratorPluginOptions): void {
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
    + `Pass Vue plugin options via { vueOptions: { ... } } instead, or add vue() separately in Vite and use { vuePluginOwnership: "external" }.`
  );
}

export function createVuePomGeneratorPlugins(options: PomGeneratorPluginOptions = {}): PluginOption[] {
  assertNotVitePluginInstance(options);

  const injection = options.injection ?? {};
  type GenerationConfig = NonNullable<Exclude<PomGeneratorPluginOptions["generation"], false>>;
  const isNuxt = detectNuxtProject(options, process.cwd());

  const generationSetting = options.generation;
  const generationOptions: GenerationConfig | null = generationSetting === false ? null : (generationSetting ?? {});
  const generationEnabled = generationOptions !== null;
  const vueGenerationOptions = generationOptions as NonNullable<Exclude<VuePomGeneratorPluginOptions["generation"], false>> | null;

  const verbosity: VuePomGeneratorVerbosity = options.logging?.verbosity ?? "warn";

  const vueOptions = options.vueOptions;

  const legacyVueOptions = options as VuePomGeneratorPluginOptions;
  const pageDirsRef = { current: (!isNuxt ? [legacyVueOptions.injection?.viewsDir ?? "src/views"] : ["app/pages"]) };
  const componentDirsRef = { current: (!isNuxt ? (legacyVueOptions.injection?.componentDirs ?? ["src/components"]) : ["app/components"]) };
  const layoutDirsRef = { current: (!isNuxt ? (legacyVueOptions.injection?.layoutDirs ?? ["src/layouts"]) : ["app/layouts"]) };
  const wrapperSearchRootsRef = { current: (!isNuxt ? (legacyVueOptions.injection?.wrapperSearchRoots ?? []) : []) };
  const nativeWrappers = (injection.nativeWrappers ?? {}) as NativeWrappersMap;
  const excludedComponents = injection.excludeComponents ?? [];
  const testIdAttribute = (injection.attribute ?? "data-testid").trim() || "data-testid";
  const existingIdBehavior: ExistingIdBehavior = injection.existingIdBehavior ?? "preserve";
  const clickInstrumentation = injection.clickInstrumentation ?? true;

  const outDir = (generationOptions?.outDir ?? "tests/playwright/__generated__").trim();
  const emitLanguages: Array<"ts" | "csharp"> = (generationOptions?.emit && generationOptions.emit.length)
    ? generationOptions.emit
    : ["ts"];
  const nameCollisionBehavior: PomNameCollisionBehavior = generationOptions?.nameCollisionBehavior ?? "suffix";
  const routerEntry = !isNuxt ? vueGenerationOptions?.router?.entry : undefined;
  const routerType = isNuxt ? "nuxt" : (vueGenerationOptions?.router?.type ?? "vue-router");
  const routerModuleShims = !isNuxt ? vueGenerationOptions?.router?.moduleShims : undefined;
  if (isNuxt && options.vuePluginOwnership === "internal") {
    throw new Error("[vue-pom-generator] Nuxt projects must use the resolved app-owned vite:vue plugin. Omit vuePluginOwnership or set it to \"external\".");
  }
  const vuePluginOwnership: VuePluginOwnership = isNuxt ? "external" : (options.vuePluginOwnership ?? "internal");
  const usesExternalVuePlugin = vuePluginOwnership === "external";
  const csharp = generationOptions?.csharp;
  const errorBehavior = options.errorBehavior;
  const missingSemanticNameBehavior = resolveMissingSemanticNameBehavior(errorBehavior);
  const typescriptOutputStructure: PlaywrightOutputStructure = generationOptions?.playwright?.outputStructure ?? "aggregated";
  const generateFixtures = generationOptions?.playwright?.fixtures;
  const customPoms = generationOptions?.playwright?.customPoms;

  const resolvedCustomPomAttachments = customPoms?.attachments ?? [];
  const resolvedCustomPomDir = customPoms?.dir ?? "tests/playwright/pom/custom";
  const resolvedCustomPomImportAliases = customPoms?.importAliases;
  const resolvedCustomPomImportCollisionBehavior = customPoms?.importNameCollisionBehavior ?? "error";

  const basePageClassPathOverride = generationOptions?.basePageClassPath;
  const getPageDirs = () => pageDirsRef.current;
  const getViewsDir = () => getPageDirs()[0] ?? "src/views";
  const getComponentDirs = () => componentDirsRef.current;
  const getLayoutDirs = () => layoutDirsRef.current;
  const getSourceDirs = () => Array.from(new Set([
    ...getPageDirs(),
    ...getComponentDirs(),
    ...getLayoutDirs(),
  ]));
  const getWrapperSearchRoots = () => wrapperSearchRootsRef.current;
  const sharedStateKey = JSON.stringify({
    cwd: process.cwd(),
    mode: isNuxt ? "nuxt" : "vue",
    pageDirs: isNuxt ? null : getPageDirs(),
    componentDirs: isNuxt ? null : getComponentDirs(),
    layoutDirs: isNuxt ? null : getLayoutDirs(),
    wrapperSearchRoots: isNuxt ? null : getWrapperSearchRoots(),
    outDir,
    testIdAttribute,
    routerType,
    vuePluginOwnership,
  });
  const sharedState = getSharedGeneratorState(sharedStateKey);
  let templateCompilerOptionsForResolvedPlugin: ReturnType<typeof createVuePluginWithTestIds>["templateCompilerOptions"];

  // Shared state: initialized with process.cwd(), then updated in configResolved.
  const projectRootRef = { current: process.cwd() };
  const loggerRef: { current: VuePomGeneratorLogger } = {
    current: createLogger({ verbosity }),
  };

  const configPlugin: PluginOption = {
    name: "vue-pom-generator-config",
    enforce: "pre",
    async configResolved(config: ResolvedConfig) {
      projectRootRef.current = config.root;
      loggerRef.current = createLogger({ verbosity, viteLogger: config.logger });

      if ((vueGenerationOptions?.router?.type as string | undefined) === "nuxt") {
        throw new Error("[vue-pom-generator] Remove generation.router.type=\"nuxt\". Nuxt projects are auto-detected.");
      }

      if (isNuxt) {
        const nuxtDiscovery = await loadNuxtProjectDiscovery(process.cwd());
        projectRootRef.current = nuxtDiscovery.rootDir;
        pageDirsRef.current = nuxtDiscovery.pageDirs.length
          ? nuxtDiscovery.pageDirs
          : [path.resolve(nuxtDiscovery.srcDir, "pages")];
        componentDirsRef.current = nuxtDiscovery.componentDirs;
        layoutDirsRef.current = nuxtDiscovery.layoutDirs;
        wrapperSearchRootsRef.current = nuxtDiscovery.wrapperSearchRoots;
      }

      // Fail-fast validation.
      assertNonEmptyString(testIdAttribute, "[vue-pom-generator] injection.attribute");
      assertNonEmptyString(getViewsDir(), "[vue-pom-generator] injection.viewsDir");
      assertNonEmptyStringArray(getComponentDirs(), "[vue-pom-generator] injection.componentDirs");
      assertNonEmptyStringArray(getLayoutDirs(), "[vue-pom-generator] injection.layoutDirs");
      assertNonEmptyStringArray(getWrapperSearchRoots(), "[vue-pom-generator] injection.wrapperSearchRoots");
      assertErrorBehavior(errorBehavior, "[vue-pom-generator] errorBehavior");

      if (generationEnabled) {
        assertNonEmptyString(outDir, "[vue-pom-generator] generation.outDir");
        assertOneOf(typescriptOutputStructure, ["aggregated", "split"], "[vue-pom-generator] generation.playwright.outputStructure");
        assertRouterModuleShims(routerModuleShims, "[vue-pom-generator] generation.router.moduleShims");

        if (!isNuxt && vueGenerationOptions?.router && routerType === "vue-router") {
          assertNonEmptyString(routerEntry, "[vue-pom-generator] generation.router.entry");
        }
      }

      if (usesExternalVuePlugin) {
        applyTemplateCompilerOptionsToResolvedVuePlugin(
          config,
          templateCompilerOptionsForResolvedPlugin,
          isNuxt ? "nuxt" : vuePluginOwnership,
        );
      }

      // Small but helpful diagnostics.
      loggerRef.current.info(`projectRoot=${projectRootRef.current}`);
      loggerRef.current.info(`viewsDir=${getViewsDir()}`);
      loggerRef.current.info(`componentDirs=${getComponentDirs().join(", ")}`);
      loggerRef.current.info(`layoutDirs=${getLayoutDirs().join(", ")}`);
      loggerRef.current.info(`Active plugins: ${(config.plugins ?? []).map(p => p.name).filter(n => n.includes("vue-pom")).join(", ")}`);
    },
  };

  const getViewsDirAbs = () => resolveFromProjectRoot(projectRootRef.current, getViewsDir());
  const getWrapperSearchRootsAbs = () => getWrapperSearchRoots().map(root => resolveFromProjectRoot(projectRootRef.current, root));

  const { componentTestIds, elementMetadata, semanticNameMap, componentHierarchyMap, vueFilesPathMap } = sharedState;

  const { metadataCollectorPlugin, internalVuePlugin, templateCompilerOptions } = createVuePluginWithTestIds({
    vueOptions,
    existingIdBehavior,
    nameCollisionBehavior,
    clickInstrumentation,
    nativeWrappers,
    elementMetadata,
    semanticNameMap,
    componentHierarchyMap,
    vueFilesPathMap,
    excludedComponents,
    getViewsDirAbs,
    testIdAttribute,
    loggerRef,
    getSourceDirs,
    getWrapperSearchRoots: getWrapperSearchRootsAbs,
    getProjectRoot: () => projectRootRef.current,
  });
  templateCompilerOptionsForResolvedPlugin = templateCompilerOptions;

  const routerAwarePoms = (typeof routerEntry === "string" && routerEntry.trim().length > 0) || routerType === "nuxt";

  const supportPlugins = createSupportPlugins({
    componentTestIds,
    componentHierarchyMap,
    vueFilesPathMap,
    nativeWrappers,
    excludedComponents,
    getPageDirs,
    getComponentDirs,
    getLayoutDirs,
    getViewsDir,
    getSourceDirs,
    getWrapperSearchRoots: getWrapperSearchRootsAbs,
    nameCollisionBehavior,
    missingSemanticNameBehavior,
    existingIdBehavior,
    clickInstrumentation,
    outDir,
    emitLanguages,
    typescriptOutputStructure,
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
    loggerRef,
    routerType,
    routerModuleShims,
  });

  if (isNuxt) {
    loggerRef.current.info("Nuxt environment detected. Skipping internal @vitejs/plugin-vue to avoid conflicts.");
  }
  else if (usesExternalVuePlugin) {
    loggerRef.current.info("vuePluginOwnership=\"external\" enabled. Patching the resolved vite:vue plugin instead of creating an internal one.");
  }

  const resultPlugins = [
    configPlugin,
    metadataCollectorPlugin,
    ...(usesExternalVuePlugin ? [] : [internalVuePlugin]),
    ...supportPlugins,
  ];

  if (!generationEnabled) {
    const virtualModules = createTestIdsVirtualModulesPlugin(componentTestIds);
    return [
      configPlugin,
      metadataCollectorPlugin,
      ...(usesExternalVuePlugin ? [] : [internalVuePlugin]),
      virtualModules,
    ];
  }

  return resultPlugins;
}

export default createVuePomGeneratorPlugins;
