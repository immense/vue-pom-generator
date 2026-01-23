import fs from "node:fs";

import type { PluginOption } from "vite";

import { generateFiles } from "../../class-generation";
import { parseRouterFileFromCwd } from "../../router-introspection";
import { setResolveToComponentNameFn, setRouteNameToComponentNameMap, toPascalCase } from "../../utils";
import type { IComponentDependencies } from "../../utils";
import type { VuePomGeneratorLogger } from "../logger";

interface BuildProcessorOptions {
  componentHierarchyMap: Map<string, IComponentDependencies>;
  vueFilesPathMap: Map<string, string>;

  basePageClassPath: string;
  normalizedBasePagePath: string;

  outDir?: string;
  generateFixtures?: boolean | string | { outDir?: string };
  customPomAttachments?: Array<{ className: string; propertyName: string; attachWhenUsesComponents: string[]; attachTo?: "views" | "components" | "both" }>;
  projectRootRef: { current: string };
  customPomDir?: string;
  customPomImportAliases?: Record<string, string>;
  testIdAttribute: string;

  routerAwarePoms: boolean;
  resolvedRouterEntry?: string;

  loggerRef: { current: VuePomGeneratorLogger };
}

export function createBuildProcessorPlugin(options: BuildProcessorOptions): PluginOption {
  const {
    componentHierarchyMap,
    vueFilesPathMap,
    basePageClassPath,
    normalizedBasePagePath,
    outDir,
    generateFixtures,
    customPomAttachments,
    projectRootRef,
    customPomDir,
    customPomImportAliases,
    testIdAttribute,
    routerAwarePoms,
    resolvedRouterEntry,
    loggerRef,
  } = options;

  // Vite (v6/v7) may run multiple build environments/passes (e.g. SSR + client) in a single invocation.
  // Some passes can execute without compiling any Vue SFC templates that reach our transform, leaving
  // `componentHierarchyMap` empty. If we blindly generate on that pass, we can overwrite a previously
  // correct aggregated output (e.g. `tests/playwright/generated/page-object-models.g.ts`) with an incomplete file.
  //
  // Guard generation so we only write when we have meaningful data, and prefer the "largest" pass.
  let lastGeneratedEntryCount = 0;

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
        projectRoot: projectRootRef.current,
        customPomDir,
        customPomImportAliases,
        testIdAttribute,
        vueRouterFluentChaining: routerAwarePoms,
        routerEntry: resolvedRouterEntry,
      });
      lastGeneratedEntryCount = entryCount;
      loggerRef.current.info(`generated POMs (${entryCount} entries)`);
    },
    closeBundle() {
      loggerRef.current.info("build complete");
    },
  } satisfies PluginOption;
}
