import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import type { BindingMetadata } from "@vue/compiler-core";
import * as compilerDom from "@vue/compiler-dom";
import { compileScript, parse as parseSfc } from "@vue/compiler-sfc";
import type { PluginOption, ViteDevServer } from "vite";

import { generateFiles } from "../../class-generation";
import { introspectNuxtPages, parseRouterFileFromCwd } from "../../router-introspection";
import { createTestIdTransform } from "../../transform";
import type { IComponentDependencies, NativeWrappersMap, RouterIntrospectionResult } from "../../utils";
import { setResolveToComponentNameFn, setRouteNameToComponentNameMap, toPascalCase } from "../../utils";
import type { VuePomGeneratorLogger } from "../logger";
import { isPathWithinDir, resolveComponentNameFromPath } from "../path-utils";
import type { PlaywrightOutputStructure, PomNameCollisionBehavior, RouterModuleShimDefinition } from "../types";

interface DevProcessorOptions {
  nativeWrappers: NativeWrappersMap;
  excludedComponents: string[];
  getPageDirs: () => string[];
  getComponentDirs: () => string[];
  getLayoutDirs: () => string[];
  getViewsDir: () => string;
  getSourceDirs: () => string[];
  getWrapperSearchRoots: () => string[];

  projectRootRef: { current: string };
  normalizedBasePagePath: string;
  basePageClassPath: string;

  outDir?: string;
  emitLanguages?: Array<"ts" | "csharp">;
  typescriptOutputStructure?: PlaywrightOutputStructure;
  csharp?: {
    namespace?: string;
  };
  generateFixtures?: boolean | string | { outDir?: string };
  customPomAttachments?: Array<{ className: string; propertyName: string; attachWhenUsesComponents: string[]; attachTo?: "views" | "components" | "both" | "pagesAndComponents"; flatten?: boolean }>;
  customPomDir?: string;
  customPomImportAliases?: Record<string, string>;
  customPomImportNameCollisionBehavior?: "error" | "alias";
  nameCollisionBehavior?: PomNameCollisionBehavior;
  missingSemanticNameBehavior?: "ignore" | "error";
  /** How to handle existing data-testid attributes in the source. */
  existingIdBehavior?: "preserve" | "overwrite" | "error";
  clickInstrumentation?: boolean;
  testIdAttribute: string;

  routerAwarePoms: boolean;
  getResolvedRouterEntry: () => string | undefined;
  routerType?: "vue-router" | "nuxt";
  routerModuleShims?: Record<string, RouterModuleShimDefinition>;

  loggerRef: { current: VuePomGeneratorLogger };
}

export function createDevProcessorPlugin(options: DevProcessorOptions): PluginOption {
  const {
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
    outDir,
    emitLanguages,
    typescriptOutputStructure,
    csharp,
    generateFixtures,
    customPomAttachments,
    customPomDir,
    customPomImportAliases,
    customPomImportNameCollisionBehavior,
    nameCollisionBehavior = "suffix",
    missingSemanticNameBehavior = "error",
    existingIdBehavior,
    clickInstrumentation = true,
    testIdAttribute,
    routerAwarePoms,
    getResolvedRouterEntry,
    routerType,
    routerModuleShims,
    loggerRef,
  } = options;

  // Bridge between configureServer (where we have timers/logger) and handleHotUpdate.
  let scheduleVueFileRegen: ((filePath: string, source: "hmr" | "fs") => void) | null = null;
  const getProjectRootCandidates = () => Array.from(new Set([
    path.resolve(projectRootRef.current),
    path.resolve(process.cwd()),
  ]));
  const resolveProjectPath = (maybePath: string) => {
    if (path.isAbsolute(maybePath))
      return maybePath;

    const candidates = getProjectRootCandidates().map(root => path.resolve(root, maybePath));
    return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0]!;
  };
  const getSourceDirRoots = () => Array.from(new Set(
    getProjectRootCandidates().flatMap(root => getSourceDirs().map(dir => path.resolve(root, dir))),
  ));
  const isContainedInScanDirs = (filePath: string) => {
    const absolutePath = path.resolve(filePath);
    return getSourceDirRoots().some(scanDirAbs => isPathWithinDir(absolutePath, scanDirAbs));
  };

  return {
    name: "vue-pom-generator-dev",
    apply: "serve",

    // Prefer hot-update events over filesystem change events for speed and reliability.
    // This fires when Vite has actually processed the module update.
    handleHotUpdate(ctx) {
      if (!scheduleVueFileRegen)
        return;
      if (!ctx.file.endsWith(".vue"))
        return;

      if (!isContainedInScanDirs(ctx.file))
        return;

      scheduleVueFileRegen(ctx.file, "hmr");
    },

    async configureServer(server: ViteDevServer) {
      const getViewsDirAbs = () => resolveProjectPath(getViewsDir());
      const getPageDirsAbs = () => getPageDirs().map(dir => resolveProjectPath(dir));

      // Router introspection (dev-server): mirror the buildStart behavior.
      const routerInitPromise = (async () => {
        if (!routerAwarePoms) {
          setRouteNameToComponentNameMap(new Map());
          setResolveToComponentNameFn(() => null);
          return;
        }

        let result: RouterIntrospectionResult;

        if (routerType === "nuxt") {
          result = await introspectNuxtPages(projectRootRef.current, { pageDirs: getPageDirsAbs() });
        }
        else {
          const resolvedRouterEntry = getResolvedRouterEntry();
          if (!resolvedRouterEntry)
            throw new Error("[vue-pom-generator] router.entry is required when router introspection is enabled.");
          result = await parseRouterFileFromCwd(resolvedRouterEntry, {
            moduleShims: routerModuleShims,
            componentNaming: {
              projectRoot: projectRootRef.current,
              viewsDirAbs: getViewsDirAbs(),
              sourceDirs: getSourceDirs(),
              extraRoots: [process.cwd()],
            },
          });
        }

        const { routeNameMap, routePathMap } = result;
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

      const logInfo = (message: string) => loggerRef.current.info(message);
      const logDebug = (message: string) => loggerRef.current.debug(message);

      let scheduleVueFileRegenLocal: ((filePath: string, source: "hmr" | "fs") => void) | null = null;

      const formatMs = (ms: number) => `${ms.toFixed(1)}ms`;

      const extractTemplateFromSfc = (source: string, filename?: string): string => {
        const { descriptor } = parseSfc(source, {
          filename: filename ?? "anonymous.vue",
        });
        return descriptor.template?.content ?? "";
      };

      const getScriptInfo = (source: string, filename: string): { bindings?: BindingMetadata; isScriptSetup: boolean } => {
        try {
          const { descriptor } = parseSfc(source, { filename });
          if (!descriptor.script && !descriptor.scriptSetup)
            return { bindings: undefined, isScriptSetup: false };
          const scriptBlock = compileScript(descriptor, { id: filename });
          return { bindings: scriptBlock.bindings, isScriptSetup: !!descriptor.scriptSetup };
        }
        catch {
          return { bindings: undefined, isScriptSetup: false };
        }
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
      let snapshotHierarchy = new Map<string, IComponentDependencies>();
      let snapshotVuePathMap = new Map<string, string>();
      const filePathToComponentName = new Map<string, string>();

      const createEmptyComponentDependencies = (absolutePath: string): IComponentDependencies => {
        const viewsDirAbs = path.resolve(getViewsDirAbs());
        const relToViewsDir = path.relative(viewsDirAbs, absolutePath);
        const isView = !relToViewsDir.startsWith("..") && !path.isAbsolute(relToViewsDir);

        return {
          filePath: absolutePath,
          childrenComponentSet: new Set<string>(),
          usedComponentSet: new Set<string>(),
          dataTestIdSet: new Set(),
          isView,
          methodsContent: "",
        };
      };

      const getComponentNameForFile = (filePath: string) => {
        const normalized = path.resolve(filePath);
        const existing = filePathToComponentName.get(normalized);
        if (existing)
          return existing;
        const name = resolveComponentNameFromPath({
          filename: normalized,
          projectRoot: projectRootRef.current,
          viewsDirAbs: getViewsDirAbs(),
          sourceDirs: getSourceDirs(),
          extraRoots: [process.cwd()],
        });
        filePathToComponentName.set(normalized, name);
        return name;
      };

      const compileVueFileIntoSnapshot = (
        filePath: string,
        targetHierarchy: Map<string, IComponentDependencies> = snapshotHierarchy,
        targetVuePathMap: Map<string, string> = snapshotVuePathMap,
      ) => {
        const started = performance.now();
        const absolutePath = path.resolve(filePath);
        const componentName = getComponentNameForFile(absolutePath);

        let sfc = "";
        try {
          sfc = fs.readFileSync(absolutePath, "utf8");
        }
        catch {
          return { componentName, ms: performance.now() - started, compiled: false };
        }

        const template = extractTemplateFromSfc(sfc, absolutePath);
        if (!template.trim()) {
          targetVuePathMap.set(componentName, absolutePath);
          targetHierarchy.set(componentName, createEmptyComponentDependencies(absolutePath));
          return { componentName, ms: performance.now() - started, compiled: true };
        }

        // Compile <script>/<script setup> to get binding metadata so the
        // template compiler resolves identifiers the same way the Vue
        // plugin does during a full build (with prefixIdentifiers).
        // For <script setup> components, the Vue plugin compiles templates
        // in inline mode, which keeps identifiers as-is instead of adding
        // a $setup. prefix. We mirror that here.
        const { bindings: bindingMetadata, isScriptSetup } = getScriptInfo(sfc, absolutePath);

        const provisionalHierarchy = new Map<string, IComponentDependencies>();
        const provisionalVuePathMap = new Map(targetVuePathMap);
        provisionalVuePathMap.set(componentName, absolutePath);

        compilerDom.compile(template, {
          filename: absolutePath,
          prefixIdentifiers: true,
          inline: isScriptSetup,
          bindingMetadata,
          nodeTransforms: [
            createTestIdTransform(
              componentName,
              provisionalHierarchy,
              nativeWrappers,
              excludedComponents,
              getViewsDirAbs(),
              {
                existingIdBehavior: existingIdBehavior ?? "preserve",
                nameCollisionBehavior,
                missingSemanticNameBehavior,
                clickInstrumentation,
                testIdAttribute,
                warn: message => loggerRef.current.warn(message),
                vueFilesPathMap: provisionalVuePathMap,
                wrapperSearchRoots: getWrapperSearchRoots(),
              },
            ),
          ],
        });

        targetVuePathMap.set(componentName, absolutePath);
        targetHierarchy.set(
          componentName,
          provisionalHierarchy.get(componentName) ?? createEmptyComponentDependencies(absolutePath),
        );

        return { componentName, ms: performance.now() - started, compiled: true };
      };

      const fullRebuildSnapshotFromFilesystem = (logLabel: string) => {
        const t0 = performance.now();
        const nextHierarchy = new Map<string, IComponentDependencies>();
        const nextVuePathMap = new Map<string, string>();
        filePathToComponentName.clear();

        let totalVueFiles = 0;
        let compiledCount = 0;

        for (const absDir of getSourceDirRoots()) {
          if (!fs.existsSync(absDir))
            continue;

          const vueFiles = walkFilesRecursive(absDir);
          totalVueFiles += vueFiles.length;

          for (const file of vueFiles) {
            const res = compileVueFileIntoSnapshot(file, nextHierarchy, nextVuePathMap);
            if (res.compiled)
              compiledCount++;
          }
        }

        snapshotHierarchy = nextHierarchy;
        snapshotVuePathMap = nextVuePathMap;

        const t1 = performance.now();
        logInfo(`scan(${logLabel}): found ${totalVueFiles} .vue files in ${getSourceDirs().join(", ")}`);
        logInfo(`compile(${logLabel}): ${compiledCount}/${totalVueFiles} files in ${formatMs(t1 - t0)} (components=${snapshotHierarchy.size})`);
      };

      const generateAggregatedFromSnapshot = async (logLabel: string) => {
        const t0 = performance.now();
        await generateFiles(snapshotHierarchy, snapshotVuePathMap, normalizedBasePagePath, {
          outDir,
          emitLanguages,
          typescriptOutputStructure,
          csharp,
          generateFixtures,
          customPomAttachments,
          projectRoot: projectRootRef.current,
          customPomDir,
          customPomImportAliases,
          customPomImportNameCollisionBehavior,
          pageDirs: getPageDirs(),
          componentDirs: getComponentDirs(),
          layoutDirs: getLayoutDirs(),
          testIdAttribute,
          vueRouterFluentChaining: routerAwarePoms,
          routerEntry: getResolvedRouterEntry(),
          routerType,
        });
        const t1 = performance.now();
        logInfo(`generate(${logLabel}): components=${snapshotHierarchy.size} in ${formatMs(t1 - t0)}`);
      };

      let timer: NodeJS.Timeout | null = null;
      let maxWaitTimer: NodeJS.Timeout | null = null;
      const pendingChangedVueFiles = new Set<string>();
      const pendingDeletedComponents = new Set<string>();
      let regenerationSequence: Promise<void> = Promise.resolve();

      const initialBuildPromise = (async () => {
        const t0 = performance.now();
        await routerInitPromise;
        fullRebuildSnapshotFromFilesystem("startup");
        await generateAggregatedFromSnapshot("startup");
        const t1 = performance.now();
        logInfo(`startup total: ${formatMs(t1 - t0)}`);
      })();

      const logGenerationError = (reason: string, message: string) => {
        server.config.logger.error(`[vue-pom-generator] dev generation failed during ${reason}: ${message}`);
      };

      const regenerateFromPending = async (reason: string) => {
        const t0 = performance.now();
        await initialBuildPromise;

        const nextHierarchy = new Map(snapshotHierarchy);
        const nextVuePathMap = new Map(snapshotVuePathMap);

        for (const componentName of pendingDeletedComponents) {
          nextHierarchy.delete(componentName);
          nextVuePathMap.delete(componentName);
        }

        const files = Array.from(pendingChangedVueFiles);
        const deletedCount = pendingDeletedComponents.size;
        pendingChangedVueFiles.clear();
        pendingDeletedComponents.clear();

        let compileMs = 0;
        for (const f of files) {
          const res = compileVueFileIntoSnapshot(f, nextHierarchy, nextVuePathMap);
          compileMs += res.ms;
        }

        snapshotHierarchy = nextHierarchy;
        snapshotVuePathMap = nextVuePathMap;

        const t1 = performance.now();
        await generateAggregatedFromSnapshot(reason);
        const t2 = performance.now();

        return {
          files,
          deletedCount,
          compileMs,
          preGenerateMs: t1 - t0,
          generateMs: t2 - t1,
          totalMs: t2 - t0,
        };
      };

      const enqueueRegeneration = (reason: string) => {
        const currentRun = regenerationSequence
          .catch(() => undefined)
          .then(() => regenerateFromPending(reason));
        regenerationSequence = currentRun.then(() => undefined, () => undefined);
        return currentRun;
      };

      const watchedVueGlobs = getSourceDirRoots().map(scanDirAbs => path.resolve(scanDirAbs, "**", "*.vue"));
      const watchedPluginGlob = path.resolve(projectRootRef.current, "vite-plugins", "vue-pom-generator", "**", "*.ts");
      const runtimeDir = path.dirname(basePageClassPath);
      server.watcher.add([
        ...watchedVueGlobs,
        watchedPluginGlob,
        basePageClassPath,
        path.resolve(runtimeDir, "pointer.ts"),
        path.resolve(runtimeDir, "callout.ts"),
        path.resolve(runtimeDir, "floating-ui-callout.ts"),
      ]);

      scheduleVueFileRegenLocal = (filePath: string, source: "hmr" | "fs") => {
        pendingChangedVueFiles.add(filePath);
        logDebug(`queued(${source}): files=${pendingChangedVueFiles.size} deleted=${pendingDeletedComponents.size}`);
        scheduleAggregatedRegen();
      };

      scheduleVueFileRegen = scheduleVueFileRegenLocal;

      function scheduleAggregatedRegen() {
        const wasEmpty = pendingChangedVueFiles.size === 0 && pendingDeletedComponents.size === 0;

        const MAX_WAIT_MS = 750;
        if (!maxWaitTimer) {
          maxWaitTimer = setTimeout(() => {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            maxWaitTimer = null;
            void enqueueRegeneration("max-wait")
              .then(({ files, deletedCount, compileMs, preGenerateMs, generateMs, totalMs }) => {
                logInfo(
                  `max-wait: files=${files.length} deleted=${deletedCount} `
                  + `compile=${formatMs(compileMs)} wall=${formatMs(preGenerateMs)} gen=${formatMs(generateMs)} total=${formatMs(totalMs)}`,
                );
              })
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                logGenerationError("max-wait", message);
              });
          }, MAX_WAIT_MS);
        }

        if (wasEmpty) {
          const queuedFiles = pendingChangedVueFiles.size;
          const queuedDeletes = pendingDeletedComponents.size;
          logDebug(`queued: files=${queuedFiles} deleted=${queuedDeletes}`);
        }

        if (timer)
          clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (maxWaitTimer) {
            clearTimeout(maxWaitTimer);
            maxWaitTimer = null;
          }

          const reason = pendingChangedVueFiles.size || pendingDeletedComponents.size ? "batched" : "noop";
          void enqueueRegeneration(reason)
            .then(({ files, deletedCount, compileMs, preGenerateMs, generateMs, totalMs }) => {
              if (files.length || deletedCount) {
                logInfo(
                  `batched: files=${files.length} deleted=${deletedCount} `
                  + `compile=${formatMs(compileMs)} wall=${formatMs(preGenerateMs)} gen=${formatMs(generateMs)} total=${formatMs(totalMs)}`,
                );
              }
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              logGenerationError(reason, message);
            });
        }, 75);
      }

      server.watcher.on("change", async (changedPath) => {
        const changedAbsPosix = path.posix.normalize(path.resolve(changedPath));

        // Ignore generated outputs to prevent infinite rebuild loops.
        const outDirAbsPosix = path.posix.normalize(path.resolve(projectRootRef.current, outDir ?? "./pom"));
        if (
          changedAbsPosix.startsWith(`${outDirAbsPosix}/`)
          && (changedAbsPosix.endsWith(".g.ts") || changedAbsPosix.endsWith(".g.ts.map"))
        ) {
          return;
        }

        if (changedAbsPosix.includes("/vite-plugins/vue-pom-generator/")) {
          void server.restart();
        }
      });

      server.watcher.on("add", (p) => {
        if (typeof p !== "string")
          return;
        if (!p.endsWith(".vue"))
          return;

        if (!isContainedInScanDirs(p))
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
        if (!p.endsWith(".vue"))
          return;

        if (!isContainedInScanDirs(p))
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

      await initialBuildPromise;
    },
  } satisfies PluginOption;
}
