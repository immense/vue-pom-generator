import path from "node:path";

import type { NativeWrappersMap } from "../utils";
import type { NuxtResolvedDiscovery } from "./nuxt-discovery";
import type { ExistingIdBehavior } from "./types";

export interface ResolvedInjectionSupportOptions {
  pageDirs: string[];
  componentDirs: string[];
  layoutDirs: string[];
  wrapperSearchRoots: string[];
  nativeWrappers: NativeWrappersMap;
  excludedComponents: string[];
  existingIdBehavior: ExistingIdBehavior;
  testIdAttribute: string;
}

export interface ResolveInjectionSupportOptionsInput {
  isNuxt?: boolean;
  viewsDir?: string;
  componentDirs?: string[];
  layoutDirs?: string[];
  wrapperSearchRoots?: string[];
  nativeWrappers?: NativeWrappersMap;
  excludedComponents?: string[];
  existingIdBehavior?: ExistingIdBehavior;
  testIdAttribute?: string;
}

export function resolveInjectionSupportOptions(
  options: ResolveInjectionSupportOptionsInput,
): ResolvedInjectionSupportOptions {
  const isNuxt = options.isNuxt ?? false;

  return {
    pageDirs: isNuxt ? ["app/pages"] : [options.viewsDir ?? "src/views"],
    componentDirs: isNuxt ? ["app/components"] : (options.componentDirs ?? ["src/components"]),
    layoutDirs: isNuxt ? ["app/layouts"] : (options.layoutDirs ?? ["src/layouts"]),
    wrapperSearchRoots: isNuxt ? [] : (options.wrapperSearchRoots ?? []),
    nativeWrappers: options.nativeWrappers ?? {},
    excludedComponents: options.excludedComponents ?? [],
    existingIdBehavior: options.existingIdBehavior ?? "error",
    testIdAttribute: (options.testIdAttribute ?? "data-testid").trim() || "data-testid",
  };
}

export function applyNuxtDiscoveryToInjectionOptions(
  options: ResolvedInjectionSupportOptions,
  discovery: NuxtResolvedDiscovery,
): ResolvedInjectionSupportOptions {
  return {
    ...options,
    pageDirs: discovery.pageDirs.length
      ? discovery.pageDirs
      : [path.resolve(discovery.srcDir, "pages")],
    componentDirs: discovery.componentDirs,
    layoutDirs: discovery.layoutDirs,
    wrapperSearchRoots: discovery.wrapperSearchRoots,
  };
}
