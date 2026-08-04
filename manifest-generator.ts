/**
 * Test ID manifest generator utilities
 * Generates TypeScript types and manifests from collected test IDs
 */

import type { AccessibilityAuditResult } from "./accessibility-audit";
import { buildAccessibilityAudit } from "./accessibility-audit";
import type { ElementMetadata } from "./metadata-collector";
import { buildPomLocatorDescription, humanizePomMethodName } from "./pom-discoverability";
import type { IComponentDependencies, IDataTestId, PomExtraClickMethodSpec, PomPrimarySpec } from "./utils";
import { buildPomGeneratedActionName, buildPomGeneratedPropertyName, shouldSuppressStandaloneWrapperFallbackSurface } from "./utils";
import { renderSourceFile, VariableDeclarationKind, type WriterFunction } from "./typescript-codegen";

type PomManifestEntry = {
  testId: string;
  selectorPatternKind: "static" | "parameterized";
  semanticName: string;
  locatorDescription: string;
  inferredRole: string | null;
  accessibility?: AccessibilityAuditResult;
  generatedPropertyName: string | null;
  generatedActionName: string | null;
  generatedActionNames: string[];
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

type PomManifestComponent = {
  componentName: string;
  className: string;
  sourceFile: string;
  kind: "component" | "view";
  testIds: string[];
  entries: PomManifestEntry[];
};

type PomManifest = Record<string, PomManifestComponent>;

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
    .filter(([componentName, dependencies]) => !shouldSuppressStandaloneWrapperFallbackSurface(componentName, dependencies))
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
): string {
  const pomManifest = buildPomManifest(componentHierarchyMap, elementMetadata);

  return renderSourceFile("virtual-pom-manifest.ts", (sourceFile) => {
    sourceFile.addStatements("// Virtual module: richer POM discoverability manifest");
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
