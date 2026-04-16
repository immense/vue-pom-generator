import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { BindingMetadata } from "@vue/compiler-core";
import * as compilerDom from "@vue/compiler-dom";
import { compileScript, parse as parseSfc } from "@vue/compiler-sfc";
import type { PluginOption } from "vite";

import { generateFiles } from "../../class-generation";
import { introspectNuxtPages, parseRouterFileFromCwd } from "../../router-introspection";
import { createTestIdTransform } from "../../transform";
import type { IComponentDependencies, NativeWrappersMap, RouterIntrospectionResult } from "../../utils";
import { setResolveToComponentNameFn, setRouteNameToComponentNameMap, toPascalCase } from "../../utils";
import type { VuePomGeneratorLogger } from "../logger";
import { resolveComponentNameFromPath } from "../path-utils";
import type { PlaywrightOutputStructure, PomNameCollisionBehavior, RouterModuleShimDefinition } from "../types";

interface BuildProcessorOptions {
  componentHierarchyMap: Map<string, IComponentDependencies>;
  vueFilesPathMap: Map<string, string>;
  getPageDirs: () => string[];
  getComponentDirs: () => string[];
  getLayoutDirs: () => string[];
  getViewsDir: () => string;
  getSourceDirs: () => string[];

  basePageClassPath: string;
  normalizedBasePagePath: string;

  outDir?: string;
  emitLanguages?: Array<"ts" | "csharp">;
  typescriptOutputStructure?: PlaywrightOutputStructure;
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

  /** How to handle POM member-name collisions. */
  nameCollisionBehavior?: PomNameCollisionBehavior;
  missingSemanticNameBehavior?: "ignore" | "error";
  /** How to handle existing data-testid attributes. */
  existingIdBehavior?: "preserve" | "overwrite" | "error";
  /** Native wrapper component config. */
  nativeWrappers: NativeWrappersMap;
  /** Components excluded from test-id injection. */
  excludedComponents: string[];
  /** Getter for resolved wrapper search root directories. */
  getWrapperSearchRoots: () => string[];

  routerAwarePoms: boolean;
  getResolvedRouterEntry: () => string | undefined;
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
    getPageDirs,
    getComponentDirs,
    getLayoutDirs,
    getViewsDir,
    getSourceDirs,
    basePageClassPath,
    normalizedBasePagePath,
    outDir,
    emitLanguages,
    typescriptOutputStructure,
    csharp,
    generateFixtures,
    customPomAttachments,
    projectRootRef,
    customPomDir,
    customPomImportAliases,
    customPomImportNameCollisionBehavior,
    testIdAttribute,
    nameCollisionBehavior,
    missingSemanticNameBehavior,
    existingIdBehavior,
    nativeWrappers,
    excludedComponents,
    getWrapperSearchRoots,
    routerAwarePoms,
    getResolvedRouterEntry,
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

  const getViewsDirAbs = () =>
    path.isAbsolute(getViewsDir()) ? getViewsDir() : path.resolve(projectRootRef.current, getViewsDir());
  const getPageDirsAbs = () => getPageDirs().map(dir => path.isAbsolute(dir) ? dir : path.resolve(projectRootRef.current, dir));

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

  /**
   * Walk configured source directories and compile any .vue files not already in the hierarchy map.
   * This ensures build output includes all configured pages/components/layouts, matching the
   * dev-server behavior (which does its own filesystem walk).
   */
  const supplementHierarchyFromFilesystem = () => {
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

    let supplemented = 0;
    for (const dir of getSourceDirs()) {
      const absDir = path.resolve(projectRootRef.current, dir);
      if (!fs.existsSync(absDir))
        continue;

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

        let sfc = "";
        try {
          sfc = fs.readFileSync(absolutePath, "utf8");
        }
        catch {
          continue;
        }

        const { descriptor } = parseSfc(sfc, { filename: absolutePath });
        const template = descriptor.template?.content ?? "";
        if (!template.trim()) {
          // Even template-less components get an entry so they appear in the
          // generated output (matching the dev-server filesystem walk).
          vueFilesPathMap.set(componentName, absolutePath);
          componentHierarchyMap.set(componentName, {
            filePath: absolutePath,
            childrenComponentSet: new Set(),
            usedComponentSet: new Set(),
            dataTestIdSet: new Set(),
            isView: false,
            methodsContent: "",
          });
          supplemented++;
          continue;
        }

        const { bindings: bindingMetadata, isScriptSetup } = getScriptInfo(sfc, absolutePath);
        vueFilesPathMap.set(componentName, absolutePath);

        try {
          compilerDom.compile(template, {
            filename: absolutePath,
            prefixIdentifiers: true,
            inline: isScriptSetup,
            bindingMetadata,
            nodeTransforms: [
              createTestIdTransform(
                componentName,
                componentHierarchyMap,
                nativeWrappers,
                excludedComponents,
                getViewsDirAbs(),
                {
                  existingIdBehavior: existingIdBehavior ?? "preserve",
                  testIdAttribute,
                  nameCollisionBehavior,
                  missingSemanticNameBehavior,
                  warn: (message: string) => loggerRef.current.warn(message),
                  vueFilesPathMap,
                  wrapperSearchRoots: getWrapperSearchRoots(),
                },
              ),
            ],
          });
        }
        catch {
          // Compilation failures are not fatal; omit the component from POM output.
        }

        supplemented++;
      }
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
    },
    async buildEnd(error) {
      if (error) {
        return;
      }

      // Supplement the hierarchy with any .vue files in configured source dirs that were not
      // part of the Vite build graph (e.g. unused components, dynamic-only imports).
      supplementHierarchyFromFilesystem();

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
        typescriptOutputStructure,
        csharp,
        generateFixtures,
        customPomAttachments,
        projectRoot: projectRootRef.current,
        customPomDir,
        customPomImportAliases,
        customPomImportNameCollisionBehavior,
        testIdAttribute,
        vueRouterFluentChaining: routerAwarePoms,
        routerEntry: getResolvedRouterEntry(),
        routerType,
        pageDirs: getPageDirs(),
        componentDirs: getComponentDirs(),
        layoutDirs: getLayoutDirs(),
      });
      lastGeneratedMetrics = metrics;
      loggerRef.current.info(`generated POMs (${metrics.entryCount} entries, ${metrics.interactiveComponentCount} interactive components, ${metrics.dataTestIdCount} selectors)`);
    },
    closeBundle() {
      loggerRef.current.info("build complete");
    },
  } satisfies PluginOption;
}
