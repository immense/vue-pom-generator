import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import * as compilerDom from "@vue/compiler-dom";
import { parse as parseSfc } from "@vue/compiler-sfc";
import type { PluginOption, ViteDevServer } from "vite";

import { generateFiles } from "../../class-generation";
import { parseRouterFileFromCwd } from "../../router-introspection";
import { createTestIdTransform } from "../../transform";
import { setResolveToComponentNameFn, setRouteNameToComponentNameMap, toPascalCase } from "../../utils";
import type { IComponentDependencies, NativeWrappersMap } from "../../utils";

interface DevProcessorOptions {
  nativeWrappers: NativeWrappersMap;
  excludedComponents: string[];
  viewsDir: string;

  projectRoot: string;
  normalizedBasePagePath: string;
  basePageClassPath: string;

  outDir?: string;
  generateFixtures?: boolean | string | { outDir?: string };
  customPomAttachments?: Array<{ className: string; propertyName: string; attachWhenUsesComponents: string[]; attachTo?: "views" | "components" | "both" }>;
  customPomDir?: string;
  customPomImportAliases?: Record<string, string>;
  testIdAttribute: string;

  vueRouterFluentChaining: boolean;
  resolvedRouterEntry?: string;
}

export function createDevProcessorPlugin(options: DevProcessorOptions): PluginOption {
  const {
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
  } = options;

  // Bridge between configureServer (where we have timers/logger) and handleHotUpdate.
  let scheduleVueFileRegen: ((filePath: string, source: "hmr" | "fs") => void) | null = null;

  return {
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
      // Router introspection (dev-server): mirror the buildStart behavior.
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

      const logger = server.config.logger;
      const log = (message: string) => {
        logger.info(`[vue-testid] ${message}`);
      };

      let scheduleVueFileRegenLocal: ((filePath: string, source: "hmr" | "fs") => void) | null = null;

      const formatMs = (ms: number) => `${ms.toFixed(1)}ms`;

      const extractTemplateFromSfc = (source: string, filename?: string): string => {
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

      const initialBuildPromise = (async () => {
        const t0 = performance.now();
        await routerInitPromise;
        fullRebuildSnapshotFromFilesystem();
        generateAggregatedFromSnapshot("startup");
        const t1 = performance.now();
        log(`startup total: ${formatMs(t1 - t0)}`);
      })();

      const watchedVueGlob = path.resolve(projectRoot, "src", "**", "*.vue");
      const watchedPluginGlob = path.resolve(projectRoot, "vite-plugins", "vue-pom-generator", "**", "*.ts");
      server.watcher.add([watchedVueGlob, watchedPluginGlob, basePageClassPath]);

      let timer: NodeJS.Timeout | null = null;
      let maxWaitTimer: NodeJS.Timeout | null = null;
      const pendingChangedVueFiles = new Set<string>();
      const pendingDeletedComponents = new Set<string>();

      scheduleVueFileRegenLocal = (filePath: string, source: "hmr" | "fs") => {
        pendingChangedVueFiles.add(filePath);
        log(`queued(${source}): files=${pendingChangedVueFiles.size} deleted=${pendingDeletedComponents.size}`);
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
            void (async () => {
              const t0 = performance.now();
              await initialBuildPromise;

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
        if (changed.includes("/pom/") && (changed.endsWith("index.g.ts") || changed.endsWith("index.g.ts.map")))
          return;

        if (changed.includes("/vite-plugins/vue-pom-generator/")) {
          void server.restart();
        }
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
  } satisfies PluginOption;
}
