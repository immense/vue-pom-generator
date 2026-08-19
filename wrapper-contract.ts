import type {
  ArrowFunctionExpression,
  BlockStatement,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Node as BabelNode,
  ObjectExpression,
  ObjectMethod,
  Statement,
  VariableDeclarator,
} from "@babel/types";
import type {
  AttributeNode,
  DirectiveNode,
  ElementNode,
  RootNode,
  TemplateChildNode,
} from "@vue/compiler-core";
import type { NativeRole } from "./utils";

import { parse, parseExpression } from "@babel/parser";
import {
  isArrowFunctionExpression,
  isAssignmentExpression,
  isBlockStatement,
  isBooleanLiteral,
  isCallExpression,
  isExportDefaultDeclaration,
  isExpression,
  isExpressionStatement,
  isForInStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isImportSpecifier,
  isLogicalExpression,
  isMemberExpression,
  isObjectExpression,
  isObjectPattern,
  isObjectProperty,
  isRestElement,
  isReturnStatement,
  isStringLiteral,
  isTSAsExpression,
  isTSNonNullExpression,
  isTSTypeAssertion,
  isVariableDeclaration,
  VISITOR_KEYS,
} from "@babel/types";
import { NodeTypes } from "@vue/compiler-core";
import { parse as parseTemplate } from "@vue/compiler-dom";
import { parse as parseSfc } from "@vue/compiler-sfc";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export interface WrapperContract {
  /** One stable control role, or null when forwarding targets are non-interactive or polymorphic. */
  role: NativeRole | null;
  /** Roles in template order for every element that receives the configured test-id. */
  targetRoles: Array<NativeRole | null>;
  /** Template-relative start offsets of elements that receive the configured test-id. */
  forwardedTestIdTargetOffsets: ReadonlySet<number>;
  /** SFC-source-relative equivalents used by @vitejs/plugin-vue's compiler pass. */
  forwardedTestIdTargetSfcOffsets: ReadonlySet<number>;
  /** Targets selected by an explicit v-bind rather than Vue's implicit single-root fallthrough. */
  explicitlyForwardedTestIdTargetOffsets: ReadonlySet<number>;
  /** SFC-source-relative equivalents for explicit forwarding targets. */
  explicitlyForwardedTestIdTargetSfcOffsets: ReadonlySet<number>;
}

export interface AnalyzeWrapperContractFromSfcOptions {
  filePath: string;
  source: string;
  testIdAttribute: string;
  resolveNestedContract: (tag: string) => WrapperContract | null;
}

export interface ResolveWrapperContractForTagOptions {
  tag: string;
  vueFilesPathMap?: Map<string, string>;
  wrapperSearchRoots?: string[];
  testIdAttribute: string;
}

interface ScriptForwardingMetadata {
  inheritAttrs: boolean;
  attrsObjectNames: Set<string>;
  attrsFunctionNames: Set<string>;
}

type FunctionLike = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression | ObjectMethod;

const indexedVueSfcPathsByRoots = new Map<string, Map<string, string[]>>();
const resolvedSfcPathByLookup = new Map<string, string | null>();

function isAsciiUppercaseLetterCode(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

export function toKebabCaseTag(tag: string): string {
  let result = "";
  let previousWasSeparator = false;

  for (let i = 0; i < tag.length; i += 1) {
    const ch = tag[i]!;
    const code = ch.charCodeAt(0);

    if (ch === "_" || ch === "-" || ch === "." || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (result && !previousWasSeparator) {
        result += "-";
      }
      previousWasSeparator = true;
      continue;
    }

    const previous = i > 0 ? tag[i - 1]! : "";
    const previousCode = previous ? previous.charCodeAt(0) : 0;
    const shouldInsertSeparator = i > 0
      && isAsciiUppercaseLetterCode(code)
      && (isAsciiLetterCode(previousCode) || isAsciiDigitCode(previousCode))
      && !previousWasSeparator;

    if (shouldInsertSeparator) {
      result += "-";
    }

    result += ch.toLowerCase();
    previousWasSeparator = false;
  }

  return result;
}

export function normalizeWrapperSearchRoots(wrapperSearchRoots: string[]): string[] {
  const normalized = new Set<string>();
  for (const root of wrapperSearchRoots) {
    const resolved = path.resolve(root);
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        continue;
      }
      normalized.add(path.normalize(fs.realpathSync(resolved)));
    }
    catch {
      continue;
    }
  }
  return [...normalized];
}

function buildSearchRootsKey(searchRoots: string[]): string {
  return searchRoots.join("\n");
}

export function buildVueSfcPathIndex(searchRoots: string[]): Map<string, string[]> {
  const indexKey = buildSearchRootsKey(searchRoots);
  const existingIndex = indexedVueSfcPathsByRoots.get(indexKey);
  if (existingIndex) {
    return existingIndex;
  }

  const index = new Map<string, string[]>();
  const ignoredDirNames = new Set([
    ".git",
    ".idea",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    ".yarn",
    "coverage",
    "dist",
    "build",
    "node_modules",
    "out",
    "tmp",
  ]);

  const stack = [...searchRoots];
  const seenDirs = new Set<string>();

  while (stack.length > 0) {
    const dirPath = stack.pop()!;
    const normalizedDir = path.normalize(dirPath);
    if (seenDirs.has(normalizedDir)) {
      continue;
    }
    seenDirs.add(normalizedDir);

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    }
    catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirNames.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".vue")) {
        continue;
      }

      const matches = index.get(entry.name) ?? [];
      matches.push(fullPath);
      index.set(entry.name, matches);
    }
  }

  indexedVueSfcPathsByRoots.set(indexKey, index);
  return index;
}

export function resolveSfcPathForTag(
  tag: string,
  vueFilesPathMap?: Map<string, string>,
  wrapperSearchRoots: string[] = [],
): string | null {
  const registeredPath = vueFilesPathMap?.get(tag);
  const normalizedSearchRoots = normalizeWrapperSearchRoots(wrapperSearchRoots);
  const lookupKey = `${tag}\n${registeredPath ?? ""}\n${buildSearchRootsKey(normalizedSearchRoots)}`;
  if (resolvedSfcPathByLookup.has(lookupKey)) {
    return resolvedSfcPathByLookup.get(lookupKey) ?? null;
  }

  const candidateNames = [`${tag}.vue`, `${toKebabCaseTag(tag)}.vue`];
  const directCandidates = [
    registeredPath ? path.resolve(process.cwd(), registeredPath) : null,
    ...normalizedSearchRoots.flatMap(root => candidateNames.map(fileName => path.join(root, fileName))),
  ].filter((value): value is string => !!value);

  const directMatch = directCandidates.find(candidatePath => fs.existsSync(candidatePath));
  if (directMatch) {
    resolvedSfcPathByLookup.set(lookupKey, directMatch);
    return directMatch;
  }

  if (normalizedSearchRoots.length === 0) {
    resolvedSfcPathByLookup.set(lookupKey, null);
    return null;
  }

  const index = buildVueSfcPathIndex(normalizedSearchRoots);
  const scorePath = (candidatePath: string): [number, number, string] => {
    const rootIndex = normalizedSearchRoots.findIndex((root) => {
      return candidatePath === root || candidatePath.startsWith(root + path.sep);
    });
    const effectiveRootIndex = rootIndex === -1 ? Number.MAX_SAFE_INTEGER : rootIndex;
    const relativeLength = rootIndex === -1
      ? candidatePath.length
      : path.relative(normalizedSearchRoots[rootIndex]!, candidatePath).length;
    return [effectiveRootIndex, relativeLength, candidatePath];
  };

  let bestMatch: string | null = null;
  let bestScore: [number, number, string] | null = null;
  for (const fileName of candidateNames) {
    const matches = index.get(fileName);
    if (!matches?.length) {
      continue;
    }

    for (const match of matches) {
      const score = scorePath(match);
      if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1]) || (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])) {
        bestScore = score;
        bestMatch = match;
      }
    }
  }

  resolvedSfcPathByLookup.set(lookupKey, bestMatch);
  return bestMatch;
}

function walkBabel(node: BabelNode, visitor: (node: BabelNode) => void): void {
  visitor(node);
  const keys = VISITOR_KEYS[node.type] ?? [];
  const record = node as BabelNode & Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          walkBabel(child as BabelNode, visitor);
        }
      }
      continue;
    }
    if (value && typeof value === "object" && "type" in value) {
      walkBabel(value as BabelNode, visitor);
    }
  }
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (isTSAsExpression(current) || isTSTypeAssertion(current) || isTSNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function getStaticObjectKey(node: BabelNode): string | null {
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isStringLiteral(node)) {
    return node.value;
  }
  return null;
}

function getBooleanObjectProperty(object: ObjectExpression, propertyName: string): boolean | null {
  for (const property of object.properties) {
    if (!isObjectProperty(property) || property.computed) {
      continue;
    }
    if (getStaticObjectKey(property.key) !== propertyName || !isBooleanLiteral(property.value)) {
      continue;
    }
    return property.value.value;
  }
  return null;
}

function getOptionsObject(expression: Expression | null | undefined): ObjectExpression | null {
  if (!expression) {
    return null;
  }
  const unwrapped = unwrapExpression(expression);
  if (isObjectExpression(unwrapped)) {
    return unwrapped;
  }
  if (!isCallExpression(unwrapped) || unwrapped.arguments.length === 0) {
    return null;
  }
  const firstArgument = unwrapped.arguments[0];
  return firstArgument && isObjectExpression(firstArgument) ? firstArgument : null;
}

function parseScriptStatements(source: string, lang: string | undefined): Statement[] {
  if (!source.trim()) {
    return [];
  }
  const plugins: Array<"typescript" | "jsx" | "decorators-legacy"> = ["decorators-legacy"];
  if (lang === "ts" || lang === "tsx") {
    plugins.push("typescript");
  }
  if (lang === "jsx" || lang === "tsx") {
    plugins.push("jsx");
  }
  return parse(source, { sourceType: "module", plugins }).program.body;
}

function getFunctionBody(functionNode: FunctionLike): BlockStatement | Expression {
  return functionNode.body;
}

function findFunctionDeclarations(statements: Statement[]): Map<string, FunctionLike> {
  const functions = new Map<string, FunctionLike>();
  for (const statement of statements) {
    if (isFunctionDeclaration(statement) && statement.id) {
      functions.set(statement.id.name, statement);
      continue;
    }
    if (!isVariableDeclaration(statement)) {
      continue;
    }
    for (const declaration of statement.declarations) {
      if (!isIdentifier(declaration.id) || !declaration.init) {
        continue;
      }
      const init = isExpression(declaration.init) ? unwrapExpression(declaration.init) : declaration.init;
      if (isArrowFunctionExpression(init) || isFunctionExpression(init)) {
        functions.set(declaration.id.name, init);
      }
    }
  }
  return functions;
}

function expressionForwardsTestId(
  expression: Expression,
  testIdAttribute: string,
  attrsObjectNames: ReadonlySet<string>,
  attrsFunctionNames: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (isIdentifier(unwrapped)) {
    return attrsObjectNames.has(unwrapped.name);
  }
  if (isCallExpression(unwrapped) && isIdentifier(unwrapped.callee)) {
    return attrsFunctionNames.has(unwrapped.callee.name);
  }
  if (isObjectExpression(unwrapped)) {
    let forwards = false;
    for (const property of unwrapped.properties) {
      if (property.type === "SpreadElement") {
        forwards = isExpression(property.argument)
          && expressionForwardsTestId(property.argument, testIdAttribute, attrsObjectNames, attrsFunctionNames);
        continue;
      }

      if (property.computed) {
        forwards = false;
        continue;
      }

      if (getStaticObjectKey(property.key) === testIdAttribute) {
        forwards = isObjectProperty(property)
          && isExpression(property.value)
          && expressionReadsTestId(property.value, testIdAttribute, attrsObjectNames, attrsFunctionNames);
      }
    }
    return forwards;
  }
  return false;
}

function expressionReadsTestId(
  expression: Expression,
  testIdAttribute: string,
  attrsObjectNames: ReadonlySet<string>,
  attrsFunctionNames: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (!isMemberExpression(unwrapped) || !isExpression(unwrapped.object)) {
    return false;
  }
  if (!expressionForwardsTestId(unwrapped.object, testIdAttribute, attrsObjectNames, attrsFunctionNames)) {
    return false;
  }
  if (!unwrapped.computed && isIdentifier(unwrapped.property)) {
    return unwrapped.property.name === testIdAttribute;
  }
  return isStringLiteral(unwrapped.property) && unwrapped.property.value === testIdAttribute;
}

function collectExcludedKeys(expression: Expression, keyName: string): Set<string> | null {
  const unwrapped = unwrapExpression(expression);
  if (isLogicalExpression(unwrapped) && unwrapped.operator === "&&") {
    const left = collectExcludedKeys(unwrapped.left, keyName);
    const right = collectExcludedKeys(unwrapped.right, keyName);
    if (!left || !right) {
      return null;
    }
    return new Set([...left, ...right]);
  }
  if (unwrapped.type !== "BinaryExpression" || (unwrapped.operator !== "!==" && unwrapped.operator !== "!=")) {
    return null;
  }
  if (isIdentifier(unwrapped.left, { name: keyName }) && isStringLiteral(unwrapped.right)) {
    return new Set([unwrapped.right.value]);
  }
  if (isStringLiteral(unwrapped.left) && isIdentifier(unwrapped.right, { name: keyName })) {
    return new Set([unwrapped.left.value]);
  }
  return null;
}

function getSingleStatement(statement: Statement | BlockStatement): Statement | null {
  if (isBlockStatement(statement)) {
    return statement.body.length === 1 ? statement.body[0]! : null;
  }
  return statement;
}

function tryGetForwardedAccumulator(
  statement: Statement,
  testIdAttribute: string,
  attrsObjectNames: ReadonlySet<string>,
  attrsFunctionNames: ReadonlySet<string>,
): string | null {
  if (!isForInStatement(statement) || !isExpression(statement.right)) {
    return null;
  }
  if (!expressionForwardsTestId(statement.right, testIdAttribute, attrsObjectNames, attrsFunctionNames)) {
    return null;
  }

  let keyName: string | null = null;
  if (isVariableDeclaration(statement.left) && statement.left.declarations.length === 1) {
    const declaration = statement.left.declarations[0]!;
    keyName = isIdentifier(declaration.id) ? declaration.id.name : null;
  }
  else if (isIdentifier(statement.left)) {
    keyName = statement.left.name;
  }
  if (!keyName) {
    return null;
  }

  const bodyStatement = getSingleStatement(statement.body);
  if (!bodyStatement || !isIfStatement(bodyStatement) || !isExpression(bodyStatement.test)) {
    return null;
  }
  const excludedKeys = collectExcludedKeys(bodyStatement.test, keyName);
  if (!excludedKeys || excludedKeys.has(testIdAttribute) || bodyStatement.alternate) {
    return null;
  }

  const consequent = getSingleStatement(bodyStatement.consequent);
  if (!consequent || !isExpressionStatement(consequent) || !isAssignmentExpression(consequent.expression, { operator: "=" })) {
    return null;
  }
  const { left, right } = consequent.expression;
  if (!isMemberExpression(left) || !left.computed || !isIdentifier(left.object) || !isIdentifier(left.property, { name: keyName })) {
    return null;
  }
  if (!isMemberExpression(right) || !right.computed || !isIdentifier(right.property, { name: keyName }) || !isExpression(right.object)) {
    return null;
  }
  if (!expressionForwardsTestId(right.object, testIdAttribute, attrsObjectNames, attrsFunctionNames)) {
    return null;
  }
  return left.object.name;
}

function functionForwardsTestId(
  functionNode: FunctionLike,
  testIdAttribute: string,
  globalAttrsObjectNames: ReadonlySet<string>,
  attrsFunctionNames: ReadonlySet<string>,
): boolean {
  const body = getFunctionBody(functionNode);
  if (isExpression(body)) {
    return expressionForwardsTestId(body, testIdAttribute, globalAttrsObjectNames, attrsFunctionNames);
  }

  const localAttrsObjectNames = new Set(globalAttrsObjectNames);
  for (const statement of body.body) {
    if (isVariableDeclaration(statement)) {
      for (const declaration of statement.declarations) {
        if (isIdentifier(declaration.id) && declaration.init && isExpression(declaration.init)) {
          if (expressionForwardsTestId(declaration.init, testIdAttribute, localAttrsObjectNames, attrsFunctionNames)) {
            localAttrsObjectNames.add(declaration.id.name);
          }
          continue;
        }
        if (!isObjectPattern(declaration.id) || !declaration.init || !isExpression(declaration.init)) {
          continue;
        }
        if (!expressionForwardsTestId(declaration.init, testIdAttribute, localAttrsObjectNames, attrsFunctionNames)) {
          continue;
        }
        const excludedKeys = new Set<string>();
        let restName: string | null = null;
        for (const property of declaration.id.properties) {
          if (isRestElement(property) && isIdentifier(property.argument)) {
            restName = property.argument.name;
            continue;
          }
          if (isObjectProperty(property)) {
            const key = getStaticObjectKey(property.key);
            if (key) {
              excludedKeys.add(key);
            }
          }
        }
        if (restName && !excludedKeys.has(testIdAttribute)) {
          localAttrsObjectNames.add(restName);
        }
      }
      continue;
    }

    const accumulatorName = tryGetForwardedAccumulator(
      statement,
      testIdAttribute,
      localAttrsObjectNames,
      attrsFunctionNames,
    );
    if (accumulatorName) {
      localAttrsObjectNames.add(accumulatorName);
      continue;
    }

    if (isReturnStatement(statement) && statement.argument && isExpression(statement.argument)) {
      if (expressionForwardsTestId(statement.argument, testIdAttribute, localAttrsObjectNames, attrsFunctionNames)) {
        return true;
      }
    }
  }
  return body.body.some((statement) => {
    return isReturnStatement(statement)
      && !!statement.argument
      && isExpression(statement.argument)
      && expressionForwardsTestId(statement.argument, testIdAttribute, localAttrsObjectNames, attrsFunctionNames);
  });
}

function analyzeScriptForwardingMetadata(
  scriptBlocks: Array<{ content: string; lang?: string }>,
  testIdAttribute: string,
): ScriptForwardingMetadata {
  const statements = scriptBlocks.flatMap(block => parseScriptStatements(block.content, block.lang));
  const useAttrsCalleeNames = new Set(["useAttrs"]);
  let inheritAttrs = true;

  for (const statement of statements) {
    if (isImportDeclaration(statement) && statement.source.value === "vue") {
      for (const specifier of statement.specifiers) {
        if (isImportSpecifier(specifier) && isIdentifier(specifier.imported, { name: "useAttrs" })) {
          useAttrsCalleeNames.add(specifier.local.name);
        }
      }
    }

    if (isExportDefaultDeclaration(statement)) {
      const declaration = statement.declaration;
      const options = isExpression(declaration) ? getOptionsObject(declaration) : null;
      const configured = options ? getBooleanObjectProperty(options, "inheritAttrs") : null;
      if (configured !== null) {
        inheritAttrs = configured;
      }
    }
  }

  for (const statement of statements) {
    walkBabel(statement, (node) => {
      if (!isCallExpression(node) || !isIdentifier(node.callee, { name: "defineOptions" })) {
        return;
      }
      const options = node.arguments[0];
      if (!options || !isObjectExpression(options)) {
        return;
      }
      const configured = getBooleanObjectProperty(options, "inheritAttrs");
      if (configured !== null) {
        inheritAttrs = configured;
      }
    });
  }

  const attrsObjectNames = new Set(["$attrs"]);
  for (const statement of statements) {
    walkBabel(statement, (node) => {
      if (node.type !== "VariableDeclarator") {
        return;
      }
      const declaration = node as VariableDeclarator;
      if (!declaration.init || !isCallExpression(declaration.init)) {
        return;
      }
      if (!isIdentifier(declaration.init.callee) || !useAttrsCalleeNames.has(declaration.init.callee.name)) {
        return;
      }
      if (isIdentifier(declaration.id)) {
        attrsObjectNames.add(declaration.id.name);
        return;
      }
      if (!isObjectPattern(declaration.id)) {
        return;
      }
      const excludedKeys = new Set<string>();
      let restName: string | null = null;
      for (const property of declaration.id.properties) {
        if (isRestElement(property) && isIdentifier(property.argument)) {
          restName = property.argument.name;
          continue;
        }
        if (isObjectProperty(property)) {
          const key = getStaticObjectKey(property.key);
          if (key) {
            excludedKeys.add(key);
          }
        }
      }
      if (restName && !excludedKeys.has(testIdAttribute)) {
        attrsObjectNames.add(restName);
      }
    });
  }

  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const statement of statements) {
      if (!isVariableDeclaration(statement)) {
        continue;
      }
      for (const declaration of statement.declarations) {
        if (!isIdentifier(declaration.id) || attrsObjectNames.has(declaration.id.name) || !declaration.init || !isExpression(declaration.init)) {
          continue;
        }
        if (expressionForwardsTestId(declaration.init, testIdAttribute, attrsObjectNames, new Set())) {
          attrsObjectNames.add(declaration.id.name);
          aliasesChanged = true;
        }
      }
    }
  }

  const functions = findFunctionDeclarations(statements);
  const attrsFunctionNames = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, functionNode] of functions) {
      if (attrsFunctionNames.has(name)) {
        continue;
      }
      if (functionForwardsTestId(functionNode, testIdAttribute, attrsObjectNames, attrsFunctionNames)) {
        attrsFunctionNames.add(name);
        changed = true;
      }
    }
  }

  return { inheritAttrs, attrsObjectNames, attrsFunctionNames };
}

function getStaticAttributeContent(element: ElementNode, name: string): string | null {
  const attribute = element.props.find((prop): prop is AttributeNode => {
    return prop.type === NodeTypes.ATTRIBUTE && prop.name === name;
  });
  return attribute?.value?.content?.trim() || null;
}

function mapExplicitAriaRole(role: string): NativeRole | null {
  switch (role.toLowerCase()) {
    case "button":
    case "checkbox":
    case "grid":
    case "link":
    case "radio":
    case "tab":
      return role.toLowerCase() as NativeRole;
    case "radiogroup":
      return "radio";
    case "combobox":
    case "listbox":
      return "select";
    case "searchbox":
    case "spinbutton":
    case "textbox":
      return "input";
    case "switch":
      return "toggle";
    default:
      return null;
  }
}

function hasAttribute(element: ElementNode, name: string): boolean {
  return element.props.some((prop) => {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      return prop.name === name;
    }
    return prop.type === NodeTypes.DIRECTIVE
      && prop.name === "bind"
      && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && prop.arg.content === name;
  });
}

export function getElementControlRole(element: ElementNode): NativeRole | null {
  const explicitRole = getStaticAttributeContent(element, "role");
  if (explicitRole) {
    return mapExplicitAriaRole(explicitRole);
  }

  const tag = element.tag.toLowerCase();
  const type = (getStaticAttributeContent(element, "type") || "").toLowerCase();
  if (tag === "input" || tag === "uinput") {
    if (type === "radio") {
      return "radio";
    }
    if (type === "checkbox") {
      return "checkbox";
    }
    return "input";
  }
  if (tag === "textarea" || tag === "utextarea") {
    return "input";
  }
  if (tag === "select" || tag === "uselect") {
    return "select";
  }
  if (tag === "vselect") {
    return "vselect";
  }
  if (tag === "button" || tag === "ubutton") {
    return "button";
  }
  if (tag === "router-link" || tag === "routerlink") {
    return "link";
  }
  if ((tag === "a" || tag === "ua") && hasAttribute(element, "href")) {
    return "link";
  }
  return null;
}

function isComponentLikeTag(tag: string): boolean {
  if (!tag) {
    return false;
  }
  return isAsciiUppercaseLetterCode(tag.charCodeAt(0)) || tag.includes("-");
}

function parseTemplateExpression(source: string): Expression | null {
  try {
    return parseExpression(source, { plugins: ["typescript"] });
  }
  catch {
    return null;
  }
}

function directiveExpressionSource(directive: DirectiveNode): string {
  if (!directive.exp) {
    return "";
  }
  return directive.exp.loc?.source || (directive.exp.type === NodeTypes.SIMPLE_EXPRESSION ? directive.exp.content : "");
}

function elementExplicitlyForwardsTestId(
  element: ElementNode,
  testIdAttribute: string,
  scriptMetadata: ScriptForwardingMetadata,
): boolean {
  for (const prop of element.props) {
    if (prop.type !== NodeTypes.DIRECTIVE || prop.name !== "bind" || !prop.exp) {
      continue;
    }
    const source = directiveExpressionSource(prop);
    const expression = parseTemplateExpression(source);
    if (!expression) {
      continue;
    }

    if (!prop.arg) {
      if (expressionForwardsTestId(expression, testIdAttribute, scriptMetadata.attrsObjectNames, scriptMetadata.attrsFunctionNames)) {
        return true;
      }
      continue;
    }

    if (prop.arg.type === NodeTypes.SIMPLE_EXPRESSION
      && prop.arg.isStatic
      && prop.arg.content === testIdAttribute
      && expressionReadsTestId(expression, testIdAttribute, scriptMetadata.attrsObjectNames, scriptMetadata.attrsFunctionNames)) {
      return true;
    }
  }
  return false;
}

function walkTemplate(node: RootNode | TemplateChildNode, visitor: (element: ElementNode) => void): void {
  if (node.type === NodeTypes.ELEMENT) {
    visitor(node);
    for (const child of node.children) {
      walkTemplate(child, visitor);
    }
    return;
  }
  if (node.type === NodeTypes.ROOT) {
    for (const child of node.children) {
      walkTemplate(child, visitor);
    }
  }
}

function getRenderedRootElements(ast: RootNode): ElementNode[] {
  const rendered = ast.children.filter((child) => {
    return child.type !== NodeTypes.COMMENT
      && !(child.type === NodeTypes.TEXT && child.content.trim() === "");
  });
  if (rendered.length !== 1 || rendered[0]?.type !== NodeTypes.ELEMENT || rendered[0].tag === "template") {
    return [];
  }
  return [rendered[0]];
}

export function analyzeWrapperContractFromSfc(options: AnalyzeWrapperContractFromSfcOptions): WrapperContract {
  const { descriptor } = parseSfc(options.source, { filename: options.filePath });
  const template = descriptor.template?.content ?? "";
  if (!template.trim()) {
    return {
      role: null,
      targetRoles: [],
      forwardedTestIdTargetOffsets: new Set(),
      forwardedTestIdTargetSfcOffsets: new Set(),
      explicitlyForwardedTestIdTargetOffsets: new Set(),
      explicitlyForwardedTestIdTargetSfcOffsets: new Set(),
    };
  }

  const scriptMetadata = analyzeScriptForwardingMetadata(
    [descriptor.script, descriptor.scriptSetup]
      .filter((block): block is NonNullable<typeof block> => !!block)
      .map(block => ({ content: block.content, lang: block.lang })),
    options.testIdAttribute,
  );
  const ast = parseTemplate(template, { comments: false });
  const targets = new Map<number, ElementNode>();
  const explicitTargetOffsets = new Set<number>();

  if (scriptMetadata.inheritAttrs) {
    for (const element of getRenderedRootElements(ast)) {
      targets.set(element.loc.start.offset, element);
    }
  }

  walkTemplate(ast, (element) => {
    if (elementExplicitlyForwardsTestId(element, options.testIdAttribute, scriptMetadata)) {
      targets.set(element.loc.start.offset, element);
      explicitTargetOffsets.add(element.loc.start.offset);
    }
  });

  const targetRoles = [...targets.values()].map((element) => {
    const directRole = getElementControlRole(element);
    if (directRole) {
      return directRole;
    }
    if (isComponentLikeTag(element.tag)) {
      return options.resolveNestedContract(element.tag)?.role ?? null;
    }
    return null;
  });
  const uniqueRoles = new Set(targetRoles);
  const role = uniqueRoles.size === 1 && !uniqueRoles.has(null)
    ? targetRoles[0] ?? null
    : null;
  const templateContentStartOffset = descriptor.template?.loc.start.offset ?? 0;
  const toSfcOffsets = (offsets: Iterable<number>) => new Set(
    [...offsets].map(offset => offset + templateContentStartOffset),
  );

  return {
    role,
    targetRoles,
    forwardedTestIdTargetOffsets: new Set(targets.keys()),
    forwardedTestIdTargetSfcOffsets: toSfcOffsets(targets.keys()),
    explicitlyForwardedTestIdTargetOffsets: explicitTargetOffsets,
    explicitlyForwardedTestIdTargetSfcOffsets: toSfcOffsets(explicitTargetOffsets),
  };
}

export function resolveWrapperContractForTag(options: ResolveWrapperContractForTagOptions): WrapperContract | null {
  const normalizedSearchRoots = normalizeWrapperSearchRoots(options.wrapperSearchRoots ?? []);
  const memo = new Map<string, WrapperContract | null>();
  const resolving = new Set<string>();

  const resolveTag = (tag: string): WrapperContract | null => {
    const first = tag.charCodeAt(0);
    if (!isAsciiUppercaseLetterCode(first) && !tag.includes("-")) {
      return null;
    }
    const filePath = resolveSfcPathForTag(tag, options.vueFilesPathMap, normalizedSearchRoots);
    if (!filePath) {
      return null;
    }
    const normalizedPath = path.normalize(filePath);
    if (memo.has(normalizedPath)) {
      return memo.get(normalizedPath) ?? null;
    }
    if (resolving.has(normalizedPath)) {
      return null;
    }

    const source = fs.readFileSync(normalizedPath, "utf8");

    resolving.add(normalizedPath);
    try {
      const contract = analyzeWrapperContractFromSfc({
        filePath: normalizedPath,
        source,
        testIdAttribute: options.testIdAttribute,
        resolveNestedContract: resolveTag,
      });
      memo.set(normalizedPath, contract);
      return contract;
    }
    finally {
      resolving.delete(normalizedPath);
    }
  };

  return resolveTag(options.tag);
}

export function resetWrapperContractCaches(): void {
  indexedVueSfcPathsByRoots.clear();
  resolvedSfcPathByLookup.clear();
}
