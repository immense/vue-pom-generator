import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { Options as VuePluginOptions } from "@vitejs/plugin-vue";
import vue from "@vitejs/plugin-vue";
import type { PluginOption, ViteDevServer } from "vite";
import * as compilerDom from "@vue/compiler-dom";
import { parse as parseSfc } from "@vue/compiler-sfc";
import virtualImport from "vite-plugin-virtual";
import { compileWithMetadataExtractionManual } from "./compiler-wrapper";
import { generateFiles } from "./class-generation";
import { generateTestIdsModule } from "./manifest-generator";
import type { ElementMetadata } from "./metadata-collector";
import { createTestIdTransform } from "./transform";
import { setResolveToComponentNameFn, setRouteNameToComponentNameMap, toPascalCase } from "./utils";
import type { IComponentDependencies, NativeWrappersMap } from "./utils";
import { CompilerOptions, NodeTypes, RootNode, TemplateChildNode, TransformContext } from "@vue/compiler-core";
import { parseRouterFileFromCwd } from "./router-introspection";

export type ExistingIdBehavior = "preserve" | "overwrite" | "error";

export interface VuePomGeneratorPluginOptions {
  /** Options forwarded to @vitejs/plugin-vue */
  vueOptions?: VuePluginOptions;

  /**
   * Configuration for injecting/deriving test ids from Vue templates.
   *
   * This plugin can still *collect* metadata for code generation even when injection is disabled.
   */
  injection?: {
    /**
     * Whether to inject the attribute into the compiled template output.
     *
     * - `true` (default): inject/overwrite (depending on existingIdBehavior)
     * - `false`: collect-only (useful if your app already renders stable ids, but you still want POM generation)
     */
    enabled?: boolean;

    /**
     * HTML attribute name to inject/treat as the "test id".
     *
     * Defaults to `data-testid`.
     *
     * Common alternatives: `data-qa`, `data-cy`.
     */
    attribute?: string;

    /**
     * Folder convention used to identify "pages" (Nuxt/Vue) or "views" (this repo).
     *
     * Behavior:
     * - This is a simple *substring* match against the normalized absolute Vue file path.
     * - If the file path contains `/<viewsDir>/` the component is treated as a "view".
     *
     * Default: `"src/views"` (no leading slash).
     */
    viewsDir?: string;

    /**
     * Wrapper component configuration.
     *
     * Why this exists:
     * Many design-system components wrap native inputs/buttons and do NOT forward attributes
     * like `data-testid` down to the actual DOM element that Playwright clicks/reads.
     *
     * If you don't configure wrappers, you can end up with:
     * - selectors that point at the wrapper component instead of the clickable element
     * - generated ids that collide (all wrappers look like "button" without stable identity)
     * - inability to generate correct POM methods for selects/radios because the "native role" is hidden
     *
     * Example:
     * - `ImmyButton` wraps a `<button>`
     * - `ImmyTextInput` wraps an `<input>`
     * - `VSelect` renders a custom dropdown structure that behaves like a select
     */
    nativeWrappers?: NativeWrappersMap;

    /**
     * Components to exclude from test id injection/collection.
     *
     * Useful for components that manage their own ids or for very generic layout components
     * that would otherwise produce noisy test ids.
     */
    excludeComponents?: string[];

    /**
     * What to do when the author already provided a test id attribute.
     *
     * - `"preserve"` (default): keep the existing value
     * - `"overwrite"`: replace it with the generated value
     * - `"error"`: throw to force cleanup/migration
     */
    existingIdBehavior?: ExistingIdBehavior;
  };

  /**
   * Code generation configuration.
   *
   * Set to `false` to disable code generation entirely while still injecting/collecting test ids.
   */
  generation?: false | {
    /**
     * Output directory for generated files.
     *
     * Defaults to `./pom` (relative to `process.cwd()` when not absolute).
     */
    outDir?: string;

    /**
     * Absolute path to the BasePage template module to inline into generated output.
     * Defaults to the copy shipped with this package: ./class-generation/BasePage.ts.
     */
    basePageClassPath?: string;

    /**
     * Router integration used for resolving `:to` directives and emitting navigation helpers.
     *
     * If omitted, router introspection is disabled.
     */
    router?: { entry: string };

    /** Playwright-specific generation features (fixtures + custom POM helpers). */
    playwright?: {
      /**
       * Generate Playwright fixture helpers alongside generated POMs.
       *
       * Default output (when `true`):
       * - `<projectRoot>/tests/playwright/fixture/Fixtures.g.ts`
       */
      fixtures?: boolean | string | { outDir?: string };

      /**
       * Handwritten Page Object Model helpers and attachments.
       *
       * Typical use cases:
       * - You have a complex UI widget (grid/modal/date picker) and want a reusable wrapper class.
       * - You want certain helpers attached only when a view uses a given component.
       *
       * Without custom POM helpers, tests can still work, but they often devolve into:
       * - repeated locator boilerplate
       * - inconsistent conventions across test files
       * - brittle selectors for complex widgets
       */
      customPoms?: {
        /** Directory containing handwritten helpers to inline/import. Defaults to `<outDir>/custom`. */
        dir?: string;

        /** Optional import aliases for handwritten helpers (basename -> alias). */
        importAliases?: Record<string, string>;

        /**
         * Conditional helper attachments.
         *
         * Example: attach a `grid: Grid` helper only to views/components that use `DxDataGrid`.
         */
        attachments?: Array<{
          className: string;
          propertyName: string;
          attachWhenUsesComponents: string[];
          attachTo?: "views" | "components" | "both";
        }>;
      };
    };
  };
}

export function createVueTestIdPlugins(options: VuePomGeneratorPluginOptions = {}): PluginOption[] {
  const injection = options.injection ?? {};
  const generation = options.generation === false ? null : (options.generation ?? {});

  const vueOptions = options.vueOptions;

  const injectTestIds = injection.enabled !== false;
  const viewsDir = injection.viewsDir ?? "src/views";
  const nativeWrappers = injection.nativeWrappers ?? {};
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
    const maybeModule = virtualImport as { default?: typeof virtualImport };
    const virtual = maybeModule.default ?? virtualImport;
    const virtualModules = virtual({
      "virtual:testids": () => generateTestIdsModule(componentTestIds),
    });
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

interface InternalFactoryOptions {
  vueOptions?: VuePluginOptions;
  enableTestIds: boolean;
  debugTestIds: boolean;
  injectTestIds: boolean;
  existingIdBehavior: ExistingIdBehavior;
  nativeWrappers: NativeWrappersMap;
  elementMetadata: Map<string, Map<string, ElementMetadata>>;
  semanticNameMap: Map<string, string>;
  componentHierarchyMap: Map<string, IComponentDependencies>;
  vueFilesPathMap: Map<string, string>;
  excludedComponents: string[];
  viewsDir: string;
  testIdAttribute: string;
}

function createVuePluginWithTestIds(options: InternalFactoryOptions): PluginOption {
  const {
    vueOptions,
    enableTestIds,
    debugTestIds,
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
  } = options;

  const userTemplate = vueOptions?.template ?? {};
  const userCompilerOptions = userTemplate.compilerOptions ?? {};
  const userNodeTransforms = userCompilerOptions.nodeTransforms ?? [];

  // Vue compiler runs nodeTransforms for every node in a template.
  // We need a per-file transform instance so state accumulates across nodes.
  const perFileTransform = new Map<string, ReturnType<typeof createTestIdTransform>>();


  const templateCompilerOptions = enableTestIds
    ? {
      ...userCompilerOptions,
      // Ensures compiler-core runs `transformExpression` (in non-browser builds),
      // which parses directive expressions via @babel/parser and attaches `exp.ast`.
      // This improves reliability for AST-based consumers (like our data-testid generator).
      prefixIdentifiers: true,
      nodeTransforms: [
        ...userNodeTransforms,
        (node: RootNode | TemplateChildNode, context: TransformContext) => {
          if (!context.filename)
            return;
          const componentName = path.basename(context.filename, ".vue");

          // Root is visited first; treat it as the start of a new compilation run for this SFC.
          if (node.type === NodeTypes.ROOT) {
            // HMR/dev rebuilds can re-run template transforms for the same SFC multiple times.
            // Reset the component entry once per run to avoid stale/duplicate methods.
            componentHierarchyMap.delete(componentName);
            vueFilesPathMap.set(componentName, context.filename);

            perFileTransform.set(
              componentName,
              createTestIdTransform(
                componentName,
                componentHierarchyMap,
                nativeWrappers,
                excludedComponents,
                viewsDir,
                { injectTestIds, existingIdBehavior, testIdAttribute },
              ),
            );
          }

          let transform = perFileTransform.get(componentName);
          if (!transform) {
            // Safety net: create a transform if root wasn't observed for some reason.
            componentHierarchyMap.delete(componentName);
            vueFilesPathMap.set(componentName, context.filename);
            transform = createTestIdTransform(
              componentName,
              componentHierarchyMap,
              nativeWrappers,
              excludedComponents,
              viewsDir,
              { injectTestIds, existingIdBehavior, testIdAttribute },
            );
            perFileTransform.set(componentName, transform);
          }

          return transform(node, context);
        },
      ],
    }
    : userCompilerOptions;

  const template = {
    ...userTemplate,
    compiler: {
      // Preserve the full compiler-dom module behavior (directiveTransforms, nodeTransforms, etc.).
      // We only override `compile` to run our metadata extraction after transforms.
      ...compilerDom,
      compile(source: string, compilerOptions: CompilerOptions) {
        const componentName = compilerOptions.filename
          ? path.basename(compilerOptions.filename, ".vue")
          : "Unknown";
        return compileWithMetadataExtractionManual(
          source,
          compilerOptions,
          componentName,
          elementMetadata,
          semanticNameMap,
          debugTestIds,
          testIdAttribute,
        );
      },
    },
    compilerOptions: templateCompilerOptions,
  };

  return vue({
    ...vueOptions,
    template,
  } as VuePluginOptions);
}

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

function createSupportPlugins(options: SupportFactoryOptions): PluginOption[] {
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

  // Bridge between configureServer (where we have timers/logger) and handleHotUpdate.
  let scheduleVueFileRegen: ((filePath: string, source: "hmr" | "fs") => void) | null = null;
  // Vite (v6/v7) may run multiple build environments/passes (e.g. SSR + client) in a single invocation.
  // Some passes can execute without compiling any Vue SFC templates that reach our transform, leaving
  // `componentHierarchyMap` empty. If we blindly generate on that pass, we can overwrite a previously
  // correct `pom/index.g.ts` with an incomplete file (missing page classes like TenantListPage).
  //
  // Guard generation so we only write when we have meaningful data, and prefer the "largest" pass.
  let lastGeneratedEntryCount = 0;
  const maybeModule = virtualImport as { default?: typeof virtualImport };
  const virtual = maybeModule.default ?? virtualImport;

  const getDefaultBasePageClassPath = () => {
    // Prefer resolving relative to this package so consumers don't need a repo-specific layout.
    // Works in ESM output.
    try {
      return fileURLToPath(new URL("./class-generation/BasePage.ts", import.meta.url));
    }
    catch {
      // Fallback for CJS output.

      return path.resolve(__dirname, "class-generation", "BasePage.ts");
    }
  };

  const basePageClassPath = basePageClassPathOverride ?? getDefaultBasePageClassPath();

  const tsProcessor: PluginOption = {
    name: "vue-testid-ts-processor",
    // This plugin exists to generate code on build output; it is not needed during dev-server HMR.
    apply: "build",
    enforce: "pre",
    async buildStart() {
      // Router introspection: build a route-name -> component-name map once per build.
      // This enables `:to`-based methods to return `new <TargetPage>(page)`.
      if (!vueRouterFluentChaining) {
			setRouteNameToComponentNameMap(new Map());
			setResolveToComponentNameFn(() => null);
			return;
		}

    if (!resolvedRouterEntry)
      throw new Error("[vue-pom-generator] router.entry is required when router introspection is enabled.");
    const { routeNameMap, routePathMap } = await parseRouterFileFromCwd(resolvedRouterEntry);
		setRouteNameToComponentNameMap(routeNameMap);

      // Provide a resolve()-like helper:
      // - string: treat as literal path, exact match
      // - object: prefer name (normalized key), fallback to literal path
      setResolveToComponentNameFn((to) => {
        if (typeof to === "string") {
          return routePathMap.get(to) ?? null;
        }

        const maybe = to as { name?: string; path?: string };
        if (typeof maybe.name === "string" && maybe.name.length) {
          const key = toPascalCase(maybe.name);
          return routeNameMap.get(key) ?? null;
        }
        if (typeof maybe.path === "string" && maybe.path.length) {
          return routePathMap.get(maybe.path) ?? null;
        }
        return null;
      });
      if (!fs.existsSync(basePageClassPath)) {
        this.error(`BasePage.ts not found at ${basePageClassPath}. Ensure it is included in the build.`);
      }
      this.addWatchFile(basePageClassPath);
    },
    buildEnd() {
      // Vite normalizes resolved ids to posix-style paths for plugin hooks.
      const normalizedBasePagePath = path.posix.normalize(basePageClassPath);
      const entryCount = componentHierarchyMap.size;
      if (entryCount <= 0) {
        // Skip generation rather than overwriting an existing aggregated file with an empty one.
        return;
      }

      if (entryCount < lastGeneratedEntryCount) {
        // If we already generated from a richer pass, do not clobber it with a smaller/partial pass.
        return;
      }

      generateFiles(componentHierarchyMap, vueFilesPathMap, normalizedBasePagePath, {
        outDir,
        generateFixtures,
    customPomAttachments,
    projectRoot,
    customPomDir,
    customPomImportAliases,
    testIdAttribute,
        vueRouterFluentChaining,
        routerEntry: resolvedRouterEntry,
      });
      lastGeneratedEntryCount = entryCount;
    },
    closeBundle() {
      console.log("\n=== Build Complete ===");
    },
  };

  // Dev-server (HMR) support:
  // During `vite serve`, we still want to keep the generated aggregated POM(s) in sync so that
  // Playwright tests and dev workflows immediately reflect changes.
  //
  // Notes:
  // - The generator relies on `componentHierarchyMap` which is populated by the Vue template
  //   transform above. In dev, this map updates as Vue SFCs are compiled.
  // - We debounce to avoid thrashing when a save triggers multiple watcher events.
  // - We ignore changes to generated output to prevent infinite loops.
  const devProcessor: PluginOption = {
    name: "vue-testid-dev-processor",
    apply: "serve",

    // Prefer hot-update events over filesystem change events for speed and reliability.
    // This fires when Vite has actually processed the module update.
    handleHotUpdate(ctx) {
      if (!scheduleVueFileRegen)
        return;
      if (!ctx.file.endsWith(".vue"))
        return;
      if (!ctx.file.includes(`${path.sep}src${path.sep}`))
        return;

      scheduleVueFileRegen(ctx.file, "hmr");
    },
    configureServer(server: ViteDevServer) {
      const normalizedBasePagePath = path.posix.normalize(basePageClassPath);

      // Router introspection (dev-server): mirror the buildStart behavior so that
      // :to directives can be resolved into target page classes and we emit goTo*
      // fluent navigation methods in generated POM output.
      //
      // Important: this MUST be awaited before the initial snapshot compile; otherwise
      // the first regen can run with an empty resolver and permanently clobber POMs.
      const routerInitPromise = (async () => {
        if (!vueRouterFluentChaining) {
          setRouteNameToComponentNameMap(new Map());
          setResolveToComponentNameFn(() => null);
          return;
        }

        if (!resolvedRouterEntry)
          throw new Error("[vue-pom-generator] router.entry is required when router introspection is enabled.");
        const { routeNameMap, routePathMap } = await parseRouterFileFromCwd(resolvedRouterEntry);
        setRouteNameToComponentNameMap(routeNameMap);
        setResolveToComponentNameFn((to) => {
          if (typeof to === "string") {
            return routePathMap.get(to) ?? null;
          }

          const maybe = to as { name?: string; path?: string };
          if (typeof maybe.name === "string" && maybe.name.length) {
            const key = toPascalCase(maybe.name);
            return routeNameMap.get(key) ?? null;
          }
          if (typeof maybe.path === "string" && maybe.path.length) {
            return routePathMap.get(maybe.path) ?? null;
          }
          return null;
        });
      })();

      // Dev regeneration strategy:
      // Generating aggregated output from Vite's incremental module graph is inherently racy:
      // only a subset of SFCs may have been transformed at any point in time.
      //
      // Deterministically rebuild the hierarchy by scanning
      // `src/**/*.vue` from disk and running the Vue template compiler with our transform.
      // This guarantees index.g.ts is complete and reflects current source-of-truth.

      const logger = server.config.logger;
      const log = (message: string) => {
        // Vite's logger prints with its own prefix and respects log levels.
        logger.info(`[vue-testid] ${message}`);
      };

      // Bridged to handleHotUpdate (set once configureServer has access to Vite logger + timers).
      let scheduleVueFileRegenLocal: ((filePath: string, source: "hmr" | "fs") => void) | null = null;

      const formatMs = (ms: number) => `${ms.toFixed(1)}ms`;

      const extractTemplateFromSfc = (source: string, filename?: string): string => {
        // Use Vue's official SFC parser rather than string-slicing.
        // This correctly handles:
        // - <template ...> attributes
        // - extra whitespace/newlines
        // - <template> appearing in JS strings/comments
        // - edge cases around ordering/offsets
        const { descriptor } = parseSfc(source, {
          filename: filename ?? "anonymous.vue",
        });
        return descriptor.template?.content ?? "";
      };

      const walkFilesRecursive = (rootDir: string): string[] => {
        const out: string[] = [];
        const stack: string[] = [rootDir];
        while (stack.length) {
          const dir = stack.pop();
          if (!dir) continue;
          let entries: Array<fs.Dirent> = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          }
          catch {
            continue;
          }

          for (const ent of entries) {
            if (ent.isDirectory()) {
              if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist")
                continue;
              stack.push(path.join(dir, ent.name));
              continue;
            }
            if (ent.isFile() && ent.name.endsWith(".vue")) {
              out.push(path.join(dir, ent.name));
            }
          }
        }
        return out;
      };

      // Build a complete snapshot once, then incrementally update on each changed .vue.
      const snapshotHierarchy = new Map<string, IComponentDependencies>();
      const snapshotVuePathMap = new Map<string, string>();
      const filePathToComponentName = new Map<string, string>();

      const getComponentNameForFile = (filePath: string) => {
        const normalized = path.resolve(filePath);
        const existing = filePathToComponentName.get(normalized);
        if (existing)
          return existing;
        const name = path.basename(normalized, ".vue");
        filePathToComponentName.set(normalized, name);
        return name;
      };

      const compileVueFileIntoSnapshot = (filePath: string) => {
        const started = performance.now();
        const absolutePath = path.resolve(filePath);
        const componentName = getComponentNameForFile(absolutePath);
        snapshotVuePathMap.set(componentName, absolutePath);

        // Ensure a clean rebuild for this component to avoid stale accumulation.
        snapshotHierarchy.delete(componentName);

        let sfc = "";
        try {
          sfc = fs.readFileSync(absolutePath, "utf8");
        }
        catch {
          return { componentName, ms: performance.now() - started, compiled: false };
        }

        const template = extractTemplateFromSfc(sfc, absolutePath);
        if (!template.trim())
          return { componentName, ms: performance.now() - started, compiled: true };

        try {
          // Run the Vue compiler purely for its transform pipeline; we don't care about output code.
          compilerDom.compile(template, {
            filename: absolutePath,
            prefixIdentifiers: true,
            nodeTransforms: [
              createTestIdTransform(
                componentName,
                snapshotHierarchy,
                nativeWrappers,
                excludedComponents,
                viewsDir,
                { injectTestIds: false, existingIdBehavior: "preserve", testIdAttribute },
              ),
            ],
          });
        }
        catch {
          // If a template fails to compile, Vite will surface errors during normal dev.
          // We keep the last-known good snapshot entry deleted so the regen reflects current state.
        }

        return { componentName, ms: performance.now() - started, compiled: true };
      };

      const fullRebuildSnapshotFromFilesystem = () => {
        const srcDir = path.resolve(projectRoot, "src");
        if (!fs.existsSync(srcDir))
          return;

        const t0 = performance.now();
        snapshotHierarchy.clear();
        snapshotVuePathMap.clear();
        filePathToComponentName.clear();

        const vueFiles = walkFilesRecursive(srcDir);
        log(`initial scan: found ${vueFiles.length} .vue files under src/`);

        let compiledCount = 0;
        for (const file of vueFiles) {
          const res = compileVueFileIntoSnapshot(file);
          if (res.compiled)
            compiledCount++;
        }

        const t1 = performance.now();
        log(`initial compile: ${compiledCount}/${vueFiles.length} files in ${formatMs(t1 - t0)} (components=${snapshotHierarchy.size})`);
      };

      const generateAggregatedFromSnapshot = (reason: string) => {
        const t0 = performance.now();
        generateFiles(snapshotHierarchy, snapshotVuePathMap, normalizedBasePagePath, {
          outDir,
          generateFixtures,
          customPomAttachments,
          projectRoot,
          customPomDir,
		  customPomImportAliases,
		  testIdAttribute,
          vueRouterFluentChaining,
          routerEntry: resolvedRouterEntry,
        });
        const t1 = performance.now();
        log(`generate(${reason}): components=${snapshotHierarchy.size} in ${formatMs(t1 - t0)}`);
      };

      // Kick off the initial snapshot build once; changes will wait until it completes.
      const initialBuildPromise = (async () => {
        const t0 = performance.now();
        await routerInitPromise;
        fullRebuildSnapshotFromFilesystem();
        generateAggregatedFromSnapshot("startup");
        const t1 = performance.now();
        log(`startup total: ${formatMs(t1 - t0)}`);
      })();

      // Watch relevant inputs.
      // Use platform-native absolute paths/globs for chokidar reliability (especially on macOS).
      const watchedVueGlob = path.resolve(projectRoot, "src", "**", "*.vue");
      const watchedPluginGlob = path.resolve(projectRoot, "vite-plugins", "vue-pom-generator", "**", "*.ts");
      server.watcher.add([watchedVueGlob, watchedPluginGlob, basePageClassPath]);

      let timer: NodeJS.Timeout | null = null;
      let maxWaitTimer: NodeJS.Timeout | null = null;
      const pendingChangedVueFiles = new Set<string>();
      const pendingDeletedComponents = new Set<string>();

      scheduleVueFileRegenLocal = (filePath: string, source: "hmr" | "fs") => {
        pendingChangedVueFiles.add(filePath);
        // Emit something immediately so you can see we're reacting.
        log(`queued(${source}): files=${pendingChangedVueFiles.size} deleted=${pendingDeletedComponents.size}`);
        scheduleAggregatedRegen();
      };

      scheduleVueFileRegen = scheduleVueFileRegenLocal;

      function scheduleAggregatedRegen() {
        const wasEmpty = pendingChangedVueFiles.size === 0 && pendingDeletedComponents.size === 0;

        // Ensure we don't get "starved" by a flurry of filesystem events that keep resetting the debounce.
        // We will always run within MAX_WAIT_MS of the first queued change.
        const MAX_WAIT_MS = 750;
        if (!maxWaitTimer) {
          maxWaitTimer = setTimeout(() => {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            maxWaitTimer = null;
            // Execute immediately.
            void (async () => {
              const t0 = performance.now();
              await initialBuildPromise;

              // Apply deletions first.
              for (const componentName of pendingDeletedComponents) {
                snapshotHierarchy.delete(componentName);
                snapshotVuePathMap.delete(componentName);
              }

              const files = Array.from(pendingChangedVueFiles);
              const deletedCount = pendingDeletedComponents.size;
              pendingChangedVueFiles.clear();
              pendingDeletedComponents.clear();

              let compileMs = 0;
              for (const f of files) {
                const res = compileVueFileIntoSnapshot(f);
                compileMs += res.ms;
              }

              const t1 = performance.now();
              generateAggregatedFromSnapshot("max-wait");
              const t2 = performance.now();

              log(
                `max-wait: files=${files.length} deleted=${deletedCount} `
                + `compile=${formatMs(compileMs)} wall=${formatMs(t1 - t0)} gen=${formatMs(t2 - t1)} total=${formatMs(t2 - t0)}`,
              );
            })();
          }, MAX_WAIT_MS);
        }

        if (wasEmpty) {
          const queuedFiles = pendingChangedVueFiles.size;
          const queuedDeletes = pendingDeletedComponents.size;
          log(`queued: files=${queuedFiles} deleted=${queuedDeletes}`);
        }

        if (timer)
          clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (maxWaitTimer) {
            clearTimeout(maxWaitTimer);
            maxWaitTimer = null;
          }

          void (async () => {
            const t0 = performance.now();
            await initialBuildPromise;

            // Apply deletions first.
            for (const componentName of pendingDeletedComponents) {
              snapshotHierarchy.delete(componentName);
              snapshotVuePathMap.delete(componentName);
            }

            const files = Array.from(pendingChangedVueFiles);
            const deletedCount = pendingDeletedComponents.size;
            pendingChangedVueFiles.clear();
            pendingDeletedComponents.clear();

            let compileMs = 0;
            for (const f of files) {
              const res = compileVueFileIntoSnapshot(f);
              compileMs += res.ms;
            }

            const t1 = performance.now();
            generateAggregatedFromSnapshot(files.length || deletedCount ? "batched" : "noop");
            const t2 = performance.now();

            if (files.length || deletedCount) {
              log(
                `batched: files=${files.length} deleted=${deletedCount} `
                + `compile=${formatMs(compileMs)} wall=${formatMs(t1 - t0)} gen=${formatMs(t2 - t1)} total=${formatMs(t2 - t0)}`,
              );
            }
          })();
        }, 75);
      }

      server.watcher.on("change", async (changedPath) => {
        const changed = path.posix.normalize(changedPath);
        // Avoid loops if the generator itself writes the file.
        if (changed.includes("/pom/") && (changed.endsWith("index.g.ts") || changed.endsWith("index.g.ts.map")))
          return;

        // If plugin source changes, Vite won't hot-reload plugin code. Restart the server so the new
        // generator/template code is loaded, then regenerate.
        if (changed.includes("/vite-plugins/vue-pom-generator/")) {
          void server.restart();
        }

        // Vue SFC changes are handled via handleHotUpdate for better signal/noise.
      });

      server.watcher.on("add", (p) => {
        if (typeof p !== "string")
          return;
        if (!p.endsWith(".vue") || !p.includes(`${path.sep}src${path.sep}`))
          return;
        void (async () => {
          await initialBuildPromise;
          pendingChangedVueFiles.add(p);
          scheduleAggregatedRegen();
        })();
      });

      server.watcher.on("unlink", (p) => {
        if (typeof p !== "string")
          return;
        if (!p.endsWith(".vue") || !p.includes(`${path.sep}src${path.sep}`))
          return;
        void (async () => {
          await initialBuildPromise;
          const absolutePath = path.resolve(p);
          const componentName = getComponentNameForFile(absolutePath);
          filePathToComponentName.delete(absolutePath);
          pendingDeletedComponents.add(componentName);
          scheduleAggregatedRegen();
        })();
      });

      setTimeout(() => {
        // The initial snapshot build/generate is started immediately above.
      }, 250);
    },
  };

  const virtualModules = virtual({
    "virtual:testids": () => generateTestIdsModule(componentTestIds),
  });

  return [tsProcessor, devProcessor, virtualModules];
}
