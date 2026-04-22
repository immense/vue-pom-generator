import { parse } from "@babel/parser";
import type { ClassMethod } from "@babel/types";
import type { ElementNode, ForNode, IfBranchNode, IfNode, RootNode, TemplateChildNode } from "@vue/compiler-core";
import { ElementTypes } from "@vue/compiler-core";
import { NodeTypes, parse as parseTemplate } from "@vue/compiler-dom";
import { parse as parseSfc } from "@vue/compiler-sfc";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { generateViewObjectModelMembers, generateViewObjectModelMethodContent } from "../method-generation";
import {
  ensurePomPatternParameters,
  isParameterizedPomPattern,
  toCSharpPomPatternExpression,
  toTypeScriptPomPatternExpression,
  uniquePomStringPatterns,
  type PomStringPattern,
} from "../pom-patterns";
import { introspectNuxtPages, parseRouterFileFromCwd } from "../router-introspection";
import {
  addExportAll,
  addNamedImport,
  buildCommentBlock,
  buildFilePrefix,
  createClassConstructor,
  createClassMethod,
  createClassProperty,
  renderSourceFile,
  StructureKind,
  VariableDeclarationKind,
  type ConstructorDeclarationStructure,
  type GetAccessorDeclarationStructure,
  type MethodDeclarationStructure,
  type OptionalKind,
  type ParameterDeclarationStructure,
  type PropertyDeclarationStructure,
  type TypeScriptClassMember,
  type TypeScriptSourceFile,
} from "../typescript-codegen";
import {
  IComponentDependencies,
  IDataTestId,
  PomExtraClickMethodSpec,
  PomPrimarySpec,
  PomSelectorSpec,
  toPascalCase,
  upperFirst,
} from "../utils";

// Intentionally imported so tooling understands this exported helper is part of the
// generated POM public surface (it is consumed by generated Playwright fixtures).
import { setPlaywrightAnimationOptions } from "./pointer";

void setPlaywrightAnimationOptions;

export { generateViewObjectModelMethodContent };

const GENERATED_GITATTRIBUTES_BLOCK_START = "# BEGIN vue-pom-generator generated files";
const GENERATED_GITATTRIBUTES_BLOCK_END = "# END vue-pom-generator generated files";
const VUE_POM_GENERATOR_ERROR_PREFIX = "[vue-pom-generator]" as const;

class VuePomGeneratorError extends Error {
  public constructor(message: string) {
    const normalized = message.startsWith(VUE_POM_GENERATOR_ERROR_PREFIX)
      ? message
      : `${VUE_POM_GENERATOR_ERROR_PREFIX} ${message}`;
    super(normalized);
    this.name = "VuePomGeneratorError";
  }
}

function splitParameterList(parameters: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let angleDepth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateString = false;

  for (let index = 0; index < parameters.length; index += 1) {
    const char = parameters[index];
    const previous = index > 0 ? parameters[index - 1] : "";

    if (char === "'" && !inDoubleQuote && !inTemplateString && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }
    if (char === "\"" && !inSingleQuote && !inTemplateString && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }
    if (char === "`" && !inSingleQuote && !inDoubleQuote && previous !== "\\") {
      inTemplateString = !inTemplateString;
      current += char;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inTemplateString) {
      current += char;
      continue;
    }

    switch (char) {
      case "{":
        braceDepth += 1;
        break;
      case "}":
        braceDepth -= 1;
        break;
      case "[":
        bracketDepth += 1;
        break;
      case "]":
        bracketDepth -= 1;
        break;
      case "(":
        parenDepth += 1;
        break;
      case ")":
        parenDepth -= 1;
        break;
      case "<":
        angleDepth += 1;
        break;
      case ">":
        angleDepth -= 1;
        break;
      case ",":
        if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0 && angleDepth === 0) {
          const trimmed = current.trim();
          if (trimmed) {
            parts.push(trimmed);
          }
          current = "";
          continue;
        }
        break;
      default:
        break;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) {
    parts.push(trimmed);
  }

  return parts;
}

function parseParameterSignature(parameter: string): OptionalKind<ParameterDeclarationStructure> {
  const colonIndex = parameter.indexOf(":");
  if (colonIndex < 0) {
    return { name: parameter.trim() };
  }

  const rawName = parameter.slice(0, colonIndex).trim();
  const hasQuestionToken = rawName.endsWith("?");
  const name = hasQuestionToken ? rawName.slice(0, -1).trim() : rawName;
  const remainder = parameter.slice(colonIndex + 1).trim();
  const initializerIndex = remainder.lastIndexOf("=");

  if (initializerIndex < 0) {
    return {
      name,
      hasQuestionToken,
      type: remainder || undefined,
    };
  }

  return {
    name,
    hasQuestionToken,
    type: remainder.slice(0, initializerIndex).trim() || undefined,
    initializer: remainder.slice(initializerIndex + 1).trim() || undefined,
  };
}

function parseParameterSignatures(parameters: string): OptionalKind<ParameterDeclarationStructure>[] {
  const trimmed = parameters.trim();
  if (!trimmed) {
    return [];
  }
  return splitParameterList(trimmed).map(parseParameterSignature);
}

function toPosixRelativePath(fromDir: string, toFile: string): string {
  let rel = path.relative(fromDir, toFile).replace(/\\/g, "/");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function stripExtension(filePath: string): string {
  // IMPORTANT:
  // This helper is used for generating *import specifiers*.
  // On Windows, `path.parse/path.format` can re-introduce backslashes even when
  // the input contains `/` separators, producing invalid TS string escapes like `"..\\pom\\custom\\nGrid"`.
  // Keep these paths POSIX-normalized.
  const posix = (filePath ?? "").replace(/\\/g, "/");
  const parsed = path.posix.parse(posix);
  return path.posix.format({ ...parsed, base: parsed.name, ext: "" });
}

function resolveRouterEntry(projectRoot?: string, routerEntry?: string) {
  if (!routerEntry) {
    throw new Error("[vue-pom-generator] Router entry path is required when routerAwarePoms is enabled.");
  }
  const root = projectRoot ?? process.cwd();
  return path.isAbsolute(routerEntry) ? routerEntry : path.resolve(root, routerEntry);
}

interface RouteMeta {
  template: string;
}

interface CustomPomMethodSignature {
  params: string;
  argNames: string[];
}

type CustomPomMethodSignatureMap = Map<string, CustomPomMethodSignature>;

interface CustomPomAttachment {
  className: string;
  propertyName: string;
  attachWhenUsesComponents: string[];
  attachTo?: "views" | "components" | "both" | "pagesAndComponents";
  flatten?: boolean;
}

interface ResolvedCustomPomAttachment {
  className: string;
  propertyName: string;
  flatten: boolean;
  methodSignatures: CustomPomMethodSignatureMap;
}

export type TypeScriptOutputStructure = "aggregated" | "split";

interface ResolvedCustomPomImportSpecifier {
  exportName: string;
  localIdentifier: string;
  absolutePath: string;
}

interface CustomPomImportResolution {
  classIdentifierMap: Record<string, string>;
  methodSignaturesByClass: Map<string, CustomPomMethodSignatureMap>;
  availableClassIdentifiers: Set<string>;
  importSpecifiersByClass: Record<string, ResolvedCustomPomImportSpecifier>;
}

function createCustomPomImportCollisionError(exportName: string, requested: string): VuePomGeneratorError {
  return new VuePomGeneratorError(
    `Custom POM import name collision detected for "${exportName}".\n`
    + `The identifier "${requested}" conflicts with a generated POM class.\n`
    + `Fix by setting generation.playwright.customPoms.importAliases["${exportName}"] to a unique name, `
    + `or set generation.playwright.customPoms.importNameCollisionBehavior = "alias" to auto-alias collisions.`,
  );
}

function normalizeComponentTagToClassName(tag: string): string | undefined {
  // Vue templates may reference the same component as <MyWidget /> or <my-widget />.
  const className = toPascalCase(tag);
  return className || undefined;
}

function collectReferencedComponentClassNames(nodes: readonly TemplateChildNode[], names: Set<string>): void {
  for (const node of nodes) {
    switch (node.type) {
      case NodeTypes.ELEMENT: {
        const element = node as ElementNode;
        if (element.tagType === ElementTypes.COMPONENT) {
          const className = normalizeComponentTagToClassName(element.tag);
          if (className) {
            names.add(className);
          }
        }
        collectReferencedComponentClassNames(element.children, names);
        break;
      }
      case NodeTypes.IF: {
        const ifNode = node as IfNode;
        for (const branch of ifNode.branches) {
          collectReferencedComponentClassNames((branch as IfBranchNode).children, names);
        }
        break;
      }
      case NodeTypes.FOR: {
        const forNode = node as ForNode;
        collectReferencedComponentClassNames(forNode.children, names);
        break;
      }
      default:
        break;
    }
  }
}

function getComponentClassNamesFromVueSource(source: string): string[] {
  try {
    const { descriptor } = parseSfc(source);
    const template = descriptor.template?.content?.trim();
    if (!template) {
      return [];
    }

    const root = parseTemplate(template) as RootNode;
    const names = new Set<string>();
    collectReferencedComponentClassNames(root.children, names);
    return [...names];
  }
  catch {
    return [];
  }
}

function resolveVueSourcePath(
  targetClassName: string,
  vueFilesPathMap: Map<string, string>,
  projectRoot: string,
): string | undefined {
  const mapped = vueFilesPathMap.get(targetClassName);
  const candidates = [
    mapped,
    path.join(projectRoot, "src", "views", `${targetClassName}.vue`),
    path.join(projectRoot, "src", "components", `${targetClassName}.vue`),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  return candidates.find(candidate => fs.existsSync(candidate));
}

async function getRouteMetaByComponent(
  projectRoot?: string,
  routerEntry?: string,
  routerType?: "vue-router" | "nuxt",
  options: {
    pageDirs?: string[];
    componentDirs?: string[];
    layoutDirs?: string[];
  } = {},
): Promise<Record<string, RouteMeta>> {
  const root = projectRoot ?? process.cwd();
  const pageDirs = options.pageDirs?.length ? options.pageDirs : ["src/views"];
  const pageDirsAbs = pageDirs.map(dir => path.isAbsolute(dir) ? dir : path.resolve(root, dir));
  const primaryPageDirAbs = pageDirsAbs[0] ?? path.resolve(root, "src/views");
  const sourceDirs = [
    ...pageDirs,
    ...(options.componentDirs?.length ? options.componentDirs : ["src/components"]),
    ...(options.layoutDirs?.length ? options.layoutDirs : ["src/layouts"]),
  ];
  const extraRoots = process.cwd() !== root ? [process.cwd()] : [];

  const { routeMetaEntries } = routerType === "nuxt"
    ? await introspectNuxtPages(root, { pageDirs: pageDirsAbs })
    : await parseRouterFileFromCwd(resolveRouterEntry(root, routerEntry), {
      componentNaming: {
        projectRoot: root,
        viewsDirAbs: primaryPageDirAbs,
        sourceDirs,
        extraRoots,
      },
    });

  const map = new Map<string, RouteMeta[]>();
  for (const entry of routeMetaEntries) {
    const list = map.get(entry.componentName) ?? [];
    list.push({ template: entry.pathTemplate });
    map.set(entry.componentName, list);
  }

  const chooseRouteMeta = (entries: RouteMeta[]): RouteMeta | null => {
    if (!entries.length)
      return null;
    return entries
      .slice()
      .sort((a, b) => a.template.length - b.template.length || a.template.localeCompare(b.template))[0];
  };

  const sorted = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(
    sorted
      .map(([componentName, entries]) => {
        const chosen = chooseRouteMeta(entries);
        return chosen ? [componentName, chosen] : null;
      })
      .filter((entry): entry is [string, RouteMeta] => !!entry),
  );
}

function generateRouteProperty(routeMeta: RouteMeta | null): TypeScriptClassMember[] {
  return [
    createClassProperty({
      name: "route",
      isStatic: true,
      isReadonly: true,
      type: "{ template: string } | null",
      initializer: routeMeta
        ? `{ template: ${JSON.stringify(routeMeta.template)} } as const`
        : "null",
    }),
  ];
}

function generateGoToSelfMethod(componentName: string): TypeScriptClassMember[] {
  return [
    createClassMethod({
      name: "goTo",
      isAsync: true,
      statements: [
        "await this.goToSelf();",
      ],
    }),
    createClassMethod({
      name: "goToSelf",
      isAsync: true,
      statements: [
        `const route = ${componentName}.route;`,
        "if (!route) {",
        `    throw new Error("[pom] No router path found for component/page-object '${componentName}'.");`,
        "}",
        "const runtimeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;",
        "const runtimeBaseUrl = runtimeEnv?.PLAYWRIGHT_RUNTIME_BASE_URL ?? runtimeEnv?.PLAYWRIGHT_TEST_BASE_URL ?? runtimeEnv?.VITE_PLAYWRIGHT_BASE_URL;",
        "const targetUrl = runtimeBaseUrl ? new URL(route.template, runtimeBaseUrl).toString() : route.template;",
        "await this.page.goto(targetUrl);",
      ],
    }),
  ];
}

function formatMethodParams(params: Record<string, string> | undefined): string {
  if (!params)
    return "";

  const entries = Object.entries(params);
  if (!entries.length)
    return "";

  return entries
    .map(([name, typeExpr]) => `${name}: ${typeExpr}`)
    .join(", ");
}

function getSelectorPatterns(selector: PomSelectorSpec): PomStringPattern[] {
  return selector.kind === "testId"
    ? [selector.testId]
    : [selector.rootTestId, selector.label];
}

function generateExtraClickMethodMembers(spec: PomExtraClickMethodSpec): TypeScriptClassMember[] {
  if (spec.kind !== "click") {
    return [];
  }

  const selectorPatterns = getSelectorPatterns(spec.selector);
  const params = ensurePomPatternParameters(
    spec.params,
    selectorPatterns,
    { omit: spec.keyLiteral !== undefined ? ["key"] : [] },
  );
  const signatureParams = formatMethodParams(params);
  const parameters = parseParameterSignatures(signatureParams);

  const hasAnnotationText = Object.prototype.hasOwnProperty.call(params, "annotationText");
  const hasWait = Object.prototype.hasOwnProperty.call(params, "wait");
  const annotationArg = hasAnnotationText ? "annotationText" : "\"\"";
  const waitArg = hasWait ? "wait" : "true";

  if (spec.selector.kind === "testId") {
    const needsTemplate = isParameterizedPomPattern(spec.selector.testId.patternKind);
    const testIdExpr = toTypeScriptPomPatternExpression(spec.selector.testId);

    const clickArgs: string[] = [];
    clickArgs.push(needsTemplate ? "testId" : testIdExpr);

    if (hasAnnotationText || hasWait) {
      clickArgs.push(annotationArg);
    }
    if (hasWait) {
      clickArgs.push(waitArg);
    }

    return [
      createClassMethod({
        name: spec.name,
        isAsync: true,
        parameters,
        statements: (writer) => {
          if (spec.keyLiteral !== undefined) {
            writer.writeLine(`const key = ${JSON.stringify(spec.keyLiteral)};`);
          }
          if (needsTemplate) {
            writer.writeLine(`const testId = ${testIdExpr};`);
          }
          writer.writeLine(`await this.clickByTestId(${clickArgs.join(", ")});`);
        },
      }),
    ];
  }

  const rootNeedsTemplate = isParameterizedPomPattern(spec.selector.rootTestId.patternKind);
  const labelNeedsTemplate = isParameterizedPomPattern(spec.selector.label.patternKind);
  const rootExpr = toTypeScriptPomPatternExpression(spec.selector.rootTestId);
  const labelExpr = toTypeScriptPomPatternExpression(spec.selector.label);

  const rootArg = rootNeedsTemplate ? "rootTestId" : rootExpr;
  const labelArg = labelNeedsTemplate ? "label" : labelExpr;
  return [
    createClassMethod({
      name: spec.name,
      isAsync: true,
      parameters,
      statements: (writer) => {
        if (spec.keyLiteral !== undefined) {
          writer.writeLine(`const key = ${JSON.stringify(spec.keyLiteral)};`);
        }
        if (rootNeedsTemplate) {
          writer.writeLine(`const rootTestId = ${rootExpr};`);
        }
        if (labelNeedsTemplate) {
          writer.writeLine(`const label = ${labelExpr};`);
        }
        writer.writeLine(`await this.clickWithinTestIdByLabel(${rootArg}, ${labelArg}, ${annotationArg}, ${waitArg});`);
      },
    }),
  ];
}

function generateMethodMembersFromPom(primary: PomPrimarySpec, targetPageObjectModelClass?: string): TypeScriptClassMember[] {
  if (primary.emitPrimary === false) {
    return [];
  }

  return generateViewObjectModelMembers(
    targetPageObjectModelClass,
    primary.methodName,
    primary.nativeRole,
    primary.selector,
    primary.alternateSelectors,
    primary.getterNameOverride,
    primary.params ?? {},
  );
}

function generateMethodsContentForDependencies(dependencies: IComponentDependencies): TypeScriptClassMember[] {
  const entries = Array.from(dependencies.dataTestIdSet ?? []);
  const primarySpecsAll = entries
    .map(e => ({ pom: e.pom, target: e.targetPageObjectModelClass }))
    .filter((x): x is { pom: PomPrimarySpec; target: string | undefined } => !!x.pom)
    .sort((a, b) => a.pom.methodName.localeCompare(b.pom.methodName));

  // IMPORTANT:
  // `dependencies.dataTestIdSet` is a Set of objects; it does not de-dupe by semantic identity.
  // It's possible to end up with multiple IDataTestId entries that carry identical `pom` specs.
  // When we emit from IR, we must de-dupe here to avoid duplicate getters/methods.
  const seenPrimaryKeys = new Set<string>();
  const primarySpecs = primarySpecsAll.filter(({ pom, target }) => {
    const stableParams = pom.params
      ? Object.fromEntries(Object.entries(pom.params).sort((a, b) => a[0].localeCompare(b[0])))
      : undefined;
    const alternates = (pom.alternateSelectors ?? [])
      .slice()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const key = JSON.stringify({
      role: pom.nativeRole,
      methodName: pom.methodName,
      getterNameOverride: pom.getterNameOverride ?? null,
      selector: pom.selector,
      alternateSelectors: alternates.length ? alternates : undefined,
      params: stableParams,
      target: target ?? null,
      emitPrimary: pom.emitPrimary ?? true,
    });
    if (seenPrimaryKeys.has(key)) {
      return false;
    }
    seenPrimaryKeys.add(key);
    return true;
  });

  const extras = (dependencies.pomExtraMethods ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const members: TypeScriptClassMember[] = [];
  for (const { pom, target } of primarySpecs) {
    members.push(...generateMethodMembersFromPom(pom, target));
  }

  for (const extra of extras) {
    members.push(...generateExtraClickMethodMembers(extra));
  }

  return members;
}

export interface GenerateFilesOptions {
  /**
   * Output directory for generated files.
   *
   * Defaults to `./pom` when omitted (backwards compatible default for internal usage).
   */
  outDir?: string;

  /**
   * Generate Playwright fixture helpers alongside generated POMs.
   *
   * Default output (when `true`):
   * - `<projectRoot>/<outDir>/fixtures.g.ts`
   *
   * Convention:
   * - fixtures automatically prefer matching handwritten override classes from
   *   `<dirname(customPomDir)>/overrides/<ClassName>.ts` when present
   *
   * Accepted values:
   * - `true`: enable with defaults
   * - `"path"`: enable and write the fixture file under this directory (resolved relative to projectRoot),
   *   or to this file path if it ends with `.ts`/`.tsx`/`.mts`/`.cts`
   * - `{ outDir }`: enable and override where fixture files are written (resolved relative to projectRoot)
   */
  generateFixtures?: boolean | string | { outDir?: string };

  /**
   * Project root used for resolving conventional paths (e.g. src/views, tests/playwright/pom/custom).
   * Defaults to process.cwd() for backwards compatibility.
   */
  projectRoot?: string;

  /**
   * Directory containing handwritten POM helpers to import into aggregated output.
   * Defaults to <projectRoot>/tests/playwright/pom/custom.
   */
  customPomDir?: string;

  /**
   * Optional import aliases for handwritten POM helpers.
   *
   * Keyed by the helper file/export name (basename of the .ts file).
   * Value is the identifier to import it as.
   *
   * Example: { Toggle: "ToggleWidget" }
   */
  customPomImportAliases?: Record<string, string>;

  /**
   * How to handle collisions between custom POM import identifiers and generated class names.
   *
   * - "error" (default): fail generation with a descriptive error
   * - "alias": auto-alias colliding custom imports (e.g. PersonListPage -> PersonListPageCustom)
   */
  customPomImportNameCollisionBehavior?: "error" | "alias";

  /**
   * Handwritten POM helper attachments. These helpers are assumed to be present in the
   * aggregated output (e.g. via `tests/playwright/pom/custom/*.ts` inlining), but we only attach them to
   * view classes that actually use certain components.
   */
  customPomAttachments?: CustomPomAttachment[];

  /** Attribute name to treat as the test id. Defaults to `data-testid`. */
  testIdAttribute?: string;

  /** Which POM languages to emit. Defaults to ["ts"]. */
  emitLanguages?: Array<"ts" | "csharp">;

  /**
   * Controls how TypeScript Playwright page objects are emitted.
   *
   * - "aggregated" (default): emit a single `page-object-models.g.ts`
   * - "split": emit one generated `.g.ts` file per class plus a stable `index.ts` barrel
   */
  typescriptOutputStructure?: TypeScriptOutputStructure;

  /** C# generation options. */
  csharp?: {
    namespace?: string;
  };

  /** When true, generate router-aware helpers like goToSelf() on view POMs. */
  vueRouterFluentChaining?: boolean;

  /** Router entry path used for vue-router introspection when fluent chaining is enabled. */
  routerEntry?: string;

  /** The type of router introspection to perform. */
  routerType?: "vue-router" | "nuxt";

  pageDirs?: string[];
  componentDirs?: string[];
  layoutDirs?: string[];

  routeMetaByComponent?: Record<string, RouteMeta>;
}

interface BaseGenerateContentOptions {
  /** Directory the generated .g.ts file will live in (used for relative imports). Defaults to the Vue file's directory. */
  outputDir?: string;

  customPomAttachments?: CustomPomAttachment[];

  projectRoot?: string;
  customPomDir?: string;
  customPomImportAliases?: Record<string, string>;
  customPomClassIdentifierMap?: Record<string, string>;
  customPomAvailableClassIdentifiers?: Set<string>;
  customPomImportSpecifiersByClass?: Record<string, ResolvedCustomPomImportSpecifier>;
  customPomMethodSignaturesByClass?: Map<string, CustomPomMethodSignatureMap>;
  generatedTsFilePathByComponent?: Map<string, string>;

  /** Attribute name to treat as the test id. Defaults to `data-testid`. */
  testIdAttribute?: string;

  /** When true, generate router-aware helpers like goToSelf() on view POMs. */
  vueRouterFluentChaining?: boolean;

  routeMetaByComponent?: Record<string, RouteMeta>;
}

type GenerateContentOptions
  = BaseGenerateContentOptions & (
    { outputStructure: "aggregated" }
    | { outputStructure?: "split" }
  );

interface GeneratedFileOutput {
  filePath: string;
  content: string;
}

export async function generateFiles(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  vueFilesPathMap: Map<string, string>,
  basePageClassPath: string,
  options: GenerateFilesOptions = {},
) {
  const {
    outDir: outDirOverride,
    generateFixtures,
    customPomAttachments = [],
    projectRoot,
    customPomDir,
    customPomImportAliases,
    customPomImportNameCollisionBehavior = "error",
    testIdAttribute,
    emitLanguages: emitLanguagesOverride,
    typescriptOutputStructure = "aggregated",
    csharp,
    vueRouterFluentChaining,
    routerEntry,
    routerType,
    pageDirs,
    componentDirs,
    layoutDirs,
    routeMetaByComponent: routeMetaByComponentOverride,
  } = options;

  const emitLanguages: Array<"ts" | "csharp"> = emitLanguagesOverride?.length
    ? emitLanguagesOverride
    : ["ts"];

  const outDir = outDirOverride ?? "./pom";

  const routeMetaByComponent = routeMetaByComponentOverride
    ?? (vueRouterFluentChaining
      ? await getRouteMetaByComponent(projectRoot, routerEntry, routerType, {
        pageDirs,
        componentDirs,
        layoutDirs,
      })
      : undefined);
  const generatedFilePaths: string[] = [];
  const writeGeneratedFile = (file: GeneratedFileOutput) => {
    const resolvedFilePath = path.resolve(file.filePath);
    createFile(resolvedFilePath, file.content);
    generatedFilePaths.push(resolvedFilePath);
  };

  if (emitLanguages.includes("ts")) {
    const files = typescriptOutputStructure === "split"
      ? await generateSplitTypeScriptFiles(componentHierarchyMap, vueFilesPathMap, basePageClassPath, outDir, {
        customPomAttachments,
        projectRoot,
        customPomDir,
        customPomImportAliases,
        customPomImportNameCollisionBehavior,
        testIdAttribute,
        routeMetaByComponent,
        vueRouterFluentChaining,
      })
      : await generateAggregatedFiles(componentHierarchyMap, vueFilesPathMap, basePageClassPath, outDir, {
        customPomAttachments,
        projectRoot,
        customPomDir,
        customPomImportAliases,
        customPomImportNameCollisionBehavior,
        testIdAttribute,
        generateFixtures,
        routeMetaByComponent,
        vueRouterFluentChaining,
      });
    for (const file of files) {
      writeGeneratedFile(file);
    }

    const fixtureRegistryFile = maybeGenerateFixtureRegistry(componentHierarchyMap, {
      generateFixtures,
      pomOutDir: outDir,
      projectRoot,
      customPomDir,
    });
    if (fixtureRegistryFile) {
      writeGeneratedFile(fixtureRegistryFile);
    }
  }

  if (emitLanguages.includes("csharp")) {
    const csFiles = generateAggregatedCSharpFiles(componentHierarchyMap, outDir, {
      projectRoot,
      testIdAttribute,
      csharp,
    });
    for (const file of csFiles) {
      writeGeneratedFile(file);
    }
  }

  const gitattributesFiles = buildGeneratedGitAttributesFiles(generatedFilePaths);
  for (const file of gitattributesFiles) {
    createFile(file.filePath, file.content);
  }
}

async function generateSplitTypeScriptFiles(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  vueFilesPathMap: Map<string, string>,
  basePageClassPath: string,
  outDir: string,
  options: {
    customPomAttachments?: GenerateFilesOptions["customPomAttachments"];
    projectRoot?: GenerateFilesOptions["projectRoot"];
    customPomDir?: GenerateFilesOptions["customPomDir"];
    customPomImportAliases?: GenerateFilesOptions["customPomImportAliases"];
    customPomImportNameCollisionBehavior?: GenerateFilesOptions["customPomImportNameCollisionBehavior"];
    testIdAttribute?: GenerateFilesOptions["testIdAttribute"];
    routeMetaByComponent?: Record<string, RouteMeta>;
    vueRouterFluentChaining?: boolean;
  } = {},
): Promise<GeneratedFileOutput[]> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const entries = Array.from(componentHierarchyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  const base = ensureDir(outDir);
  const generatedClassNames = new Set(entries.map(([name]) => name));
  const referencedTargets = new Set<string>();
  for (const [, deps] of entries) {
    for (const dataTestId of deps.dataTestIdSet ?? []) {
      if (dataTestId.targetPageObjectModelClass) {
        referencedTargets.add(dataTestId.targetPageObjectModelClass);
      }
    }
  }

  const stubTargets = Array.from(referencedTargets)
    .filter(target => !generatedClassNames.has(target))
    .sort((a, b) => a.localeCompare(b));

  const availableClassNames = new Set<string>([...generatedClassNames, ...stubTargets]);
  const depsByClassName = new Map<string, IComponentDependencies>(entries);
  const generatedTsFilePathByComponent = new Map<string, string>();
  for (const className of availableClassNames) {
    generatedTsFilePathByComponent.set(className, path.join(base, `${className}.g.ts`));
  }

  const customPomImportResolution = resolveCustomPomImportResolution(generatedClassNames, projectRoot, {
    customPomDir: options.customPomDir,
    customPomImportAliases: options.customPomImportAliases,
    customPomImportNameCollisionBehavior: options.customPomImportNameCollisionBehavior,
  });

  const runtimeBasePagePath = path.join(base, "_pom-runtime", "class-generation", "base-page.ts");
  const files: GeneratedFileOutput[] = [];

  for (const [name, deps] of entries) {
    const filePath = generatedTsFilePathByComponent.get(name);
    if (!filePath) {
      continue;
    }

    const content = generateViewObjectModelContent(name, deps, componentHierarchyMap, vueFilesPathMap, runtimeBasePagePath, {
      outputDir: path.dirname(filePath),
      outputStructure: "split",
      customPomAttachments: options.customPomAttachments ?? [],
      projectRoot,
      customPomDir: options.customPomDir,
      customPomImportAliases: options.customPomImportAliases,
      customPomClassIdentifierMap: customPomImportResolution.classIdentifierMap,
      customPomAvailableClassIdentifiers: customPomImportResolution.availableClassIdentifiers,
      customPomImportSpecifiersByClass: customPomImportResolution.importSpecifiersByClass,
      customPomMethodSignaturesByClass: customPomImportResolution.methodSignaturesByClass,
      generatedTsFilePathByComponent,
      testIdAttribute: options.testIdAttribute,
      vueRouterFluentChaining: options.vueRouterFluentChaining,
      routeMetaByComponent: options.routeMetaByComponent,
    });
    files.push({ filePath, content });
  }

  for (const targetClassName of stubTargets) {
    const filePath = generatedTsFilePathByComponent.get(targetClassName);
    if (!filePath) {
      continue;
    }

    const outputDir = path.dirname(filePath);
    const basePageImportSpecifier = stripExtension(toPosixRelativePath(outputDir, runtimeBasePagePath));
    const composed = getComposedStubBody(targetClassName, availableClassNames, depsByClassName, vueFilesPathMap, projectRoot);
    const childImports = getChildImportSpecifiers(outputDir, composed?.childClassNames ?? [], generatedTsFilePathByComponent);
    const members = composed?.members ?? getDefaultStubMembers();

    const content = renderSplitStubPomContent({
      className: targetClassName,
      basePageImportSpecifier,
      childImports,
      members,
    });

    files.push({ filePath, content });
  }

  const runtimeAssetSpecs = getRuntimeGeneratedAssetSpecs(base, basePageClassPath);
  const runtimeFiles = buildRuntimeGeneratedFilesFromSpecs(runtimeAssetSpecs);
  const indexContent = renderSourceFile("index.ts", (sourceFile) => {
    for (const spec of runtimeAssetSpecs) {
      addExportAll(sourceFile, stripExtension(toPosixRelativePath(base, spec.outputPath)));
    }
    for (const [, filePath] of Array.from(generatedTsFilePathByComponent.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      addExportAll(sourceFile, `./${stripExtension(path.basename(filePath))}`);
    }
  }, {
    prefixText: buildFilePrefix({
      eslintDisableSortImports: true,
      commentLines: [
        "POM exports",
        "DO NOT MODIFY BY HAND",
        "",
        "This file is auto-generated by vue-pom-generator.",
        "Changes should be made in the generator/template, not in the generated output.",
      ],
    }),
  });

  return [
    ...files,
    { filePath: path.join(base, "index.ts"), content: indexContent },
    ...runtimeFiles,
  ];
}

function escapeGitAttributesPattern(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\") {
      output += "\\\\";
      continue;
    }
    if (char === " ") {
      output += "\\ ";
      continue;
    }
    if (i === 0 && (char === "#" || char === "!")) {
      output += `\\${char}`;
      continue;
    }
    output += char;
  }
  return output;
}

function pathUsesGeneratedHeuristic(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  return normalized.split(path.sep).includes("__generated__");
}

function buildManagedGitAttributesBlock(entries: string[]): string {
  return [
    GENERATED_GITATTRIBUTES_BLOCK_START,
    "# GitHub Linguist: treat generated POM outputs as generated code by default.",
    ...entries,
    GENERATED_GITATTRIBUTES_BLOCK_END,
    "",
  ].join("\n");
}

function findLineEndOffset(content: string, offset: number): number {
  let cursor = offset;
  while (cursor < content.length && content[cursor] !== "\n") {
    cursor++;
  }
  if (cursor < content.length && content[cursor] === "\n") {
    cursor++;
  }
  return cursor;
}

function renderManagedGitAttributesContent(filePath: string, entries: string[]): string {
  const block = buildManagedGitAttributesBlock(entries);
  if (!fs.existsSync(filePath)) {
    return block;
  }

  const existingContent = fs.readFileSync(filePath, "utf8");
  const blockStart = existingContent.indexOf(GENERATED_GITATTRIBUTES_BLOCK_START);
  const blockEnd = existingContent.indexOf(GENERATED_GITATTRIBUTES_BLOCK_END);

  if (blockStart === -1 && blockEnd === -1) {
    if (!existingContent.length) {
      return block;
    }

    const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
    return `${existingContent}${separator}${block}`;
  }

  if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) {
    throw new Error(`[vue-pom-generator] Found malformed managed .gitattributes block at ${filePath}.`);
  }

  const afterBlock = findLineEndOffset(existingContent, blockEnd);
  return `${existingContent.slice(0, blockStart)}${block}${existingContent.slice(afterBlock)}`;
}

function buildGeneratedGitAttributesFiles(generatedFilePaths: string[]): GeneratedFileOutput[] {
  const entriesByDir = new Map<string, Set<string>>();

  for (const generatedFilePath of generatedFilePaths) {
    const resolvedFilePath = path.resolve(generatedFilePath);
    if (path.basename(resolvedFilePath) === ".gitattributes") {
      continue;
    }

    if (pathUsesGeneratedHeuristic(resolvedFilePath)) {
      continue;
    }

    const dir = path.dirname(resolvedFilePath);
    const entry = `${escapeGitAttributesPattern(path.basename(resolvedFilePath))} linguist-generated`;
    const entries = entriesByDir.get(dir) ?? new Set<string>();
    entries.add(entry);
    entriesByDir.set(dir, entries);
  }

  return Array.from(entriesByDir.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, entries]) => {
      const filePath = path.join(dir, ".gitattributes");
      const content = renderManagedGitAttributesContent(
        filePath,
        Array.from(entries).sort((a, b) => a.localeCompare(b)),
      );
      return { filePath, content };
    });
}

function toCSharpParam(paramTypeExpr: string): { type: string; defaultExpr?: string } {
  const trimmed = (paramTypeExpr ?? "").trim();

  // Handle default values: "boolean = true", "string = \"\"", "timeOut = 500".
  const eqIdx = trimmed.indexOf("=");
  const left = eqIdx >= 0 ? trimmed.slice(0, eqIdx).trim() : trimmed;
  const right = eqIdx >= 0 ? trimmed.slice(eqIdx + 1).trim() : undefined;

  // Collapse union types to their widest practical type.
  const typePart = left.includes("|") ? "string" : left;

  let type = "string";
  if (/(?:^|\s)boolean(?:\s|$)/.test(typePart))
    type = "bool";
  else if (/(?:^|\s)string(?:\s|$)/.test(typePart))
    type = "string";
  else if (/(?:^|\s)number(?:\s|$)/.test(typePart))
    type = "int";
  else if (/\d+/.test(typePart) && typePart === "")
    type = "int";
  else if (/\btimeOut\b/i.test(typePart))
    type = "int";

  let defaultExpr: string | undefined;
  if (right !== undefined) {
    if (type === "bool") {
      defaultExpr = right.includes("true") ? "true" : right.includes("false") ? "false" : undefined;
    }
    else if (type === "int") {
      const m = right.match(/\d+/);
      defaultExpr = m ? m[0] : undefined;
    }
    else {
      // string defaults, keep empty string if detected.
      if (right === "\"\"" || right === "\"\"" || right === "''") {
        defaultExpr = "\"\"";
      }
    }
  }

  return { type, defaultExpr };
}

function formatCSharpParams(params: Record<string, string> | undefined): { signature: string; argNames: string[] } {
  if (!params)
    return { signature: "", argNames: [] };

  const entries = Object.entries(params);
  if (!entries.length)
    return { signature: "", argNames: [] };

  const signatureParts: string[] = [];
  const argNames: string[] = [];

  for (const [name, typeExpr] of entries) {
    const { type, defaultExpr } = toCSharpParam(typeExpr);
    argNames.push(name);
    signatureParts.push(defaultExpr !== undefined ? `${type} ${name} = ${defaultExpr}` : `${type} ${name}`);
  }

  return { signature: signatureParts.join(", "), argNames };
}

function generateAggregatedCSharpFiles(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  outDir: string,
  options: {
    projectRoot?: string;
    testIdAttribute?: string;
    csharp?: {
      namespace?: string;
    };
  } = {},
): GeneratedFileOutput[] {
  const outAbs = ensureDir(outDir);
  const namespace = options.csharp?.namespace ?? "Playwright.Generated";
  const testIdAttribute = (options.testIdAttribute || "data-testid").trim() || "data-testid";

  const entries = Array.from(componentHierarchyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  const header = [
    "// <auto-generated>",
    "// DO NOT MODIFY BY HAND",
    "//",
    "// This file is auto-generated by vue-pom-generator.",
    "// Changes should be made in the generator/template, not in the generated output.",
    "// </auto-generated>",
    "",
    "using System;",
    "using System.Threading.Tasks;",
    "using Microsoft.Playwright;",
    "",
    `namespace ${namespace};`,
    "",
    "public abstract partial class BasePage",
    "{",
    "    protected BasePage(IPage page) => Page = page;",
    "    protected IPage Page { get; }",
    `    protected ILocator LocatorByTestId(string testId) => Page.Locator($"[${testIdAttribute}=\\"{testId}\\"]");`,
    "    protected ILocator LocatorWithinTestIdByLabel(string rootTestId, string label, bool exact = true) => LocatorByTestId(rootTestId).GetByLabel(label, new() { Exact = exact });",
    "    protected async Task<ILocator> ResolveEditableLocatorAsync(ILocator locator)",
    "    {",
    "        var isEditable = await locator.EvaluateAsync<bool>(@\"el => {",
    "            if (!el || !(el instanceof HTMLElement)) return false;",
    "            const tagName = el.tagName.toLowerCase();",
    "            return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || el.isContentEditable;",
    "        }\");",
    "        if (isEditable)",
    "        {",
    "            return locator;",
    "        }",
    "",
    "        var descendant = locator.Locator(\"input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable]:not([contenteditable='false'])\").First;",
    "        if (await descendant.CountAsync() > 0)",
    "        {",
    "            return descendant;",
    "        }",
    "",
    "        return locator;",
    "    }",
    "    protected async Task ClickWithinTestIdByLabelAsync(string rootTestId, string label, bool exact = true)",
    "    {",
    "        await LocatorWithinTestIdByLabel(rootTestId, label, exact).ClickAsync();",
    "    }",
    "",
    "    // Minimal vue-select helper mirroring the TS BasePage.selectVSelectByTestId behavior.",
    "    // Note: annotationText is currently a no-op in C# output (we don't render a pointer overlay).",
    "    protected async Task SelectVSelectByTestIdAsync(string testId, string value, int timeOut = 500)",
    "    {",
    "        var root = LocatorByTestId(testId);",
    "        var input = root.Locator(\"input\");",
    "",
    "        await input.ClickAsync(new LocatorClickOptions { Force = true });",
    "        await input.FillAsync(value);",
    "        await Page.WaitForTimeoutAsync(timeOut);",
    "",
    "        var option = root.Locator(\"ul.vs__dropdown-menu li[role='option']\").First;",
    "        if (await option.CountAsync() > 0)",
    "        {",
    "            await option.ClickAsync();",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");

  const chunks: string[] = [header];

  for (const [componentName, deps] of entries) {
    const className = toPascalCaseLocal(componentName);
    chunks.push(
      `public partial class ${className} : BasePage\n{\n    public ${className}(IPage page) : base(page) { }\n`,
    );

    // Primary specs
    const primaries = Array.from(deps.dataTestIdSet ?? [])
      .map(e => ({ pom: e.pom, target: e.targetPageObjectModelClass }))
      .filter((x): x is { pom: PomPrimarySpec; target: string | undefined } => !!x.pom)
      .sort((a, b) => a.pom.methodName.localeCompare(b.pom.methodName));

    for (const { pom, target } of primaries) {
      if (pom.emitPrimary === false)
        continue;

      const roleSuffix = (pom.nativeRole || "Element") === "vselect" ? "VSelect" : upperFirst(pom.nativeRole || "Element");
      const baseMethodName = upperFirst(pom.methodName);
      const baseGetterName = upperFirst(pom.getterNameOverride ?? pom.methodName);
      const locatorName = baseGetterName.endsWith(roleSuffix) ? baseGetterName : `${baseGetterName}${roleSuffix}`;
      const selectorIsParameterized = isParameterizedPomPattern(pom.selector.patternKind);
      const testIdExpr = toCSharpPomPatternExpression(pom.selector);
      const orderedParams = ensurePomPatternParameters(pom.params, [pom.selector]);

      const { signature, argNames } = formatCSharpParams(orderedParams);
      const args = argNames.join(", ");

      const allTestIds = uniquePomStringPatterns(pom.selector, pom.alternateSelectors);

      if (selectorIsParameterized) {
        chunks.push(`    public ILocator ${locatorName}(${signature}) => LocatorByTestId(${testIdExpr});`);
      }
      else {
        chunks.push(`    public ILocator ${locatorName} => LocatorByTestId(${testIdExpr});`);
      }

      // Action method
      const actionPrefix = pom.nativeRole === "input"
        ? "Type"
        : (pom.nativeRole === "select" || pom.nativeRole === "vselect" || pom.nativeRole === "radio")
          ? "Select"
          : target
            ? "GoTo"
            : "Click";

      const actionName = `${actionPrefix}${baseMethodName}Async`;
      const sig = signature;

      if (target) {
        chunks.push(`    public async Task<${target}> ${actionName}(${sig})`);
        chunks.push("    {");
        if (selectorIsParameterized || allTestIds.length <= 1) {
          chunks.push(`        await ${locatorName}${selectorIsParameterized ? `(${args})` : ""}.ClickAsync();`);
          chunks.push(`        return new ${target}(Page);`);
        }
        else {
          chunks.push("        Exception? lastError = null;");
          chunks.push(`        foreach (var testId in new[] { ${allTestIds.map(testId => toCSharpPomPatternExpression(testId)).join(", ")} })`);
          chunks.push("        {");
          chunks.push("            try");
          chunks.push("            {");
          chunks.push("                var locator = LocatorByTestId(testId);");
          chunks.push("                if (await locator.CountAsync() > 0)");
          chunks.push("                {");
          chunks.push("                    await locator.ClickAsync();");
          chunks.push(`                    return new ${target}(Page);`);
          chunks.push("                }");
          chunks.push("            }");
          chunks.push("            catch (Exception e)");
          chunks.push("            {");
          chunks.push("                lastError = e;");
          chunks.push("            }");
          chunks.push("        }");
          chunks.push("        throw lastError ?? new System.Exception(\"[pom] Failed to navigate using any candidate test id.\");");
        }
        chunks.push("    }");
        chunks.push("");
        continue;
      }

      chunks.push(`    public async Task ${actionName}(${sig})`);
      chunks.push("    {");

      const callSuffix = selectorIsParameterized ? `(${args})` : "";

      const emitActionCall = (locatorAccess: string) => {
        if (pom.nativeRole === "input") {
          chunks.push(`        var editableLocator = await ResolveEditableLocatorAsync(${locatorAccess});`);
          chunks.push("        await editableLocator.FillAsync(text);");
        }
        else if (pom.nativeRole === "select") {
          chunks.push(`        await ${locatorAccess}.SelectOptionAsync(value);`);
        }
        else if (pom.nativeRole === "vselect") {
          // vselect requires custom selection mechanics.
          chunks.push(`        await SelectVSelectByTestIdAsync(${testIdExpr}, value, timeOut);`);
        }
        else {
          chunks.push(`        await ${locatorAccess}.ClickAsync();`);
        }
      };

      if (!selectorIsParameterized && allTestIds.length > 1) {
        chunks.push("        Exception? lastError = null;");
        chunks.push(`        foreach (var testId in new[] { ${allTestIds.map(testId => toCSharpPomPatternExpression(testId)).join(", ")} })`);
        chunks.push("        {");
        chunks.push("            try");
        chunks.push("            {");
        if (pom.nativeRole === "vselect") {
          chunks.push("                // vselect fallback: use the same selection routine for each candidate test id.");
          chunks.push("                var root = LocatorByTestId(testId);");
          chunks.push("                if (await root.CountAsync() > 0)");
          chunks.push("                {");
          chunks.push("                    await SelectVSelectByTestIdAsync(testId, value, timeOut);");
          chunks.push("                    return;");
          chunks.push("                }");
        }
        else {
          chunks.push("                var locator = LocatorByTestId(testId);");
          chunks.push("                if (await locator.CountAsync() > 0)");
          chunks.push("                {");
          if (pom.nativeRole === "input") {
            chunks.push("                    var editableLocator = await ResolveEditableLocatorAsync(locator);");
            chunks.push("                    await editableLocator.FillAsync(text);");
          }
          else if (pom.nativeRole === "select") {
            chunks.push("                    await locator.SelectOptionAsync(value);");
          }
          else {
            chunks.push("                    await locator.ClickAsync();");
          }
          chunks.push("                    return;");
          chunks.push("                }");
        }
        chunks.push("            }");
        chunks.push("            catch (Exception e)");
        chunks.push("            {");
        chunks.push("                lastError = e;");
        chunks.push("            }");
        chunks.push("        }");
        chunks.push("        throw lastError ?? new Exception(\"[pom] Failed to click any candidate test id.\");");
        chunks.push("    }");
        chunks.push("");
        continue;
      }

      emitActionCall(`${locatorName}${callSuffix}`);

      chunks.push("    }");
      chunks.push("");
    }

    // Extra click specs
    const extras = (deps.pomExtraMethods ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const extra of extras) {
      if (extra.kind !== "click")
        continue;
      const extraParams = ensurePomPatternParameters(
        extra.params,
        getSelectorPatterns(extra.selector),
        { omit: extra.keyLiteral !== undefined ? ["key"] : [] },
      );
      const { signature } = formatCSharpParams(extraParams);

      const extraName = upperFirst(extra.name);

      chunks.push(`    public async Task ${extraName}Async(${signature})`);
      chunks.push("    {");
      if (extra.keyLiteral !== undefined) {
        chunks.push(`        var key = ${JSON.stringify(extra.keyLiteral)};`);
      }

      if (extra.selector.kind === "testId") {
        const needsTemplate = isParameterizedPomPattern(extra.selector.testId.patternKind);
        const testIdExpr = toCSharpPomPatternExpression(extra.selector.testId);
        if (needsTemplate) {
          chunks.push(`        var testId = ${testIdExpr};`);
          chunks.push("        await LocatorByTestId(testId).ClickAsync();");
        }
        else {
          chunks.push(`        await LocatorByTestId(${testIdExpr}).ClickAsync();`);
        }
      }
      else {
        const rootNeedsTemplate = isParameterizedPomPattern(extra.selector.rootTestId.patternKind);
        const labelNeedsTemplate = isParameterizedPomPattern(extra.selector.label.patternKind);
        const rootExpr = toCSharpPomPatternExpression(extra.selector.rootTestId);
        const labelExpr = toCSharpPomPatternExpression(extra.selector.label);
        const exactArg = extra.selector.exact === false ? "false" : "true";

        if (rootNeedsTemplate) {
          chunks.push(`        var rootTestId = ${rootExpr};`);
        }
        if (labelNeedsTemplate) {
          chunks.push(`        var label = ${labelExpr};`);
        }

        const rootArg = rootNeedsTemplate ? "rootTestId" : rootExpr;
        const labelArg = labelNeedsTemplate ? "label" : labelExpr;
        chunks.push(`        await ClickWithinTestIdByLabelAsync(${rootArg}, ${labelArg}, ${exactArg});`);
      }
      chunks.push("    }");
      chunks.push("");
    }

    chunks.push("}");
    chunks.push("");
  }

  const outputFile = path.join(outAbs, "page-object-models.g.cs");
  return [{ filePath: outputFile, content: chunks.join("\n") }];
}

function maybeGenerateFixtureRegistry(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  options: {
    generateFixtures: GenerateFilesOptions["generateFixtures"];
    pomOutDir: string;
    projectRoot?: string;
    customPomDir?: string;
  },
): GeneratedFileOutput | null {
  const { generateFixtures, pomOutDir } = options;
  if (!generateFixtures)
    return null;

  // generateFixtures accepts:
  // - true: enable fixtures with defaults
  // - "path": enable fixtures and write them under this directory OR to this file if it ends with .ts
  // - { outDir }: enable fixtures and override output directory
  const defaultFixtureOutDirRel = pomOutDir;
  const fixtureOutRel = typeof generateFixtures === "string"
    ? generateFixtures
    : (typeof generateFixtures === "object" && generateFixtures?.outDir
      ? generateFixtures.outDir
      : defaultFixtureOutDirRel);

  const looksLikeFilePath = fixtureOutRel.endsWith(".ts") || fixtureOutRel.endsWith(".tsx") || fixtureOutRel.endsWith(".mts") || fixtureOutRel.endsWith(".cts");
  const fixtureOutDirRel = looksLikeFilePath ? path.dirname(fixtureOutRel) : fixtureOutRel;
  const fixtureFileName = looksLikeFilePath ? path.basename(fixtureOutRel) : "fixtures.g.ts";

  const root = options.projectRoot ?? process.cwd();
  const fixtureOutDirAbs = path.isAbsolute(fixtureOutDirRel)
    ? fixtureOutDirRel
    : path.resolve(root, fixtureOutDirRel);

  const customPomDirRel = options.customPomDir ?? "tests/playwright/pom/custom";
  const customPomDirAbs = path.isAbsolute(customPomDirRel)
    ? customPomDirRel
    : path.resolve(root, customPomDirRel);
  const overridePomDirAbs = path.resolve(path.dirname(customPomDirAbs), "overrides");

  // Resolve the directory that contains the POM barrel export (e.g. <root>/pom).
  const pomDirAbs = path.isAbsolute(pomOutDir) ? pomOutDir : path.resolve(root, pomOutDir);

  const pomImport = toPosixRelativePath(fixtureOutDirAbs, pomDirAbs);

  const viewClassNames = Array.from(componentHierarchyMap.entries())
    .filter(([, deps]) => !!deps.isView)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  const reservedPlaywrightFixtureNames = new Set([
    // Built-in Playwright fixtures
    "page",
    "context",
    "browser",
    "browserName",
    "request",
    // Our own fixtureOptions
    "animation",
  ]);

  const viewFixtureNames = new Set(viewClassNames.map(name => lowerFirst(name)));

  const componentClassNames = Array.from(componentHierarchyMap.entries())
    .filter(([, deps]) => !deps.isView)
    .map(([name]) => name)
    .filter((name) => {
      const fixtureName = lowerFirst(name);
      if (reservedPlaywrightFixtureNames.has(fixtureName))
        return false;
      if (viewFixtureNames.has(fixtureName))
        return false;
      return true;
    })
    .sort((a, b) => a.localeCompare(b));

  const fixtureClassNames = [...viewClassNames, ...componentClassNames];
  const overrideCtorEntries = fixtureClassNames
    .map((name) => {
      const overrideFilePath = path.join(overridePomDirAbs, `${name}.ts`);
      if (!fs.existsSync(overrideFilePath))
        return null;

      return {
        className: name,
        localIdentifier: `${name}Override`,
        importSpecifier: stripExtension(toPosixRelativePath(fixtureOutDirAbs, overrideFilePath)),
      };
    })
    .filter((entry): entry is { className: string; localIdentifier: string; importSpecifier: string } => !!entry);
  const overrideCtorByClassName = new Map(overrideCtorEntries.map(entry => [entry.className, entry.localIdentifier]));

  const fixtureCtorExpression = (name: string) => overrideCtorByClassName.get(name) ?? `Pom.${name}`;
  const pageCtorEntries = viewClassNames.map(name => ({
    fixtureName: lowerFirst(name),
    ctorExpression: fixtureCtorExpression(name),
  }));
  const componentCtorEntries = componentClassNames.map(name => ({
    fixtureName: lowerFirst(name),
    ctorExpression: fixtureCtorExpression(name),
  }));

  const fixturesContent = renderSourceFile(fixtureFileName, (sourceFile) => {
    sourceFile.addStatements("/** Generated Playwright fixtures (typed page objects). */");

    addNamedImport(sourceFile, {
      moduleSpecifier: "@playwright/test",
      namedImports: [
        "expect",
        { name: "test", alias: "base" },
      ],
    });
    addNamedImport(sourceFile, {
      moduleSpecifier: "@playwright/test",
      isTypeOnly: true,
      namedImports: [{ name: "Page", alias: "PwPage" }],
    });
    sourceFile.addImportDeclaration({
      namespaceImport: "Pom",
      moduleSpecifier: pomImport,
    });
    for (const entry of overrideCtorEntries) {
      addNamedImport(sourceFile, {
        moduleSpecifier: entry.importSpecifier,
        namedImports: [{ name: entry.className, alias: entry.localIdentifier }],
      });
    }

    sourceFile.addInterface({
      isExported: true,
      name: "PlaywrightOptions",
      properties: [{
        name: "animation",
        type: "Pom.PlaywrightAnimationOptions",
      }],
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "PomConstructor",
      typeParameters: [{ name: "T" }],
      type: "new (page: PwPage) => T",
    });
    sourceFile.addInterface({
      isExported: true,
      name: "PomFactory",
      methods: [{
        name: "create",
        typeParameters: [{ name: "T" }],
        parameters: [{ name: "ctor", type: "PomConstructor<T>" }],
        returnType: "T",
      }],
    });
    sourceFile.addTypeAlias({
      name: "PomSetupFixture",
      type: "{ pomSetup: void }",
    });
    sourceFile.addTypeAlias({
      name: "PomFactoryFixture",
      type: "{ pomFactory: PomFactory }",
    });

    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      declarations: [{
        name: "pageCtors",
        initializer: (writer) => {
          writer.write("{").newLine();
          writer.indent(() => {
            for (const entry of pageCtorEntries) {
              writer.writeLine(`${entry.fixtureName}: ${entry.ctorExpression},`);
            }
          });
          writer.write("} as const");
        },
      }],
    });
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      declarations: [{
        name: "componentCtors",
        initializer: (writer) => {
          writer.write("{").newLine();
          writer.indent(() => {
            for (const entry of componentCtorEntries) {
              writer.writeLine(`${entry.fixtureName}: ${entry.ctorExpression},`);
            }
          });
          writer.write("} as const");
        },
      }],
    });

    sourceFile.addTypeAlias({
      isExported: true,
      name: "GeneratedPageFixtures",
      type: "{ [K in keyof typeof pageCtors]: InstanceType<(typeof pageCtors)[K]> }",
    });
    sourceFile.addTypeAlias({
      isExported: true,
      name: "GeneratedComponentFixtures",
      type: "{ [K in keyof typeof componentCtors]: InstanceType<(typeof componentCtors)[K]> }",
    });

    sourceFile.addFunction({
      name: "makePomFixture",
      typeParameters: [{ name: "T" }],
      parameters: [{ name: "Ctor", type: "PomConstructor<T>" }],
      statements: [
        "return async ({ page }: { page: PwPage }, use: (t: T) => Promise<void>) => {",
        "    await use(new Ctor(page));",
        "};",
      ],
    });
    sourceFile.addFunction({
      name: "createPomFixtures",
      typeParameters: [{ name: "TMap", constraint: "Record<string, PomConstructor<any>>" }],
      parameters: [{ name: "ctors", type: "TMap" }],
      statements: [
        "const out: Record<string, any> = {};",
        "for (const [key, Ctor] of Object.entries(ctors)) {",
        "    out[key] = makePomFixture(Ctor as PomConstructor<any>);",
        "}",
        "return out as any;",
      ],
    });

    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      declarations: [{
        name: "test",
        initializer: (writer) => {
          writer.write("base.extend<PlaywrightOptions & PomSetupFixture & PomFactoryFixture & GeneratedPageFixtures & GeneratedComponentFixtures>(");
          writer.block(() => {
            writer.writeLine("animation: [{");
            writer.indent(() => {
              writer.writeLine('pointer: { durationMilliseconds: 250, transitionStyle: "ease-in-out", clickDelayMilliseconds: 0 },');
              writer.writeLine("keyboard: { typeDelayMilliseconds: 100 },");
            });
            writer.writeLine("}, { option: true }],");
            writer.writeLine("pomSetup: [async ({ animation }, use) => {");
            writer.indent(() => {
              writer.writeLine("Pom.setPlaywrightAnimationOptions(animation);");
              writer.writeLine("await use();");
            });
            writer.writeLine("}, { auto: true }],");
            writer.writeLine("pomFactory: async ({ page }, use) => {");
            writer.indent(() => {
              writer.writeLine("await use({");
              writer.indent(() => {
                writer.writeLine("create: <T>(ctor: PomConstructor<T>) => new ctor(page),");
              });
              writer.writeLine("});");
            });
            writer.writeLine("},");
            writer.writeLine("...createPomFixtures(pageCtors),");
            writer.writeLine("...createPomFixtures(componentCtors),");
          });
          writer.write(")");
        },
      }],
    });

    sourceFile.addExportDeclaration({
      namedExports: ["test", "expect"],
    });
  }, {
    prefixText: buildFilePrefix({
      eslintDisableSortImports: true,
      commentLines: [
        "DO NOT MODIFY BY HAND",
        "",
        "This file is auto-generated by vue-pom-generator.",
        "Changes should be made in the generator/template, not in the generated output.",
      ],
    }),
  });

  return {
    filePath: path.resolve(fixtureOutDirAbs, fixtureFileName),
    content: fixturesContent,
  };

  // No pomFixture is generated; goToSelf is emitted directly on each view POM.
}

function prepareViewObjectModelClass(
  componentName: string,
  dependencies: IComponentDependencies,
  componentHierarchyMap: Map<string, IComponentDependencies>,
  options: GenerateContentOptions = {},
) {
  const { isView, childrenComponentSet, usedComponentSet } = dependencies;
  const {
    customPomAttachments = [],
    testIdAttribute,
  } = options;

  const hasChildComponent = (needle: string) => {
    const haystack = usedComponentSet?.size ? usedComponentSet : childrenComponentSet;
    for (const child of haystack) {
      if (child === needle)
        return true;
      if (child === `${needle}.vue`)
        return true;
      if (child.endsWith(".vue") && child.slice(0, -4) === needle)
        return true;
    }
    return false;
  };

  const customPomClassIdentifierMap = options.customPomClassIdentifierMap ?? {};
  const customPomAvailableClassIdentifiers = options.customPomAvailableClassIdentifiers ?? new Set<string>();
  const customPomMethodSignaturesByClass = options.customPomMethodSignaturesByClass ?? new Map<string, CustomPomMethodSignatureMap>();

  const attachmentsForThisClass = customPomAttachments
    .filter((a) => {
      if (!Object.prototype.hasOwnProperty.call(customPomClassIdentifierMap, a.className))
        return false;

      const scope = a.attachTo ?? "views";
      const scopeMatchesBoth = scope === "both" || scope === "pagesAndComponents";
      const scopeOk = isView
        ? (scope === "views" || scopeMatchesBoth)
        : (scope === "components" || scopeMatchesBoth);
      if (!scopeOk)
        return false;
      return a.attachWhenUsesComponents.some(c => hasChildComponent(c));
    })
    .map(a => ({
      className: customPomClassIdentifierMap[a.className]!,
      propertyName: a.propertyName,
      flatten: a.flatten ?? false,
      methodSignatures: a.flatten
        ? (customPomMethodSignaturesByClass.get(a.className) ?? new Map<string, CustomPomMethodSignature>())
        : new Map<string, CustomPomMethodSignature>(),
    }));

  const widgetInstances = isView
    ? getWidgetInstancesForView(componentName, dependencies.dataTestIdSet, customPomAvailableClassIdentifiers)
    : [];

  const componentRefsForInstances = isView
    ? (usedComponentSet?.size ? usedComponentSet : childrenComponentSet)
    : childrenComponentSet;

  const className = toPascalCaseLocal(componentName);
  const childInstancePropertyNames = Array.from(componentRefsForInstances)
    .filter(child => componentHierarchyMap.has(child) && componentHierarchyMap.get(child)?.dataTestIdSet.size)
    .map(child => child.split(".vue")[0]);
  const blockedViewPassthroughMethodNames = new Set(
    attachmentsForThisClass
      .filter(a => a.flatten)
      .flatMap(a => Array.from(a.methodSignatures.keys())),
  );
  const reservedAttachmentPassthroughNames = new Set<string>([
    ...attachmentsForThisClass.map(a => a.propertyName),
    ...widgetInstances.map(w => w.propertyName),
    ...childInstancePropertyNames,
  ]);

  const members: TypeScriptClassMember[] = [];
  if (isView && (componentRefsForInstances.size > 0 || attachmentsForThisClass.length > 0 || widgetInstances.length > 0)) {
    members.push(...getComponentInstances(componentRefsForInstances, componentHierarchyMap, attachmentsForThisClass, widgetInstances));
    members.push(getConstructor(componentRefsForInstances, componentHierarchyMap, attachmentsForThisClass, widgetInstances, { testIdAttribute }));
  }
  if (!isView && attachmentsForThisClass.length > 0) {
    members.push(...getComponentInstances(new Set(), componentHierarchyMap, attachmentsForThisClass));
    members.push(getConstructor(new Set(), componentHierarchyMap, attachmentsForThisClass, [], { testIdAttribute }));
  }

  members.push(
    ...getAttachmentPassthroughMethods(componentName, dependencies, attachmentsForThisClass, reservedAttachmentPassthroughNames),
  );

  if (isView && componentRefsForInstances.size === 1) {
    members.push(
      ...getViewPassthroughMethods(
        componentName,
        dependencies,
        componentRefsForInstances,
        componentHierarchyMap,
        blockedViewPassthroughMethodNames,
      ),
    );
  }

  if (isView && options.vueRouterFluentChaining) {
    const routeMeta = options.routeMetaByComponent?.[componentName] ?? null;
    members.push(...generateRouteProperty(routeMeta));
    members.push(...generateGoToSelfMethod(className));
  }

  members.push(...generateMethodsContentForDependencies(dependencies));

  return {
    className,
    componentRefsForInstances,
    attachmentsForThisClass,
    widgetInstances,
    isView,
    members,
  };
}

function generateViewObjectModelContent(
  componentName: string,
  dependencies: IComponentDependencies,
  componentHierarchyMap: Map<string, IComponentDependencies>,
  _vueFilesPathMap: Map<string, string>,
  basePageClassPath: string,
  options: GenerateContentOptions = {},
) {
  const { filePath } = dependencies;
  const outputDir = options.outputDir ?? path.dirname(filePath);
  const prepared = prepareViewObjectModelClass(componentName, dependencies, componentHierarchyMap, options);
  const sourceRel = toPosixRelativePath(outputDir, filePath);
  const kind = prepared.isView ? "Page" : "Component";
  const doc = `/** ${kind} POM: ${componentName} (source: ${sourceRel}) */`;
  const projectRoot = options.projectRoot ?? process.cwd();
  const fromAbs = path.isAbsolute(outputDir) ? outputDir : path.resolve(projectRoot, outputDir);
  const toAbs = basePageClassPath
    ? (path.isAbsolute(basePageClassPath) ? basePageClassPath : path.resolve(projectRoot, basePageClassPath))
    : "";
  const basePageImport = path.relative(fromAbs, toAbs).replace(/\\/g, "/");
  const basePageImportNoExt = stripExtension(basePageImport).replace(/\\/g, "/");
  const basePageImportSpecifier = basePageImportNoExt.startsWith(".") ? basePageImportNoExt : `./${basePageImportNoExt}`;
  const needsPlaywrightPageImport = prepared.isView || prepared.attachmentsForThisClass.length > 0;
  const customPomImportSpecifiersByClass = options.customPomImportSpecifiersByClass ?? {};

  const customImports = Array.from(
    new Set([
      ...prepared.attachmentsForThisClass.map(attachment => attachment.className),
      ...prepared.widgetInstances.map(widget => widget.className),
    ]),
  )
    .reduce<Array<{ moduleSpecifier: string; name: string; alias?: string }>>((imports, localIdentifier) => {
      const specifier = Object.values(customPomImportSpecifiersByClass)
        .find(spec => spec.localIdentifier === localIdentifier);
      if (!specifier) {
        return imports;
      }

      imports.push({
        moduleSpecifier: stripExtension(toPosixRelativePath(fromAbs, specifier.absolutePath)),
        name: specifier.exportName,
        alias: specifier.localIdentifier !== specifier.exportName ? specifier.localIdentifier : undefined,
      });
      return imports;
    }, [])
    .sort((a, b) => (a.alias ?? a.name).localeCompare(b.alias ?? b.name));

  const generatedImports: Array<{ className: string; moduleSpecifier: string }> = [];
  const importedGeneratedClasses = new Set<string>();
  const generatedTsFilePathByComponent = options.generatedTsFilePathByComponent;

  const addGeneratedImport = (className: string) => {
    if (!generatedTsFilePathByComponent || importedGeneratedClasses.has(className) || className === componentName) {
      return;
    }
    const generatedFilePath = generatedTsFilePathByComponent.get(className);
    if (!generatedFilePath) {
      return;
    }

    generatedImports.push({
      className,
      moduleSpecifier: stripExtension(toPosixRelativePath(fromAbs, generatedFilePath)),
    });
    importedGeneratedClasses.add(className);
  };

  for (const child of prepared.componentRefsForInstances) {
    const childName = child.endsWith(".vue") ? child.slice(0, -4) : child;
    const childDeps = componentHierarchyMap.get(child) ?? componentHierarchyMap.get(childName);
    if (childDeps?.dataTestIdSet.size) {
      addGeneratedImport(childName);
    }
  }

  const targetClassNames = Array.from(
    new Set(
      Array.from(dependencies.dataTestIdSet ?? [])
        .map(entry => entry.targetPageObjectModelClass)
        .filter((target): target is string => typeof target === "string" && target.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  for (const targetClassName of targetClassNames) {
    addGeneratedImport(targetClassName);
  }

  generatedImports.sort((a, b) => a.className.localeCompare(b.className));

  const prefixText = `${buildFilePrefix({ eslintDisableSortImports: true })}${doc}\n`;
  return renderSourceFile(`${prepared.className}.ts`, (sourceFile) => {
    if (needsPlaywrightPageImport) {
      addNamedImport(sourceFile, {
        moduleSpecifier: "@playwright/test",
        isTypeOnly: true,
        namedImports: [{ name: "Page", alias: "PwPage" }],
      });
    }

    addNamedImport(sourceFile, {
      moduleSpecifier: basePageImportSpecifier,
      namedImports: ["BasePage", "Fluent"],
    });

    for (const customImport of customImports) {
      addNamedImport(sourceFile, {
        moduleSpecifier: customImport.moduleSpecifier,
        namedImports: [{ name: customImport.name, alias: customImport.alias }],
      });
    }

    for (const generatedImport of generatedImports) {
      addNamedImport(sourceFile, {
        moduleSpecifier: generatedImport.moduleSpecifier,
        namedImports: [generatedImport.className],
      });
    }

    const classDeclaration = sourceFile.addClass({
      name: prepared.className,
      isExported: true,
      extends: "BasePage",
    });

    for (const member of prepared.members) {
      addClassMember(classDeclaration, member);
    }
  }, { prefixText });
}

function getViewPassthroughMethods(
  viewName: string,
  viewDependencies: IComponentDependencies,
  childrenComponentSet: Set<string>,
  componentHierarchyMap: Map<string, IComponentDependencies>,
  blockedMethodNames: Set<string> = new Set(),
) {
  const existingOnView = viewDependencies.generatedMethods ?? new Map<string, { params: string; argNames: string[] } | null>();

  // methodName -> candidates
  const methodToChildren = new Map<string, Array<{ childProp: string; params: string; argNames: string[] }>>();

  for (const child of childrenComponentSet) {
    const childDeps = componentHierarchyMap.get(child);
    if (!childDeps || !childDeps.dataTestIdSet?.size)
      continue;

    const methods = childDeps.generatedMethods;
    if (!methods)
      continue;

    // Property name matches how we emit instance fields (strip .vue if present).
    const childProp = child.endsWith(".vue") ? child.slice(0, -4) : child;

    for (const [name, sig] of methods.entries()) {
      if (!sig)
        continue; // ambiguous on the child itself

      // If the view already has this method name, never generate a pass-through.
      if (existingOnView.has(name) || blockedMethodNames.has(name))
        continue;

      const list = methodToChildren.get(name) ?? [];
      list.push({ childProp, params: sig.params, argNames: sig.argNames });
      methodToChildren.set(name, list);
    }
  }

  const sorted = Array.from(methodToChildren.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const passthroughs = sorted.filter(([, candidates]) => candidates.length === 1);
  if (!passthroughs.length) {
    return [];
  }

  return passthroughs.map(([methodName, candidates]) => {
    const { childProp, params, argNames } = candidates[0];
    const callArgs = argNames.join(", ");
    return createClassMethod({
      name: methodName,
      isAsync: true,
      parameters: parseParameterSignatures(params),
      statements: [
        `return await this.${childProp}.${methodName}(${callArgs});`,
      ],
    });
  });
}

function getAttachmentPassthroughMethods(
  ownerName: string,
  ownerDependencies: IComponentDependencies,
  attachmentsForThisClass: ResolvedCustomPomAttachment[],
  reservedMemberNames: Set<string>,
) {
  if (!attachmentsForThisClass.some(a => a.flatten && a.methodSignatures.size > 0)) {
    return [];
  }

  const existingOnClass = ownerDependencies.generatedMethods ?? new Map<string, { params: string; argNames: string[] } | null>();
  const methodToAttachments = new Map<string, Array<{ propertyName: string; params: string; argNames: string[] }>>();

  for (const attachment of attachmentsForThisClass) {
    if (!attachment.flatten) {
      continue;
    }

    for (const [methodName, signature] of attachment.methodSignatures.entries()) {
      if (methodName === "constructor" || existingOnClass.has(methodName) || reservedMemberNames.has(methodName)) {
        continue;
      }

      const list = methodToAttachments.get(methodName) ?? [];
      list.push({
        propertyName: attachment.propertyName,
        params: signature.params,
        argNames: signature.argNames,
      });
      methodToAttachments.set(methodName, list);
    }
  }

  const sorted = Array.from(methodToAttachments.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const passthroughs = sorted.filter(([, candidates]) => candidates.length === 1);
  if (!passthroughs.length) {
    return [];
  }

  return passthroughs.map(([methodName, candidates]) => {
    const { propertyName, params, argNames } = candidates[0];
    const callArgs = argNames.join(", ");
    const invocation = callArgs
      ? `this.${propertyName}.${methodName}(${callArgs})`
      : `this.${propertyName}.${methodName}()`;
    return createClassMethod({
      name: methodName,
      parameters: parseParameterSignatures(params),
      statements: [
        `return ${invocation};`,
      ],
    });
  });
}

function sliceNodeSource(source: string, node: { start?: number | null; end?: number | null }): string | null {
  if (node.start == null || node.end == null) {
    return null;
  }

  const snippet = source.slice(node.start, node.end).trim();
  return snippet.length ? snippet : null;
}

function getCustomPomCallArgumentName(param: ClassMethod["params"][number]): string | null {
  if (param.type === "Identifier") {
    return param.name;
  }

  if (param.type === "AssignmentPattern") {
    return param.left.type === "Identifier" ? param.left.name : null;
  }

  if (param.type === "RestElement") {
    return param.argument.type === "Identifier" ? `...${param.argument.name}` : null;
  }

  return null;
}

function extractCustomPomMethodSignatures(source: string, exportName: string): CustomPomMethodSignatureMap {
  const signatures: CustomPomMethodSignatureMap = new Map();

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
  }
  catch {
    return signatures;
  }

  for (const statement of ast.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.declaration || statement.declaration.type !== "ClassDeclaration") {
      continue;
    }

    const declaration = statement.declaration;
    if (declaration.id?.name !== exportName) {
      continue;
    }

    for (const member of declaration.body.body) {
      if (member.type !== "ClassMethod" || member.kind !== "method" || member.static || member.computed) {
        continue;
      }

      if (member.accessibility === "private" || member.accessibility === "protected") {
        continue;
      }

      if (member.key.type !== "Identifier") {
        continue;
      }

      const params: string[] = [];
      const argNames: string[] = [];
      let supported = true;

      member.params.forEach((param) => {
        if (!supported) {
          return;
        }

        const paramSource = sliceNodeSource(source, param);
        const argName = getCustomPomCallArgumentName(param);
        if (!paramSource || !argName) {
          supported = false;
          return;
        }

        params.push(paramSource);
        argNames.push(argName);
      });

      if (!supported) {
        continue;
      }

      signatures.set(member.key.name, {
        params: params.join(", "),
        argNames,
      });
    }
  }

  return signatures;
}

function ensureDir(dir: string) {
  const normalized = dir.replace(/\\/g, "/");
  if (!fs.existsSync(normalized)) {
    fs.mkdirSync(normalized, { recursive: true });
  }
  return normalized;
}

function resolvePluginAsset(relative: string): string {
  try {
    return fileURLToPath(new URL(relative, import.meta.url));
  }
  catch {
    return path.resolve(__dirname, relative);
  }
}

function readTextAsset(absPath: string, description: string): string {
  try {
    return fs.readFileSync(absPath, "utf8");
  }
  catch {
    throw new VuePomGeneratorError(`Failed to read ${description} at ${absPath}`);
  }
}

function getDefaultStubMembers(): TypeScriptClassMember[] {
  return [
    createClassConstructor({
      parameters: [{ name: "page", type: "PwPage" }],
      statements: [
        "super(page);",
      ],
    }),
  ];
}

function renderSplitStubPomContent(options: {
  className: string;
  basePageImportSpecifier: string;
  childImports: Array<{ className: string; importPath: string }>;
  members: TypeScriptClassMember[];
}): string {
  const prefixText = buildFilePrefix({
    eslintDisableSortImports: true,
    commentLines: [
      `Stub POM: ${options.className}`,
      "DO NOT MODIFY BY HAND",
      "",
      "This file is auto-generated by vue-pom-generator.",
      "Changes should be made in the generator/template, not in the generated output.",
    ],
  });

  return renderSourceFile(`${options.className}.ts`, (sourceFile) => {
    addNamedImport(sourceFile, {
      moduleSpecifier: "@playwright/test",
      isTypeOnly: true,
      namedImports: [{ name: "Page", alias: "PwPage" }],
    });
    addNamedImport(sourceFile, {
      moduleSpecifier: options.basePageImportSpecifier,
      namedImports: ["BasePage"],
    });
    for (const childImport of options.childImports) {
      addNamedImport(sourceFile, {
        moduleSpecifier: childImport.importPath,
        namedImports: [childImport.className],
      });
    }
    sourceFile.addStatements(buildCommentBlock([
      "Stub POM generated because it is referenced as a navigation target but",
      "did not have any generated test ids in this build.",
    ]).trimEnd());
    const classDeclaration = sourceFile.addClass({
      name: options.className,
      isExported: true,
      extends: "BasePage",
    });
    for (const member of options.members) {
      addClassMember(classDeclaration, member);
    }
  }, { prefixText });
}

function getChildImportSpecifiers(
  outputDir: string,
  childClassNames: string[],
  generatedTsFilePathByComponent: Map<string, string>,
): Array<{ className: string; importPath: string }> {
  return childClassNames
    .map((childClassName) => {
      const childFilePath = generatedTsFilePathByComponent.get(childClassName);
      if (!childFilePath) {
        return null;
      }
      return {
        className: childClassName,
        importPath: stripExtension(toPosixRelativePath(outputDir, childFilePath)),
      };
    })
    .filter((entry): entry is { className: string; importPath: string } => !!entry)
    .sort((a, b) => a.className.localeCompare(b.className));
}

function isConstructorMember(member: TypeScriptClassMember): member is OptionalKind<ConstructorDeclarationStructure> {
  return member.kind === StructureKind.Constructor;
}

function isGetterMember(member: TypeScriptClassMember): member is OptionalKind<GetAccessorDeclarationStructure> {
  return member.kind === StructureKind.GetAccessor;
}

function isMethodMember(member: TypeScriptClassMember): member is OptionalKind<MethodDeclarationStructure> {
  return member.kind === StructureKind.Method;
}

function isPropertyMember(member: TypeScriptClassMember): member is OptionalKind<PropertyDeclarationStructure> {
  return member.kind === StructureKind.Property;
}

function addClassMember(classDeclaration: ReturnType<TypeScriptSourceFile["addClass"]>, member: TypeScriptClassMember): void {
  if (isConstructorMember(member)) {
    classDeclaration.addConstructor(member);
    return;
  }
  if (isGetterMember(member)) {
    classDeclaration.addGetAccessor(member);
    return;
  }
  if (isMethodMember(member)) {
    classDeclaration.addMethod(member);
    return;
  }
  if (isPropertyMember(member)) {
    classDeclaration.addProperty(member);
    return;
  }
  throw new Error(`Unsupported class member structure: ${String(member)}`);
}

interface RuntimeGeneratedAssetSpec {
  absolutePath: string;
  description: string;
  outputPath: string;
}

function getRuntimeGeneratedAssetSpecs(baseDir: string, basePageClassPath: string): RuntimeGeneratedAssetSpec[] {
  const runtimeDirAbs = path.join(baseDir, "_pom-runtime");
  const runtimeClassGenAbs = path.join(runtimeDirAbs, "class-generation");
  const runtimeClassGenSourceDir = resolvePluginAsset("../class-generation");
  const runtimeClassGenFiles = fs.readdirSync(runtimeClassGenSourceDir)
    .filter(file => file.endsWith(".ts"))
    .filter(file => file !== "base-page.ts" && file !== "index.ts")
    .sort((left, right) => left.localeCompare(right));

  return [
    {
      absolutePath: resolvePluginAsset("../click-instrumentation.ts"),
      description: "click-instrumentation.ts",
      outputPath: path.join(runtimeDirAbs, "click-instrumentation.ts"),
    },
    ...runtimeClassGenFiles.map(file => ({
      absolutePath: path.join(runtimeClassGenSourceDir, file),
      description: file,
      outputPath: path.join(runtimeClassGenAbs, file),
    })),
    {
      absolutePath: basePageClassPath,
      description: "base-page.ts",
      outputPath: path.join(runtimeClassGenAbs, "base-page.ts"),
    },
  ];
}

function buildRuntimeGeneratedFiles(baseDir: string, basePageClassPath: string): GeneratedFileOutput[] {
  return buildRuntimeGeneratedFilesFromSpecs(getRuntimeGeneratedAssetSpecs(baseDir, basePageClassPath));
}

function buildRuntimeGeneratedFilesFromSpecs(assetSpecs: RuntimeGeneratedAssetSpec[]): GeneratedFileOutput[] {
  return assetSpecs.map(spec => ({
    filePath: spec.outputPath,
    content: readTextAsset(spec.absolutePath, spec.description),
  }));
}

function resolveCustomPomImportResolution(
  generatedClassNames: Set<string>,
  projectRoot: string,
  options: {
    customPomDir?: GenerateFilesOptions["customPomDir"];
    customPomImportAliases?: GenerateFilesOptions["customPomImportAliases"];
    customPomImportNameCollisionBehavior?: GenerateFilesOptions["customPomImportNameCollisionBehavior"];
  } = {},
): CustomPomImportResolution {
  const importAliases: Record<string, string> = {
    Toggle: "ToggleWidget",
    Checkbox: "CheckboxWidget",
    ...(options.customPomImportAliases),
  };
  const importCollisionBehavior = options.customPomImportNameCollisionBehavior ?? "error";

  const reservedIdentifiers = new Set<string>([
    "PwLocator",
    "PwPage",
    "BasePage",
    "Fluent",
    ...generatedClassNames,
  ]);
  const usedImportIdentifiers = new Set<string>();
  const classIdentifierMap: Record<string, string> = {};
  const methodSignaturesByClass = new Map<string, CustomPomMethodSignatureMap>();
  const importSpecifiersByClass: Record<string, ResolvedCustomPomImportSpecifier> = {};

  const ensureUniqueIdentifier = (base: string) => {
    let candidate = base;
    let i = 2;
    while (reservedIdentifiers.has(candidate) || usedImportIdentifiers.has(candidate)) {
      candidate = `${base}${i}`;
      i++;
    }
    usedImportIdentifiers.add(candidate);
    return candidate;
  };

  const customDirRelOrAbs = options.customPomDir ?? "tests/playwright/pom/custom";
  const customDirAbs = path.isAbsolute(customDirRelOrAbs)
    ? customDirRelOrAbs
    : path.resolve(projectRoot, customDirRelOrAbs);

  if (!fs.existsSync(customDirAbs)) {
    return {
      classIdentifierMap,
      methodSignaturesByClass,
      availableClassIdentifiers: new Set<string>(),
      importSpecifiersByClass,
    };
  }

  const files = fs.readdirSync(customDirAbs)
    .filter(f => f.endsWith(".ts"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const exportName = file.replace(/\.ts$/i, "");
    const requested = importAliases[exportName] ?? exportName;
    const collidesWithGeneratedClass = generatedClassNames.has(requested);
    const explicitAliasProvided = Object.prototype.hasOwnProperty.call(importAliases, exportName);

    if (collidesWithGeneratedClass && importCollisionBehavior === "error") {
      throw createCustomPomImportCollisionError(exportName, requested);
    }

    let localIdentifier = requested;
    if (collidesWithGeneratedClass && importCollisionBehavior === "alias") {
      const aliasBase = explicitAliasProvided ? requested : `${exportName}Custom`;
      localIdentifier = ensureUniqueIdentifier(aliasBase);
    }
    else {
      localIdentifier = ensureUniqueIdentifier(requested);
    }

    const customFileAbs = path.join(customDirAbs, file);
    classIdentifierMap[exportName] = localIdentifier;
    importSpecifiersByClass[exportName] = {
      exportName,
      localIdentifier,
      absolutePath: customFileAbs,
    };

    const customPomMethodSignatures = extractCustomPomMethodSignatures(fs.readFileSync(customFileAbs, "utf8"), exportName);
    if (customPomMethodSignatures.size > 0) {
      methodSignaturesByClass.set(exportName, customPomMethodSignatures);
    }
  }

  return {
    classIdentifierMap,
    methodSignaturesByClass,
    availableClassIdentifiers: new Set(Object.values(classIdentifierMap)),
    importSpecifiersByClass,
  };
}

function getComposedStubBody(
  targetClassName: string,
  availableClassNames: Set<string>,
  depsByClassName: Map<string, IComponentDependencies>,
  vueFilesPathMap: Map<string, string>,
  projectRoot: string,
) {
  const filePath = resolveVueSourcePath(targetClassName, vueFilesPathMap, projectRoot);
  if (!filePath)
    return undefined;

  let source = "";
  try {
    source = fs.readFileSync(filePath, "utf8");
  }
  catch {
    return undefined;
  }

  const tags = getComponentClassNamesFromVueSource(source);
  const childClassNames = Array.from(
    new Set(
      tags
        .filter(name => availableClassNames.has(name))
        .filter(name => name !== targetClassName),
    ),
  ).sort((a, b) => a.localeCompare(b));

  if (!childClassNames.length)
    return undefined;

  const methodToChildren = new Map<string, Array<{ child: string; params: string; argNames: string[] }>>();
  for (const child of childClassNames) {
    const childDeps = depsByClassName.get(child);
    const methods = childDeps?.generatedMethods;
    if (!methods)
      continue;

    for (const [name, sig] of methods.entries()) {
      if (!sig)
        continue;
      const list = methodToChildren.get(name) ?? [];
      list.push({ child, params: sig.params, argNames: sig.argNames });
      methodToChildren.set(name, list);
    }
  }

  const passthroughMembers: TypeScriptClassMember[] = [];
  for (const [methodName, candidatesForMethod] of methodToChildren.entries()) {
    if (candidatesForMethod.length !== 1 || methodName === "constructor")
      continue;

    const { child, params, argNames } = candidatesForMethod[0];
    const callArgs = argNames.join(", ");

    passthroughMembers.push(createClassMethod({
      name: methodName,
      isAsync: true,
      parameters: parseParameterSignatures(params),
      statements: [
        `return await this.${child}.${methodName}(${callArgs});`,
      ],
    }));
  }

  return {
    childClassNames,
    members: [
      ...childClassNames.map(childClassName =>
        createClassProperty({
          name: childClassName,
          type: childClassName,
        })),
      createClassConstructor({
        parameters: [{ name: "page", type: "PwPage" }],
        statements: (writer) => {
          writer.writeLine("super(page);");
          for (const childClassName of childClassNames) {
            writer.writeLine(`this.${childClassName} = new ${childClassName}(page);`);
          }
        },
      }),
      ...passthroughMembers,
    ],
  };
}

async function generateAggregatedFiles(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  vueFilesPathMap: Map<string, string>,
  basePageClassPath: string,
  outDir: string,
  options: {
    customPomAttachments?: GenerateFilesOptions["customPomAttachments"];
    projectRoot?: GenerateFilesOptions["projectRoot"];
    customPomDir?: GenerateFilesOptions["customPomDir"];
    customPomImportAliases?: GenerateFilesOptions["customPomImportAliases"];
    customPomImportNameCollisionBehavior?: GenerateFilesOptions["customPomImportNameCollisionBehavior"];
    testIdAttribute?: GenerateFilesOptions["testIdAttribute"];
    generateFixtures?: GenerateFilesOptions["generateFixtures"];
    routeMetaByComponent?: Record<string, RouteMeta>;
    vueRouterFluentChaining?: boolean;
  } = {},
): Promise<GeneratedFileOutput[]> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const entries = Array.from(componentHierarchyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  const views = entries.filter(([, d]) => d.isView);
  const components = entries.filter(([, d]) => !d.isView);

  const makeAggregatedContent = (
    outputDir: string,
    items: Array<[string, IComponentDependencies]>,
  ) => {
    const imports: string[] = [];
    const generatedClassNames = new Set(items.map(([name]) => name));

    if (!basePageClassPath) {
      throw new Error("basePageClassPath is required for aggregated generation");
    }

    // Aggregate mode goal: consolidate all generated POM classes into one file.
    // Instead of inlining BasePage/Pointer/Callout helpers and stripping imports via regex, we
    // emit/copy those dependencies into the output folder and import them normally.
    //
    // This keeps output deterministic and avoids fragile source rewriting.
    const runtimeDirRel = "./_pom-runtime";
    const runtimeClassGenRel = `${runtimeDirRel}/class-generation`;

    imports.push(`import type { PwLocator, PwPage } from "${runtimeClassGenRel}/playwright-types";`);
    imports.push(`import { BasePage } from "${runtimeClassGenRel}/base-page";`);
    imports.push(`import type { Fluent } from "${runtimeClassGenRel}/base-page";`);
    imports.push(`export * from "${runtimeDirRel}/click-instrumentation";`);
    imports.push(`export * from "${runtimeClassGenRel}/playwright-types";`);
    imports.push(`export * from "${runtimeClassGenRel}/callout";`);
    imports.push(`export * from "${runtimeClassGenRel}/pointer";`);
    imports.push(`export * from "${runtimeClassGenRel}/base-page";`);

    const customPomImportResolution = resolveCustomPomImportResolution(generatedClassNames, projectRoot, {
      customPomDir: options.customPomDir,
      customPomImportAliases: options.customPomImportAliases,
      customPomImportNameCollisionBehavior: options.customPomImportNameCollisionBehavior,
    });
    const customPomClassIdentifierMap = customPomImportResolution.classIdentifierMap;
    const customPomMethodSignaturesByClass = customPomImportResolution.methodSignaturesByClass;
    const customPomAvailableClassIdentifiers = customPomImportResolution.availableClassIdentifiers;

    for (const importSpecifier of Object.values(customPomImportResolution.importSpecifiersByClass).sort((left, right) => left.exportName.localeCompare(right.exportName))) {
      const importPath = stripExtension(toPosixRelativePath(outputDir, importSpecifier.absolutePath));
      if (importSpecifier.localIdentifier !== importSpecifier.exportName) {
        imports.push(`import { ${importSpecifier.exportName} as ${importSpecifier.localIdentifier} } from "${importPath}";`);
        continue;
      }
      imports.push(`import { ${importSpecifier.exportName} } from "${importPath}";`);
    }

    // Collect any navigation return types referenced by generated methods so we can emit
    // stub classes when the destination view has no generated test ids (and therefore no
    // corresponding POM class in this file).
    const referencedTargets = new Set<string>();
    for (const [, deps] of items) {
      for (const dt of deps.dataTestIdSet) {
        if (dt.targetPageObjectModelClass) {
          referencedTargets.add(dt.targetPageObjectModelClass);
        }
      }
    }

    const stubTargets = Array.from(referencedTargets)
      .filter(t => !generatedClassNames.has(t))
      .sort((a, b) => a.localeCompare(b));

    const availableClassNames = new Set<string>([...generatedClassNames, ...stubTargets]);

    const depsByClassName = new Map<string, IComponentDependencies>(entries);

    const stubs = stubTargets.map(t =>
      (() => {
        const composed = getComposedStubBody(t, availableClassNames, depsByClassName, vueFilesPathMap, projectRoot);
        return {
          className: t,
          members: composed?.members ?? getDefaultStubMembers(),
          isStub: true as const,
        };
      })(),
    );

    const classes = items.map(([name, deps]) => {
      const prepared = prepareViewObjectModelClass(name, deps, componentHierarchyMap, {
        outputDir,
        outputStructure: "aggregated",
        customPomAttachments: options.customPomAttachments ?? [],
        customPomClassIdentifierMap,
        customPomAvailableClassIdentifiers,
        customPomMethodSignaturesByClass,
        testIdAttribute: options.testIdAttribute,
        vueRouterFluentChaining: options.vueRouterFluentChaining,
        routeMetaByComponent: options.routeMetaByComponent,
      });
      const sourceRel = toPosixRelativePath(outputDir, deps.filePath);
      const kind = deps.isView ? "Page" : "Component";
      return {
        className: prepared.className,
        doc: `/** ${kind} POM: ${name} (source: ${sourceRel}) */`,
        members: prepared.members,
        isStub: false as const,
      };
    });

    const prefixText = buildFilePrefix({
      referenceLib: "es2015",
      eslintDisableSortImports: true,
      commentLines: [
        "Aggregated generated POMs",
        "DO NOT MODIFY BY HAND",
        "",
        "This file is auto-generated by vue-pom-generator.",
        "Changes should be made in the generator/template, not in the generated output.",
      ],
    });

    return renderSourceFile("page-object-models.g.ts", (sourceFile) => {
      for (const line of imports) {
        sourceFile.addStatements(line);
      }

      for (const entry of [...classes, ...stubs]) {
        if (entry.isStub) {
          sourceFile.addStatements(buildCommentBlock([
            "Stub POM generated because it is referenced as a navigation target but",
            "did not have any generated test ids in this build.",
          ]).trimEnd());
        }
        else {
          sourceFile.addStatements(entry.doc);
        }

        const classDeclaration = sourceFile.addClass({
          name: entry.className,
          isExported: true,
          extends: "BasePage",
        });

        for (const member of entry.members) {
          addClassMember(classDeclaration, member);
        }
      }
    }, { prefixText });
  };

  const base = ensureDir(outDir);
  const outputFile = path.join(base, "page-object-models.g.ts");
  const content = makeAggregatedContent(path.dirname(outputFile), [...views, ...components]);

  const indexFile = path.join(base, "index.ts");
  const indexContent = renderSourceFile("index.ts", (sourceFile) => {
    addExportAll(sourceFile, "./page-object-models.g");
  }, {
    prefixText: buildFilePrefix({
      eslintDisableSortImports: true,
      commentLines: [
        "POM exports",
        "DO NOT MODIFY BY HAND",
        "",
        "This file is auto-generated by vue-pom-generator.",
        "Changes should be made in the generator/template, not in the generated output.",
      ],
    }),
  });
  const runtimeFiles = buildRuntimeGeneratedFiles(base, basePageClassPath);

  return [
    { filePath: outputFile, content },
    { filePath: indexFile, content: indexContent },
    ...runtimeFiles,
  ];
}

function createFile(filePath: string, content: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  fs.writeFileSync(filePath, content);
}

function lowerFirst(value: string): string {
  if (!value)
    return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function toPascalCaseLocal(str: string): string {
  const cleaned = (str ?? "")
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();

  if (!cleaned)
    return "";

  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const preserveInternalCaps = /[a-z][A-Z]/.test(word);
      return preserveInternalCaps
        ? upperFirst(word)
        : upperFirst(word.toLowerCase());
    })
    .join("");
}

interface WidgetInstance {
  className: "ToggleWidget" | "CheckboxWidget";
  propertyName: string;
  testId: string;
}

function getWidgetInstancesForView(
  componentName: string,
  dataTestIdSet: Set<IDataTestId>,
  availableClassIdentifiers: Set<string>,
): WidgetInstance[] {
  const out: WidgetInstance[] = [];
  const usedPropNames = new Set<string>();

  const ensureUnique = (base: string) => {
    let candidate = base;
    let i = 2;
    while (usedPropNames.has(candidate)) {
      candidate = `${base}${i}`;
      i++;
    }
    usedPropNames.add(candidate);
    return candidate;
  };

  for (const dt of dataTestIdSet) {
    const raw = dt.selectorValue.formatted;

    // Skip parameterized test ids; instance fields can't represent those ergonomically.
    if (isParameterizedPomPattern(dt.selectorValue.patternKind)) {
      continue;
    }

    const toggleSuffix = "-toggle";
    const checkboxSuffix = "-checkbox";

    let className: WidgetInstance["className"] | null = null;
    let stem = "";

    if (raw.endsWith(toggleSuffix)) {
      className = "ToggleWidget";
      stem = raw.slice(0, -toggleSuffix.length);
    }
    else if (raw.endsWith(checkboxSuffix)) {
      className = "CheckboxWidget";
      stem = raw.slice(0, -checkboxSuffix.length);
    }
    else {
      continue;
    }

    if (!availableClassIdentifiers.has(className)) {
      continue;
    }

    // Prefer stripping the view prefix (e.g. PreferencesPage-) for cleaner member names.
    const viewPrefix = `${componentName}-`;
    const descriptorRaw = stem.startsWith(viewPrefix) ? stem.slice(viewPrefix.length) : stem;
    const descriptorPascal = toPascalCaseLocal(descriptorRaw);

    if (!descriptorPascal) {
      continue;
    }

    if (className === "ToggleWidget") {
      let base = descriptorPascal.replace(/Toggle$/i, "");

      // Ergonomic naming: if a toggle name contains an "Enable..." tail, prefer that tail.
      // Example: AppPreferencesEnableSessionEmails -> enableSessionEmailsToggle
      const enableIndex = base.indexOf("Enable");
      if (enableIndex > 0) {
        base = base.slice(enableIndex);
      }

      const propBase = lowerFirst(base);
      const propName = ensureUnique(propBase ? `${propBase}Toggle` : "toggle");
      out.push({ className, propertyName: propName, testId: raw });
      continue;
    }

    // Checkbox
    const base = descriptorPascal
      .replace(/CheckBox$/i, "")
      .replace(/Checkbox$/i, "");
    const propBase = lowerFirst(base);
    const propName = ensureUnique(propBase ? `${propBase}Checkbox` : "checkbox");
    out.push({ className, propertyName: propName, testId: raw });
  }

  return out;
}

function getComponentInstances(
  childrenComponent: Set<string>,
  componentHierarchyMap: Map<string, IComponentDependencies>,
  attachmentsForThisView: Array<{ className: string; propertyName: string }> = [],
  widgetInstances: WidgetInstance[] = [],
) {
  const declarations: TypeScriptClassMember[] = [];

  for (const a of attachmentsForThisView) {
    declarations.push(createClassProperty({
      name: a.propertyName,
      type: a.className,
    }));
  }

  for (const w of widgetInstances) {
    declarations.push(createClassProperty({
      name: w.propertyName,
      type: w.className,
    }));
  }

  childrenComponent.forEach((child) => {
    if (componentHierarchyMap.has(child) && componentHierarchyMap.get(child)?.dataTestIdSet.size) {
      const childName = child.split(".vue")[0];
      declarations.push(createClassProperty({
        name: childName,
        type: childName,
      }));
    }
  });

  return declarations;
}

function getConstructor(
  childrenComponent: Set<string>,
  componentHierarchyMap: Map<string, IComponentDependencies>,
  attachmentsForThisView: Array<{ className: string; propertyName: string }> = [],
  widgetInstances: WidgetInstance[] = [],
  options?: { testIdAttribute?: string },
) {
  const attr = (options?.testIdAttribute ?? "data-testid").trim() || "data-testid";
  return createClassConstructor({
    parameters: [{ name: "page", type: "PwPage" }],
    statements: (writer) => {
      writer.writeLine(`super(page, { testIdAttribute: ${JSON.stringify(attr)} });`);

      for (const a of attachmentsForThisView) {
        writer.writeLine(`this.${a.propertyName} = new ${a.className}(page, this);`);
      }

      for (const w of widgetInstances) {
        writer.writeLine(`this.${w.propertyName} = new ${w.className}(page, ${JSON.stringify(w.testId)});`);
      }

      childrenComponent.forEach((child) => {
        if (componentHierarchyMap.has(child) && componentHierarchyMap.get(child)?.dataTestIdSet.size) {
          const childName = child.split(".vue")[0];
          writer.writeLine(`this.${childName} = new ${childName}(page);`);
        }
      });
    },
  });
}
