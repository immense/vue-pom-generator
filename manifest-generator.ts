/**
 * Test ID manifest generator utilities
 * Generates TypeScript types and manifests from collected test IDs
 */

import type { AccessibilityAuditResult } from "./accessibility-audit";
import { buildAccessibilityAudit } from "./accessibility-audit";
import type { ElementMetadata } from "./metadata-collector";
import {
  buildPomLocatorDescription,
  humanizePomComponentName,
  humanizePomMethodName,
  normalizePomRoleLabel,
  splitPomDiscoverabilityWords,
  stripPomActionPrefix,
} from "./pom-discoverability";
import type {
  WebMcpManifest,
  WebMcpManifestAction,
  WebMcpManifestComponent,
  WebMcpManifestParameter,
  WebMcpManifestTool,
} from "./webmcp-runtime";
import type { IComponentDependencies, IDataTestId, PomExtraClickMethodSpec, PomPrimarySpec } from "./utils";
import { addNamedImport, renderSourceFile, VariableDeclarationKind, type WriterFunction } from "./typescript-codegen";
import { upperFirst } from "./utils";

type PomManifestEntry = {
  testId: string;
  selectorPatternKind: "static" | "parameterized";
  selectorTemplateVariables: string[];
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

const WEB_MCP_PARAM_ROLES = new Set(["input", "select", "vselect", "checkbox", "radio"]);
const WEB_MCP_ACTION_ROLES = new Set(["button", "toggle"]);

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

function removeLeadingWords(words: readonly string[], prefixWords: readonly string[]): string[] {
  if (!prefixWords.length || words.length < prefixWords.length) {
    return [...words];
  }

  for (let i = 0; i < prefixWords.length; i += 1) {
    if (words[i] !== prefixWords[i]) {
      return [...words];
    }
  }

  return words.slice(prefixWords.length);
}

function removeTrailingWord(words: readonly string[], trailingWord: string | null): string[] {
  if (!trailingWord || !words.length || words[words.length - 1] !== trailingWord) {
    return [...words];
  }

  return words.slice(0, -1);
}

function toSnakeCase(words: readonly string[]): string {
  return words.join("_");
}

function toCamelCase(words: readonly string[]): string {
  if (!words.length) {
    return "";
  }

  return words[0] + words.slice(1).map(word => upperFirst(word)).join("");
}

function getComponentWords(componentName: string): string[] {
  const words = splitPomDiscoverabilityWords(humanizePomComponentName(componentName));
  return words.length ? words : splitPomDiscoverabilityWords(componentName);
}

function getWebMcpParamName(entry: PomManifestEntry, componentWords: readonly string[]): string {
  const baseWords = splitPomDiscoverabilityWords(entry.generatedPropertyName || entry.semanticName || entry.testId);
  const roleWord = entry.inferredRole ? normalizePomRoleLabel(entry.inferredRole).toLowerCase() : null;
  const withoutComponentWords = removeLeadingWords(baseWords, componentWords);
  const preferredWords = removeTrailingWord(withoutComponentWords, roleWord);
  const fallbackWords = removeTrailingWord(baseWords, roleWord);
  const words = preferredWords.length
    ? preferredWords
    : fallbackWords.length
      ? fallbackWords
      : [entry.inferredRole === "checkbox" ? "checked" : "value"];

  return toCamelCase(words);
}

function buildWebMcpActions(entries: readonly PomManifestEntry[]): WebMcpManifestAction[] {
  const actions = new Map<string, WebMcpManifestAction>();

  for (const entry of entries) {
    if (!entry.generatedActionNames.length) {
      continue;
    }

    const canDriveAction = (entry.inferredRole && WEB_MCP_ACTION_ROLES.has(entry.inferredRole))
      || !!entry.targetPageObjectModelClass;
    if (!canDriveAction) {
      continue;
    }

    for (const actionName of entry.generatedActionNames) {
      if (actions.has(actionName)) {
        continue;
      }

      actions.set(actionName, {
        name: actionName,
        testId: entry.testId,
        description: upperFirst(humanizePomMethodName(stripPomActionPrefix(actionName))),
        selectorPatternKind: entry.selectorPatternKind,
        selectorTemplateVariables: entry.selectorTemplateVariables,
        ...(entry.targetPageObjectModelClass ? { targetPageObjectModelClass: entry.targetPageObjectModelClass } : {}),
      });
    }
  }

  return Array.from(actions.values()).sort((a, b) => a.name.localeCompare(b.name) || a.testId.localeCompare(b.testId));
}

export function buildWebMcpManifestFromPomManifest(pomManifest: PomManifest): WebMcpManifest {
  const webMcpEntries = Object.entries(pomManifest)
    .map(([componentName, component]) => {
      const componentWords = getComponentWords(componentName);
      const actions = buildWebMcpActions(component.entries);
      const params = component.entries
        .filter(entry => entry.inferredRole && WEB_MCP_PARAM_ROLES.has(entry.inferredRole))
        .map(entry => ({
          name: getWebMcpParamName(entry, componentWords),
          role: entry.inferredRole!,
          testId: entry.testId,
          selectorPatternKind: entry.selectorPatternKind,
          selectorTemplateVariables: entry.selectorTemplateVariables,
          toolParamDescription: entry.semanticName,
          generatedPropertyName: entry.generatedPropertyName,
        } satisfies WebMcpManifestParameter))
        .sort((a, b) => a.name.localeCompare(b.name) || a.testId.localeCompare(b.testId));

      if (!params.length && !actions.length) {
        return null;
      }

      const componentLabel = upperFirst(humanizePomComponentName(componentName) || componentName);
      const tools: WebMcpManifestTool[] = [{
        toolName: toSnakeCase(componentWords),
        toolDescription: `Interact with ${componentLabel}.`,
        toolAutoSubmit: actions.length === 1 && params.length === 0,
        params,
        actions,
      }];

      return [componentName, {
        componentName,
        className: component.className,
        sourceFile: component.sourceFile,
        kind: component.kind,
        tools,
      } satisfies WebMcpManifestComponent] as const;
    })
    .filter((entry): entry is readonly [string, WebMcpManifestComponent] => entry !== null);

  return Object.fromEntries(webMcpEntries);
}

export function buildWebMcpManifest(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
): WebMcpManifest {
  return buildWebMcpManifestFromPomManifest(buildPomManifest(componentHierarchyMap, elementMetadata));
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
  const accessibility = buildAccessibilityAudit(metadata, pom?.nativeRole ?? null);

  return {
    testId,
    selectorPatternKind: entry.selectorValue.patternKind,
    selectorTemplateVariables: [...entry.selectorValue.templateVariables],
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
  const webMcpManifest = buildWebMcpManifestFromPomManifest(pomManifest);

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
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [{
        name: "webMcpManifest",
        initializer: writeConstJson(webMcpManifest),
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
    sourceFile.addTypeAlias({
      isExported: true,
      name: "WebMcpManifest",
      type: "typeof webMcpManifest",
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "WebMcpManifestComponentName",
      type: "keyof WebMcpManifest",
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

export function generateWebMcpManifestModule(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
): string {
  const webMcpManifest = buildWebMcpManifest(componentHierarchyMap, elementMetadata);

  return renderSourceFile("virtual-webmcp-manifest.ts", (sourceFile) => {
    sourceFile.addStatements("// Virtual module: WebMCP tool manifest");
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [{
        name: "webMcpManifest",
        initializer: writeConstJson(webMcpManifest),
      }],
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "WebMcpManifest",
      type: "typeof webMcpManifest",
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "WebMcpManifestComponentName",
      type: "keyof WebMcpManifest",
    });
  });
}

export function generateWebMcpBridgeModule(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
  testIdAttribute: string,
): string {
  const webMcpManifest = buildWebMcpManifest(componentHierarchyMap, elementMetadata);

  return renderSourceFile("virtual-webmcp-bridge.ts", (sourceFile) => {
    sourceFile.addStatements("// Virtual module: WebMCP runtime bridge");
    addNamedImport(sourceFile, {
      moduleSpecifier: "@immense/vue-pom-generator/webmcp-runtime",
      namedImports: ["registerWebMcpManifestTools"],
    });
    addNamedImport(sourceFile, {
      moduleSpecifier: "@immense/vue-pom-generator/webmcp-runtime",
      isTypeOnly: true,
      namedImports: ["RegisterWebMcpManifestToolsOptions", "RegisteredWebMcpToolsHandle"],
    });
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [{
        name: "webMcpManifest",
        initializer: writeConstJson(webMcpManifest),
      }],
    });
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [{
        name: "webMcpTestIdAttribute",
        initializer: JSON.stringify(testIdAttribute),
      }],
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "WebMcpManifest",
      type: "typeof webMcpManifest",
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "WebMcpManifestComponentName",
      type: "keyof WebMcpManifest",
    });
    sourceFile.addStatements(`
let activeWebMcpRegistration: RegisteredWebMcpToolsHandle | null = null;

export type GeneratedWebMcpToolRegistrationOptions = Omit<RegisterWebMcpManifestToolsOptions, "manifest" | "testIdAttribute">;

export function registerGeneratedWebMcpTools(
  options: GeneratedWebMcpToolRegistrationOptions = {},
): RegisteredWebMcpToolsHandle {
  if (activeWebMcpRegistration) {
    activeWebMcpRegistration.unregister();
  }

  activeWebMcpRegistration = registerWebMcpManifestTools({
    manifest: webMcpManifest,
    testIdAttribute: webMcpTestIdAttribute,
    ...options,
  });

  return activeWebMcpRegistration;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (activeWebMcpRegistration) {
      activeWebMcpRegistration.unregister();
      activeWebMcpRegistration = null;
    }
  });
}
`);
  });
}
