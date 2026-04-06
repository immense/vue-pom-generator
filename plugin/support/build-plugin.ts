import fs from "node:fs";
import path from "node:path";

import type { PluginOption } from "vite";

import { generateFiles } from "../../class-generation";
import { introspectNuxtPages, parseRouterFileFromCwd } from "../../router-introspection";
import type { IComponentDependencies, RouterIntrospectionResult } from "../../utils";
import { setResolveToComponentNameFn, setRouteNameToComponentNameMap, toPascalCase } from "../../utils";
import type { VuePomGeneratorLogger } from "../logger";
import type { RouterModuleShimDefinition } from "../types";

interface BuildProcessorOptions {
  componentHierarchyMap: Map<string, IComponentDependencies>;
  vueFilesPathMap: Map<string, string>;
  viewsDir: string;
  scanDirs: string[];

  basePageClassPath: string;
  normalizedBasePagePath: string;

  outDir?: string;
  emitLanguages?: Array<"ts" | "csharp">;
  csharp?: {
    namespace?: string;
  };
  generateFixtures?: boolean | string | { outDir?: string };
  customPomAttachments?: Array<{ className: string; propertyName: string; attachWhenUsesComponents: string[]; attachTo?: "views" | "components" | "both" | "pagesAndComponents"; flatten?: boolean }>;
  projectRootRef: { current: string };
  customPomDir?: string;
  customPomImportAliases?: Record<string, string>;
  customPomImportNameCollisionBehavior?: "error" | "alias";
  testIdAttribute: string;

  routerAwarePoms: boolean;
  resolvedRouterEntry?: string;
  routerType?: "vue-router" | "nuxt";
  routerModuleShims?: Record<string, RouterModuleShimDefinition>;

  loggerRef: { current: VuePomGeneratorLogger };
}

interface HierarchyGenerationMetrics {
  entryCount: number;
  interactiveComponentCount: number;
  dataTestIdCount: number;
}

function summarizeHierarchyMap(componentHierarchyMap: Map<string, IComponentDependencies>): HierarchyGenerationMetrics {
  let interactiveComponentCount = 0;
  let dataTestIdCount = 0;

  for (const dependencies of componentHierarchyMap.values()) {
    const selectorCount = dependencies.dataTestIdSet?.size ?? 0;
    if (selectorCount > 0) {
      interactiveComponentCount += 1;
      dataTestIdCount += selectorCount;
    }
  }

  return {
    entryCount: componentHierarchyMap.size,
    interactiveComponentCount,
    dataTestIdCount,
  };
}

function isLessRich(candidate: HierarchyGenerationMetrics, previous: HierarchyGenerationMetrics): boolean {
  if (candidate.dataTestIdCount !== previous.dataTestIdCount) {
    return candidate.dataTestIdCount < previous.dataTestIdCount;
  }

  if (candidate.interactiveComponentCount !== previous.interactiveComponentCount) {
    return candidate.interactiveComponentCount < previous.interactiveComponentCount;
  }

  return candidate.entryCount < previous.entryCount;
}

export function createBuildProcessorPlugin(options: BuildProcessorOptions): PluginOption {
  const {
    componentHierarchyMap,
    vueFilesPathMap,
    viewsDir,
    scanDirs,
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
    routerAwarePoms,
    resolvedRouterEntry,
    routerType,
    routerModuleShims,
    loggerRef,
  } = options;

  // Vite (v6/v7) may run multiple build environments/passes (e.g. SSR + client) in a single invocation.
  // Some passes can execute without compiling any Vue SFC templates that reach our transform, leaving
  // `componentHierarchyMap` empty. If we blindly generate on that pass, we can overwrite a previously
  // correct aggregated output (e.g. `tests/playwright/generated/page-object-models.g.ts`) with an incomplete file.
  //
  // Guard generation so we only write when we have meaningful data, and prefer the "largest" pass.
  let lastGeneratedMetrics: HierarchyGenerationMetrics = {
    entryCount: 0,
    interactiveComponentCount: 0,
    dataTestIdCount: 0,
  };

  return {
    name: "vue-pom-generator-build",
    // This plugin exists to generate code on build output; it is not needed during dev-server HMR.
    apply: "build",
    enforce: "pre",
    async buildStart() {
      // Router introspection: build a route-name -> component-name map once per build.
      // This enables `:to`-based methods to return `new <TargetPage>(page)`.
      if (!routerAwarePoms) {
        setRouteNameToComponentNameMap(new Map());
        setResolveToComponentNameFn(() => null);
        return;
      }

      let result: RouterIntrospectionResult;

      if (routerType === "nuxt") {
        result = await introspectNuxtPages(projectRootRef.current);
      }
      else {
        if (!resolvedRouterEntry)
          throw new Error("[vue-pom-generator] router.entry is required when router introspection is enabled.");
        result = await parseRouterFileFromCwd(resolvedRouterEntry, {
          moduleShims: routerModuleShims,
          componentNaming: {
            projectRoot: projectRootRef.current,
            viewsDirAbs: path.isAbsolute(viewsDir) ? viewsDir : path.resolve(projectRootRef.current, viewsDir),
            scanDirs,
          },
        });
      }

      const { routeNameMap, routePathMap } = result;
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

      const pointerPath = path.resolve(path.dirname(basePageClassPath), "Pointer.ts");
      if (!fs.existsSync(pointerPath)) {
        this.error(`Pointer.ts not found at ${pointerPath}. Ensure it is included in the build.`);
      }
      this.addWatchFile(pointerPath);
    },
    async buildEnd(error) {
      if (error) {
        return;
      }

      const metrics = summarizeHierarchyMap(componentHierarchyMap);
      if (metrics.dataTestIdCount <= 0) {
        // Skip generation rather than overwriting an existing aggregated file with selector-less output.
        return;
      }

      if (isLessRich(metrics, lastGeneratedMetrics)) {
        // If we already generated from a richer pass, do not clobber it with a smaller/partial pass.
        return;
      }

      await generateFiles(componentHierarchyMap, vueFilesPathMap, normalizedBasePagePath, {
        outDir,
        emitLanguages,
        csharp,
        generateFixtures,
        customPomAttachments,
        projectRoot: projectRootRef.current,
        customPomDir,
        customPomImportAliases,
        customPomImportNameCollisionBehavior,
        testIdAttribute,
        vueRouterFluentChaining: routerAwarePoms,
        routerEntry: resolvedRouterEntry,
        routerType,
        viewsDir,
        scanDirs,
      });
      lastGeneratedMetrics = metrics;
      loggerRef.current.info(`generated POMs (${metrics.entryCount} entries, ${metrics.interactiveComponentCount} interactive components, ${metrics.dataTestIdCount} selectors)`);
    },
    closeBundle() {
      loggerRef.current.info("build complete");
    },
  } satisfies PluginOption;
}
