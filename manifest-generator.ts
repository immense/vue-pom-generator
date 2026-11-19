/**
 * Test ID manifest generator utilities
 * Generates TypeScript types and manifests from collected test IDs
 */

import path from "node:path";
import type { AccessibilityAuditResult } from "./accessibility-audit";
import { buildAccessibilityAudit } from "./accessibility-audit";
import type { ElementMetadata } from "./metadata-collector";
import { safeRealpath, toPosixSlashes } from "./plugin/path-utils";
import type { RouterIntrospectionResult } from "./router-introspection";
import { buildPomLocatorDescription, humanizePomMethodName } from "./pom-discoverability";
import type { PomParameterSpec } from "./pom-params";
import type { IComponentDependencies, IDataTestId, PomExtraClickMethodSpec, PomPrimarySpec } from "./utils";
import { buildPomGeneratedActionName, buildPomGeneratedPropertyName, toPascalCase } from "./utils";
import { renderSourceFile, renderStructuredSourceFile, StructureKind, VariableDeclarationKind, type TypeScriptRenderCache, type WriterFunction } from "./typescript-codegen";

export type PomManifestEntry = {
  testId: string;
  selectorPatternKind: "static" | "parameterized";
  semanticName: string;
  locatorDescription: string;
  inferredRole: string | null;
  accessibility?: AccessibilityAuditResult;
  generatedPropertyName: string | null;
  generatedActionName: string | null;
  generatedActionNames: string[];
  generatedMethods: Array<{
    name: string;
    kind: "action" | "locator";
    parameters: PomParameterSpec[];
  }>;
  emitPrimary: boolean;
  targetPageObjectModelClass?: string;
  sourceTag?: string;
  sourceTagType?: number;
  sourceLine?: number;
  sourceColumn?: number;
  patchFlag?: number;
  dynamicProps?: string[];
  hasClickHandler?: boolean;
  hasDynamicClass?: boolean;
  hasDynamicStyle?: boolean;
  hasDynamicText?: boolean;
};

export type PomManifestComponent = {
  componentName: string;
  className: string;
  sourceFile: string;
  kind: "component" | "view";
  testIds: string[];
  entries: PomManifestEntry[];
};

export type PomManifest = Record<string, PomManifestComponent>;

function matchesPrimarySelector(extraMethod: PomExtraClickMethodSpec, pom: PomPrimarySpec): boolean {
  if (extraMethod.selector.kind !== "testId") {
    return false;
  }

  return extraMethod.selector.testId.formatted === pom.selector.formatted
    && extraMethod.selector.testId.patternKind === pom.selector.patternKind;
}

function getManifestEntry(
  componentName: string,
  entry: IDataTestId,
  componentMetadata: Map<string, ElementMetadata> | undefined,
  extraMethods: readonly PomExtraClickMethodSpec[],
): PomManifestEntry {
  const testId = entry.selectorValue.formatted;
  const metadata = componentMetadata?.get(testId);
  const pom = entry.pom;
  const generatedActionName = pom ? buildPomGeneratedActionName(pom) : null;
  const extraActionNames = pom
    ? extraMethods
      .filter(extraMethod => matchesPrimarySelector(extraMethod, pom))
      .map(extraMethod => extraMethod.name)
      .sort((a, b) => a.localeCompare(b))
    : [];

  const generatedActionNames = Array.from(new Set([
    ...(generatedActionName ? [generatedActionName] : []),
    ...extraActionNames.filter(name => name !== generatedActionName),
  ]));
  const generatedMethods = [
    ...(pom && generatedActionName
      ? [{ name: generatedActionName, kind: "action" as const, parameters: pom.parameters }]
      : []),
    ...(pom
      ? extraMethods
        .filter(extraMethod => matchesPrimarySelector(extraMethod, pom))
        .map(extraMethod => ({ name: extraMethod.name, kind: "action" as const, parameters: extraMethod.parameters }))
      : []),
    ...(pom
      ? [{ name: buildPomGeneratedPropertyName(pom), kind: "locator" as const, parameters: pom.parameters }]
      : []),
  ].filter((method, index, methods) => methods.findIndex(candidate => candidate.name === method.name && candidate.kind === method.kind) === index);
  const accessibility = buildAccessibilityAudit(metadata, pom?.nativeRole ?? null);

  return {
    testId,
    selectorPatternKind: entry.selectorValue.patternKind,
    semanticName: metadata?.semanticName ?? (pom ? humanizePomMethodName(pom.methodName) : testId),
    locatorDescription: pom
      ? buildPomLocatorDescription({
        componentName,
        methodName: pom.methodName,
        nativeRole: pom.nativeRole,
      })
      : componentName,
    inferredRole: pom?.nativeRole ?? null,
    ...(accessibility ? { accessibility } : {}),
    generatedPropertyName: pom ? buildPomGeneratedPropertyName(pom) : null,
    generatedActionName,
    generatedActionNames,
    generatedMethods,
    emitPrimary: pom?.emitPrimary !== false,
    ...(entry.targetPageObjectModelClass ? { targetPageObjectModelClass: entry.targetPageObjectModelClass } : {}),
    ...(metadata?.tag ? { sourceTag: metadata.tag } : {}),
    ...(metadata ? { sourceTagType: metadata.tagType } : {}),
    ...(metadata?.sourceLine !== undefined ? { sourceLine: metadata.sourceLine } : {}),
    ...(metadata?.sourceColumn !== undefined ? { sourceColumn: metadata.sourceColumn } : {}),
    ...(metadata?.patchFlag !== undefined ? { patchFlag: metadata.patchFlag } : {}),
    ...(metadata?.dynamicProps?.length ? { dynamicProps: metadata.dynamicProps } : {}),
    ...(metadata?.hasClickHandler !== undefined ? { hasClickHandler: metadata.hasClickHandler } : {}),
    ...(metadata?.hasDynamicClass !== undefined ? { hasDynamicClass: metadata.hasDynamicClass } : {}),
    ...(metadata?.hasDynamicStyle !== undefined ? { hasDynamicStyle: metadata.hasDynamicStyle } : {}),
    ...(metadata?.hasDynamicText !== undefined ? { hasDynamicText: metadata.hasDynamicText } : {}),
  };
}

export function buildPomManifest(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
): PomManifest {
  const manifestEntries = Array.from(componentHierarchyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([componentName, dependencies]) => {
      const entries = Array.from(dependencies.dataTestIdSet)
        .sort((a, b) => a.selectorValue.formatted.localeCompare(b.selectorValue.formatted))
        .map(entry => getManifestEntry(componentName, entry, elementMetadata.get(componentName), dependencies.pomExtraMethods ?? []));

      if (!entries.length) {
        return null;
      }

      return [componentName, {
        componentName,
        className: componentName,
        sourceFile: dependencies.filePath,
        kind: dependencies.isView ? "view" : "component",
        testIds: Array.from(new Set(entries.map(entry => entry.testId))),
        entries,
      } satisfies PomManifestComponent] as const;
    })
    .filter((entry): entry is readonly [string, PomManifestComponent] => entry !== null);

  return Object.fromEntries(manifestEntries);
}

export function normalizeTrackedComponentRef(value: string): string {
  return value.endsWith(".vue") ? value.slice(0, -4) : value;
}

/** Resolves a template component reference to its key in the hierarchy, by name or unique file basename. */
export function resolveTrackedComponentRef(value: string, componentHierarchyMap: Map<string, IComponentDependencies>): string | null {
  const normalizedValue = normalizeTrackedComponentRef(value);
  if (componentHierarchyMap.has(value)) {
    return value;
  }
  if (componentHierarchyMap.has(normalizedValue)) {
    return normalizedValue;
  }

  let match: string | null = null;
  for (const [candidateName, candidateDeps] of componentHierarchyMap.entries()) {
    const normalizedCandidate = normalizeTrackedComponentRef(candidateName);
    const candidateBaseName = path.parse(candidateDeps.filePath).name;
    if (normalizedCandidate !== normalizedValue && candidateBaseName !== normalizedValue) {
      continue;
    }
    if (match && match !== candidateName) {
      return null;
    }
    match = candidateName;
  }
  return match;
}

export interface ComponentGraph {
  version: 1;
  /** Keyed by source file relative to the project root. */
  components: Record<string, { name: string; uses: string[] }>;
  routes: Array<{ path: string; name: string | null; components: string[] }>;
}

function buildComponentGraph(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  routeMetaEntries: RouterIntrospectionResult["routeMetaEntries"],
  projectRoot: string,
): ComponentGraph {
  const rootAbs = safeRealpath(path.resolve(projectRoot));
  const toProjectPath = (filePath: string) => toPosixSlashes(path.relative(rootAbs, safeRealpath(path.resolve(rootAbs, filePath))));
  const sortedUnique = (values: string[]) => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));

  const components = Array.from(componentHierarchyMap.entries(), ([name, dependencies]) => [toProjectPath(dependencies.filePath), {
    name,
    // Templates may use kebab-case tags; tags that are not project components (built-ins, libraries) drop out.
    uses: sortedUnique(Array.from(dependencies.usedComponentSet).flatMap((tag) => {
      const ref = resolveTrackedComponentRef(toPascalCase(tag), componentHierarchyMap);
      const used = ref ? componentHierarchyMap.get(ref) : undefined;
      return used ? [toProjectPath(used.filePath)] : [];
    })),
  }] as const).sort(([a], [b]) => a.localeCompare(b));

  const routes = routeMetaEntries.map((route) => {
    if (!route.componentFiles) {
      throw new Error(`[vue-pom-generator] Route "${route.path}" was introspected without its component files.`);
    }
    return { path: route.path, name: route.name, components: Array.from(new Set(route.componentFiles.map(toProjectPath))) };
  }).sort((a, b) => a.path.localeCompare(b.path) || (a.name ?? "").localeCompare(b.name ?? ""));

  return { version: 1, components: Object.fromEntries(components), routes };
}

export function generateComponentGraphJson(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  routeMetaEntries: RouterIntrospectionResult["routeMetaEntries"],
  projectRoot: string,
): string {
  return `${JSON.stringify(buildComponentGraph(componentHierarchyMap, routeMetaEntries, projectRoot), null, 2)}\n`;
}

function buildTestIdManifest(componentHierarchyMap: Map<string, IComponentDependencies>): Record<string, string[]> {
  return Object.fromEntries(
    Array.from(componentHierarchyMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([componentName, dependencies]) => {
        const testIds = Array.from(dependencies.dataTestIdSet)
          .map(entry => entry.selectorValue.formatted)
          .filter(Boolean);
        if (!testIds.length) {
          return null;
        }
        return [componentName, Array.from(new Set(testIds)).sort((a, b) => a.localeCompare(b))] as const;
      })
      .filter((entry): entry is readonly [string, string[]] => entry !== null),
  );
}

function writeConstJson(value: PomManifest | Record<string, string[]>): WriterFunction {
  return (writer) => {
    writer.write(`${JSON.stringify(value, null, 2)} as const`);
  };
}

/**
 * Generates the complete virtual:testids module content
 */
export function generateTestIdsModule(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
): string {
  const pomManifest = buildPomManifest(componentHierarchyMap, elementMetadata);
  const testIdManifest = buildTestIdManifest(componentHierarchyMap);

  return renderSourceFile("virtual-testids.ts", (sourceFile) => {
    sourceFile.addStatements("// Virtual module: test id manifest");
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [{
        name: "testIdManifest",
        initializer: writeConstJson(testIdManifest),
      }],
    });
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [{
        name: "pomManifest",
        initializer: writeConstJson(pomManifest),
      }],
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "TestIdManifest",
      type: "typeof testIdManifest",
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "ComponentName",
      type: "keyof TestIdManifest",
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "PomManifest",
      type: "typeof pomManifest",
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "PomManifestComponentName",
      type: "keyof PomManifest",
    });
  });
}

export function generatePomManifestModule(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
  fileName: string = "virtual-pom-manifest.ts",
  renderCache?: TypeScriptRenderCache,
): string {
  const pomManifest = buildPomManifest(componentHierarchyMap, elementMetadata);

  return renderStructuredSourceFile(fileName, {
    statements: [{
      kind: StructureKind.VariableStatement,
      leadingTrivia: "// Rich POM discoverability manifest.\n",
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [{
        name: "pomManifest",
        initializer: writeConstJson(pomManifest),
      }],
    }, {
      kind: StructureKind.TypeAlias,
      isExported: true,
      name: "PomManifest",
      type: "typeof pomManifest",
    }, {
      kind: StructureKind.TypeAlias,
      isExported: true,
      name: "PomManifestComponentName",
      type: "keyof PomManifest",
    }],
  }, { cache: renderCache });
}
