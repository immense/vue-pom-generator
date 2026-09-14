import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { PluginOption } from "vite";

import { generateFiles } from "../../class-generation";
import type { ElementMetadata } from "../../metadata-collector";
import { introspectNuxtPages, parseRouterFileFromCwd } from "../../router-introspection";
import type { IComponentDependencies, RouterIntrospectionResult } from "../../utils";
import { setResolveToComponentNameFn, setRouteNameToComponentNameMap, toPascalCase } from "../../utils";
import type { VuePomGeneratorLogger } from "../logger";
import { resolveComponentNameFromPath } from "../path-utils";
import type { ResolvedGenerationSupportOptions } from "../resolved-generation-options";

interface BuildProcessorOptions {
  componentHierarchyMap: Map<string, IComponentDependencies>;
  elementMetadata: Map<string, Map<string, ElementMetadata>>;
  vueFilesPathMap: Map<string, string>;
  getPageDirs: () => string[];
  getComponentDirs: () => string[];
  getLayoutDirs: () => string[];
  getViewsDir: () => string;
  getSourceDirs: () => string[];

  basePageClassPath: string;
  normalizedBasePagePath: string;
  generation: ResolvedGenerationSupportOptions;
  projectRootRef: { current: string };
  collectSource: (code: string, filename: string) => Promise<void>;
  generationOnly: boolean;
  getResolvedRouterEntry: () => string | undefined;

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
    elementMetadata,
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
    collectSource,
    generationOnly,
    getResolvedRouterEntry,
    loggerRef,
  } = options;
  const {
    outDir,
    emitLanguages,
    typescriptOutputStructure,
    csharp,
    generateFixtures,
    vueTestUtilsOutDir,
    customPomAttachments,
    customPomDir,
    requireCustomPomDir,
    customPomImportAliases,
    customPomImportNameCollisionBehavior,
    testIdAttribute,
    routerAwarePoms,
    routerType,
    routerModuleShims,
  } = generation;

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

  const getViewsDirAbs = () =>
    path.isAbsolute(getViewsDir()) ? getViewsDir() : path.resolve(projectRootRef.current, getViewsDir());
  const getPageDirsAbs = () => getPageDirs().map(dir => path.isAbsolute(dir) ? dir : path.resolve(projectRootRef.current, dir));

  /**
   * Walk configured source directories and compile any .vue files not already in the hierarchy map.
   * This ensures build output includes all configured pages/components/layouts, matching the
   * dev-server behavior (which does its own filesystem walk).
   */
  const supplementHierarchyFromFilesystem = async () => {
    const walkFilesRecursive = (rootDir: string): string[] => {
      const out: string[] = [];
      const stack: string[] = [rootDir];
      while (stack.length) {
        const dir = stack.pop();
        if (!dir) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
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

    let supplemented = 0;
    let sourceDirectories = 0;
    for (const dir of getSourceDirs()) {
      const absDir = path.resolve(projectRootRef.current, dir);
      if (!fs.existsSync(absDir))
        continue;
      sourceDirectories++;

      for (const filePath of walkFilesRecursive(absDir)) {
        const absolutePath = path.resolve(filePath);
        const componentName = resolveComponentNameFromPath({
          filename: absolutePath,
          projectRoot: projectRootRef.current,
          viewsDirAbs: getViewsDirAbs(),
          sourceDirs: getSourceDirs(),
          extraRoots: [process.cwd()],
        });

        // Skip components already processed by the build transform pipeline.
        if (componentHierarchyMap.has(componentName))
          continue;

        await collectSource(fs.readFileSync(absolutePath, "utf8"), absolutePath);

        supplemented++;
      }
    }

    if (generationOnly && sourceDirectories === 0) {
      throw new Error("[vue-pom-generator] No configured source directories exist. Check the Vite root and injection directories.");
    }

    if (supplemented > 0) {
      loggerRef.current.info(`supplemented ${supplemented} components from filesystem walk (not in build graph)`);
    }
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
        this.error(`Base page runtime file not found at ${basePageClassPath}. Ensure it is included in the build.`);
      }
      this.addWatchFile(basePageClassPath);

      const pointerPath = path.resolve(path.dirname(basePageClassPath), "pointer.ts");
      if (!fs.existsSync(pointerPath)) {
        this.error(`pointer.ts not found at ${pointerPath}. Ensure it is included in the build.`);
      }
      this.addWatchFile(pointerPath);

      const calloutPath = path.resolve(path.dirname(basePageClassPath), "callout.ts");
      if (!fs.existsSync(calloutPath)) {
        this.error(`callout.ts not found at ${calloutPath}. Ensure it is included in the build.`);
      }
      this.addWatchFile(calloutPath);

      const floatingUiCalloutPath = path.resolve(path.dirname(basePageClassPath), "floating-ui-callout.ts");
      if (fs.existsSync(floatingUiCalloutPath)) {
        this.addWatchFile(floatingUiCalloutPath);
      }
    },
    async buildEnd(error) {
      if (error) {
        return;
      }

      // Supplement the hierarchy with any .vue files in configured source dirs that were not
      // part of the Vite build graph (e.g. unused components, dynamic-only imports).
      await supplementHierarchyFromFilesystem();

      const metrics = summarizeHierarchyMap(componentHierarchyMap);
      if (!generationOnly && metrics.dataTestIdCount <= 0) {
        // Skip generation rather than overwriting an existing aggregated file with selector-less output.
        return;
      }

      if (!generationOnly && isLessRich(metrics, lastGeneratedMetrics)) {
        // If we already generated from a richer pass, do not clobber it with a smaller/partial pass.
        return;
      }

      await generateFiles(componentHierarchyMap, vueFilesPathMap, normalizedBasePagePath, {
        outDir,
        emitLanguages,
        typescriptOutputStructure,
        csharp,
        generateFixtures,
        vueTestUtilsOutDir,
        customPomAttachments,
        projectRoot: projectRootRef.current,
        customPomDir,
        requireCustomPomDir,
        customPomImportAliases,
        customPomImportNameCollisionBehavior,
        testIdAttribute,
        vueRouterFluentChaining: routerAwarePoms,
        routerEntry: getResolvedRouterEntry(),
        routerType,
        pageDirs: getPageDirs(),
        componentDirs: getComponentDirs(),
        layoutDirs: getLayoutDirs(),
        elementMetadata,
      });
      lastGeneratedMetrics = metrics;
      loggerRef.current.info(`generated POMs (${metrics.entryCount} entries, ${metrics.interactiveComponentCount} interactive components, ${metrics.dataTestIdCount} selectors)`);
    },
    closeBundle() {
      loggerRef.current.info("build complete");
    },
  } satisfies PluginOption;
}
