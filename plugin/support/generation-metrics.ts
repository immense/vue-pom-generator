import path from "node:path";

import type { IComponentDependencies } from "../../utils";

export interface GenerationMetrics {
  entryCount: number;
  selectorCount: number;
  generatedMethodCount: number;
}

export function getGenerationMetrics(componentHierarchyMap: Map<string, IComponentDependencies>): GenerationMetrics {
  let selectorCount = 0;
  let generatedMethodCount = 0;

  for (const deps of componentHierarchyMap.values()) {
    selectorCount += deps.dataTestIdSet?.size ?? 0;
    generatedMethodCount += deps.generatedMethods?.size ?? 0;
  }

  return {
    entryCount: componentHierarchyMap.size,
    selectorCount,
    generatedMethodCount,
  };
}

export function isLessRich(current: GenerationMetrics, previous: GenerationMetrics): boolean {
  if (current.entryCount !== previous.entryCount) {
    return current.entryCount < previous.entryCount;
  }

  if (current.selectorCount !== previous.selectorCount) {
    return current.selectorCount < previous.selectorCount;
  }

  return current.generatedMethodCount < previous.generatedMethodCount;
}

export function getGenerationMetricsKey(projectRoot: string, outDir?: string): string {
  return path.resolve(projectRoot, outDir ?? "./pom");
}
