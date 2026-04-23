/**
 * Test ID manifest generator utilities
 * Generates TypeScript types and manifests from collected test IDs
 */

import type { ElementMetadata } from "./metadata-collector";
import { buildPomLocatorDescription, humanizePomMethodName } from "./pom-discoverability";
import type { IComponentDependencies, IDataTestId, PomExtraClickMethodSpec, PomPrimarySpec } from "./utils";
import { renderSourceFile, VariableDeclarationKind, type WriterFunction } from "./typescript-codegen";
import { upperFirst } from "./utils";

type PomManifestEntry = {
  testId: string;
  selectorPatternKind: "static" | "parameterized";
  semanticName: string;
  locatorDescription: string;
  inferredRole: string | null;
  generatedPropertyName: string | null;
  generatedActionName: string | null;
  generatedActionNames: string[];
  emitPrimary: boolean;
  targetPageObjectModelClass?: string;
  sourceTag?: string;
  sourceTagType?: number;
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

function removeByKeySegment(value: string): string {
  const idx = value.indexOf("ByKey");
  if (idx < 0) {
    return value;
  }
  return value.slice(0, idx) + value.slice(idx + "ByKey".length);
}

function hasRoleSuffix(baseName: string, roleSuffix: string): boolean {
  if (baseName.endsWith(roleSuffix)) {
    return true;
  }

  const re = new RegExp(`^${roleSuffix}\\d+$`);
  return re.test(baseName);
}

function getGeneratedPropertyName(pom: PomPrimarySpec): string {
  if (pom.getterNameOverride) {
    return pom.getterNameOverride;
  }

  const roleSuffix = upperFirst(pom.nativeRole || "Element");
  const baseName = upperFirst(pom.methodName);
  const propertyName = hasRoleSuffix(baseName, roleSuffix) ? baseName : `${baseName}${roleSuffix}`;
  return pom.selector.patternKind === "parameterized" ? removeByKeySegment(propertyName) : propertyName;
}

function getGeneratedActionName(entry: IDataTestId, pom: PomPrimarySpec): string {
  const methodNameUpper = upperFirst(pom.methodName);
  const radioMethodNameUpper = upperFirst(pom.methodName || "Radio");
  const isNavigation = !!entry.targetPageObjectModelClass;

  if (isNavigation) {
    return `goTo${methodNameUpper}`;
  }

  switch (pom.nativeRole) {
    case "input":
      return `type${methodNameUpper}`;
    case "select":
    case "vselect":
      return `select${methodNameUpper}`;
    case "radio":
      return `select${radioMethodNameUpper}`;
    default:
      return `click${methodNameUpper}`;
  }
}

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
  const generatedActionName = pom ? getGeneratedActionName(entry, pom) : null;
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
    generatedPropertyName: pom ? getGeneratedPropertyName(pom) : null,
    generatedActionName,
    generatedActionNames,
    emitPrimary: pom?.emitPrimary !== false,
    ...(entry.targetPageObjectModelClass ? { targetPageObjectModelClass: entry.targetPageObjectModelClass } : {}),
    ...(metadata?.tag ? { sourceTag: metadata.tag } : {}),
    ...(metadata ? { sourceTagType: metadata.tagType } : {}),
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

function buildTestIdManifest(pomManifest: PomManifest): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(pomManifest)
      .map(([componentName, component]) => [componentName, Array.from(new Set(component.testIds)).sort((a, b) => a.localeCompare(b))] as const),
  );
}

function writeConstJson(value: unknown): WriterFunction {
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
  const testIdManifest = buildTestIdManifest(pomManifest);

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
