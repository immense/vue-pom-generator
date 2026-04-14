import type {
  ElementNode,
  NodeTransform,
  RootNode,
  TemplateChildNode,
  AttributeNode,
  DirectiveNode,
  SimpleExpressionNode,
  CompoundExpressionNode,
  IfNode,
  IfBranchNode,
  ForNode,
} from "@vue/compiler-core";
import type { AttributeValue, HierarchyMap } from "./utils";
import { NodeTypes, stringifyExpression } from "@vue/compiler-core";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { parse as parseTemplate } from "@vue/compiler-dom";
import { parseExpression } from "@babel/parser";
import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { TESTID_CLICK_EVENT_NAME, TESTID_CLICK_EVENT_STRICT_FLAG } from "./click-instrumentation";
import {
  isAsciiDigitCode,
  isAsciiLetterCode,
  isAsciiUppercaseLetterCode,
  upsertAttribute,
  findTestIdAttribute,
  formatTagName,
  getComposedClickHandlerContent,
  getIdOrName,
  getInnerText,
   getContainedInVForDirectiveKeyValue,
   getContainedInSlotDataKeyValue,
   tryGetContainedInStaticVForSourceLiteralValues,
   getKeyDirectiveValue,
   getModelBindingValues,
   getNativeWrapperTransformInfo,
   nodeHandlerAttributeValue,
   nodeHandlerAttributeInfo,
   tryGetClickDirective,
  nodeHasToDirective,
  generateToDirectiveDataTestId,
  toDirectiveObjectFieldNameValue,
  staticAttributeValue,
  templateAttributeValue,
  toPascalCase,
  tryResolveToDirectiveTargetComponentName,
  IDataTestId,
  IComponentDependencies,
  NativeWrappersMap,
  NativeRole,
  applyResolvedDataTestId,
  tryGetExistingElementDataTestId,
} from "./utils";

const CLICK_EVENT_NAME = TESTID_CLICK_EVENT_NAME;
const ENABLE_CLICK_INSTRUMENTATION = true;
// Cache inferred wrapper configs across transforms/build passes.
const inferredNativeWrapperConfigByLookup = new Map<string, { role: string }>();
const inferredSfcPathByLookup = new Map<string, string | null>();
const indexedVueSfcPathsByRoots = new Map<string, Map<string, string[]>>();

function toKebabCaseTag(tag: string): string {
  let result = "";
  let previousWasSeparator = false;

  for (let i = 0; i < tag.length; i += 1) {
    const ch = tag[i];
    const code = ch.charCodeAt(0);

    if (ch === "_" || ch === "-" || ch === "." || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (result && !previousWasSeparator) {
        result += "-";
      }
      previousWasSeparator = true;
      continue;
    }

    const previous = i > 0 ? tag[i - 1] : "";
    const previousCode = previous ? previous.charCodeAt(0) : 0;
    const hasPrevious = i > 0;
    const shouldInsertSeparator = hasPrevious
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

function getStaticAttributeContent(element: ElementNode, name: string): string | null {
  const attr = element.props.find((prop): prop is AttributeNode => {
    return prop.type === NodeTypes.ATTRIBUTE && prop.name === name;
  });

  return attr?.value?.content?.trim() || null;
}

function getNativeHtmlControlRole(element: ElementNode): NativeRole | null {
  const tag = (element.tag || "").toLowerCase();
  const type = (getStaticAttributeContent(element, "type") || "").toLowerCase();

  if (tag === "textarea") {
    return "input";
  }

  if (tag === "select") {
    return "select";
  }

  if (tag !== "input") {
    return null;
  }

  if (type === "radio") {
    return "radio";
  }

  if (type === "checkbox") {
    return "checkbox";
  }

  return "input";
}

/**
 * Normalizes label text into the stable string used for generated control names.
 *
 * This operates on plain UI text, not source code, so the regex usage is intentionally scoped
 * to this helper instead of adding broader string-scanning logic.
 */
/* eslint-disable no-restricted-syntax -- allowed: regex is restricted for source parsing, but this helper only normalizes plain UI label text */
function normalizeControlLabelText(value: string | null): string | null {
  const normalized = (value ?? "")
    .replace(/\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || null;
}
/* eslint-enable no-restricted-syntax */

function getLabelNodeText(labelNode: ElementNode): string | null {
  for (const child of labelNode.children || []) {
    if (child.type === NodeTypes.TEXT) {
      const normalized = normalizeControlLabelText(child.content);
      if (normalized) {
        return normalized;
      }
      continue;
    }

    if (child.type !== NodeTypes.ELEMENT) {
      continue;
    }

    if (getNativeHtmlControlRole(child)) {
      continue;
    }

    const normalized = normalizeControlLabelText(getInnerText(child));
    if (normalized) {
      return normalized;
    }
  }

  return normalizeControlLabelText(getInnerText(labelNode));
}

function getAssociatedLabelText(element: ElementNode, hierarchyMap: HierarchyMap): string | null {
  let parent = hierarchyMap.get(element) || null;
  while (parent) {
    if (parent.tag === "label") {
      return getLabelNodeText(parent);
    }

    parent = hierarchyMap.get(parent) || null;
  }

  const id = getStaticAttributeContent(element, "id");
  if (!id) {
    return null;
  }

  const candidates = new Set<ElementNode>();
  for (const child of hierarchyMap.keys()) {
    candidates.add(child);
  }
  for (const maybeParent of hierarchyMap.values()) {
    if (maybeParent) {
      candidates.add(maybeParent);
    }
  }

  for (const candidate of candidates) {
    if (candidate.tag !== "label") {
      continue;
    }

    if (getStaticAttributeContent(candidate, "for") === id) {
      return getLabelNodeText(candidate);
    }
  }

  return null;
}

// Internal exports for unit testing (not part of the public plugin API).
export const __internal = {
  normalizeControlLabelText,
};

function normalizeSearchRoots(wrapperSearchRoots: string[]): string[] {
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

function buildVueSfcPathIndex(searchRoots: string[]): Map<string, string[]> {
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

function tryResolveSfcPathForTag(
  tag: string,
  vueFilesPathMap?: Map<string, string>,
  wrapperSearchRoots: string[] = [],
): string | null {
  const registeredPath = vueFilesPathMap?.get(tag);
  const normalizedSearchRoots = normalizeSearchRoots(wrapperSearchRoots);
  const lookupKey = `${tag}\n${registeredPath ?? ""}\n${buildSearchRootsKey(normalizedSearchRoots)}`;
  if (inferredSfcPathByLookup.has(lookupKey)) {
    return inferredSfcPathByLookup.get(lookupKey) ?? null;
  }

  const candidateNames = [`${tag}.vue`, `${toKebabCaseTag(tag)}.vue`];
  const directCandidates = [
    registeredPath ? path.resolve(process.cwd(), registeredPath) : null,
    ...normalizedSearchRoots.flatMap(root => candidateNames.map(fileName => path.join(root, fileName))),
  ].filter((value): value is string => !!value);

  const directMatch = directCandidates.find(candidatePath => fs.existsSync(candidatePath));
  if (directMatch) {
    inferredSfcPathByLookup.set(lookupKey, directMatch);
    return directMatch;
  }

  if (normalizedSearchRoots.length === 0) {
    inferredSfcPathByLookup.set(lookupKey, null);
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
      : path.relative(normalizedSearchRoots[rootIndex], candidatePath).length;
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

  inferredSfcPathByLookup.set(lookupKey, bestMatch);
  return bestMatch;
}

function trimLeadingSeparators(value: string): string {
  if (!value) {
    return "";
  }
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "-" || ch === "_" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    break;
  }
  return value.slice(i);
}

function getConditionalDirectiveInfo(element: ElementNode): { kind: "if" | "else-if" | "else"; source: string } | null {
  const directive = element.props.find((p): p is DirectiveNode => {
    return p.type === NodeTypes.DIRECTIVE && (p.name === "if" || p.name === "else-if" || p.name === "else" || p.name === "elseif");
  });

  if (!directive)
    return null;

  // Some compiler versions/paths represent `v-else-if` as directive.name === "else" with an expression.
  if (directive.name === "else") {
    const exp = directive.exp;
    if (exp && (exp.type === NodeTypes.SIMPLE_EXPRESSION || exp.type === NodeTypes.COMPOUND_EXPRESSION)) {
      const source = (exp.type === NodeTypes.SIMPLE_EXPRESSION
        ? (exp as SimpleExpressionNode).content
        : stringifyExpression(exp)).trim();
      return { kind: "else-if", source };
    }
    return { kind: "else", source: "" };
  }

  // Alternate naming for else-if.
  if (directive.name === "elseif") {
    const exp = directive.exp;
    if (!exp || (exp.type !== NodeTypes.SIMPLE_EXPRESSION && exp.type !== NodeTypes.COMPOUND_EXPRESSION))
      return null;
    const source = (exp.type === NodeTypes.SIMPLE_EXPRESSION
      ? (exp as SimpleExpressionNode).content
      : stringifyExpression(exp)).trim();
    return { kind: "else-if", source };
  }

  const exp = directive.exp;
  if (!exp || (exp.type !== NodeTypes.SIMPLE_EXPRESSION && exp.type !== NodeTypes.COMPOUND_EXPRESSION))
    return null;

  const source = (exp.type === NodeTypes.SIMPLE_EXPRESSION
    ? (exp as SimpleExpressionNode).content
    : stringifyExpression(exp)).trim();
  return { kind: directive.name as "if" | "else-if", source };
}

function tryExtractStableHintFromConditionalExpressionSource(source: string): string | null {
  const src = (source ?? "").trim();
  if (!src)
    return null;

  const isIdentifierish = (value: string): boolean => {
    const v = value.trim();
    if (!v)
      return false;
    const isUnderscore = (ch: number) => ch === 95;

    const first = v.charCodeAt(0);
    if (!isAsciiLetterCode(first))
      return false;

    for (let i = 1; i < v.length; i += 1) {
      const ch = v.charCodeAt(i);
      if (isAsciiLetterCode(ch) || isAsciiDigitCode(ch) || isUnderscore(ch)) {
        continue;
      }
      return false;
    }
    return true;
  };

  try {
    const expr = parseExpression(src, { plugins: ["typescript"] }) as object;

    const isNodeType = (n: object | null, type: string): n is { type: string } => {
      return n !== null && (n as { type?: string }).type === type;
    };
    const isStringLiteralNode = (n: object | null): n is { type: "StringLiteral"; value: string } => {
      return isNodeType(n, "StringLiteral") && typeof (n as { value?: string }).value === "string";
    };
    const isIdentifierNode = (n: object | null): n is { type: "Identifier"; name: string } => {
      return isNodeType(n, "Identifier") && typeof (n as { name?: string }).name === "string";
    };

    const results: string[] = [];

    const walk = (n: object | null) => {
      if (!n)
        return;

      if (isStringLiteralNode(n)) {
        const v = (n.value ?? "").trim();
        if (isIdentifierish(v)) {
          results.push(v);
        }
      }

      if (isIdentifierNode(n)) {
        const v = (n.name ?? "").trim();
        if (isIdentifierish(v)) {
          results.push(v);
        }
      }

      const node = n as Record<string, unknown>;
      for (const value of Object.values(node)) {
        if (!value)
          continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === "object") {
              walk(item as object);
            }
          }
          continue;
        }
        if (typeof value === "object") {
          walk(value as object);
        }
      }
    };

    walk(expr);
    return results.length ? results[results.length - 1]! : null;
  }
  catch {
    return null;
  }
}

function tryInferNativeWrapperRoleFromSfc(
  tag: string,
  vueFilesPathMap?: Map<string, string>,
  wrapperSearchRoots: string[] = [],
  seenTags: Set<string> = new Set(),
): { role: NativeRole } | null {
  // Only attempt inference for PascalCase component tags.
  const first = tag.charCodeAt(0);
  const isUpper = isAsciiUppercaseLetterCode(first);
  if (!isUpper)
    return null;

  if (seenTags.has(tag)) {
    return null;
  }

  const normalizedSearchRoots = normalizeSearchRoots(wrapperSearchRoots);
  const cacheKey = `${tag}\n${vueFilesPathMap?.get(tag) ?? ""}\n${buildSearchRootsKey(normalizedSearchRoots)}`;
  const cached = inferredNativeWrapperConfigByLookup.get(cacheKey);
  if (cached)
    return cached.role ? cached as { role: NativeRole } : null;

  const filePath = tryResolveSfcPathForTag(tag, vueFilesPathMap, normalizedSearchRoots);
  if (!filePath) {
    inferredNativeWrapperConfigByLookup.set(cacheKey, { role: "" });
    return null;
  }

  let source = "";
  try {
    source = fs.readFileSync(filePath, "utf8");
  }
  catch {
    inferredNativeWrapperConfigByLookup.set(cacheKey, { role: "" });
    return null;
  }

  // Parse the SFC and walk the template AST to find the first inferable interactive primitive,
  // following local wrapper components recursively when needed.
  let template = "";
  try {
    const { descriptor } = parseSfc(source, { filename: filePath });
    template = descriptor.template?.content ?? "";
  }
  catch {
    inferredNativeWrapperConfigByLookup.set(cacheKey, { role: "" });
    return null;
  }

  if (!template.trim()) {
    inferredNativeWrapperConfigByLookup.set(cacheKey, { role: "" });
    return null;
  }

  try {
    const ast = parseTemplate(template, { comments: false });

    const nextSeen = new Set(seenTags);
    nextSeen.add(tag);

    const isComponentLikeTag = (value: string) => {
      if (!value)
        return false;
      const code = value.charCodeAt(0);
      return isAsciiUppercaseLetterCode(code) || value.includes("-");
    };

    const getStaticTypeAttribute = (element: ElementNode): string => {
      const typeAttr = element.props.find((prop): prop is AttributeNode => {
        return prop.type === NodeTypes.ATTRIBUTE && prop.name === "type";
      });
      return (typeAttr?.value?.content ?? "").toLowerCase();
    };

    type InferableNode = RootNode | TemplateChildNode | IfBranchNode;

    let inferRoleFromNode: (node: InferableNode) => { role: NativeRole } | null;

    const inferRoleFromElement = (element: ElementNode): { role: NativeRole } | null => {
      const elementTag = (element.tag || "").toLowerCase();
      const inputType = getStaticTypeAttribute(element);

      if (elementTag === "input" || elementTag === "uinput") {
        if (inputType === "radio")
          return { role: "radio" };
        if (inputType === "checkbox")
          return { role: "checkbox" };
        return { role: "input" };
      }
      if (elementTag === "textarea" || elementTag === "utextarea")
        return { role: "input" };
      if (elementTag === "select" || elementTag === "uselect")
        return { role: "select" };
      if (elementTag === "vselect")
        return { role: "vselect" };
      if (elementTag === "button" || elementTag === "ubutton")
        return { role: "button" };

      if (isComponentLikeTag(element.tag) && element.tag !== tag) {
        const nested = tryInferNativeWrapperRoleFromSfc(element.tag, vueFilesPathMap, normalizedSearchRoots, nextSeen);
        if (nested)
          return nested;
      }

      for (const child of element.children ?? []) {
        const inferred = inferRoleFromNode(child);
        if (inferred)
          return inferred;
      }

      return null;
    };

    inferRoleFromNode = (node: InferableNode): { role: NativeRole } | null => {
      if (!node || typeof node !== "object")
        return null;

      if (node.type === NodeTypes.ELEMENT) {
        return inferRoleFromElement(node as ElementNode);
      }

      if (node.type === NodeTypes.ROOT || node.type === NodeTypes.IF_BRANCH || node.type === NodeTypes.FOR) {
        for (const child of node.children ?? []) {
          const inferred = inferRoleFromNode(child);
          if (inferred)
            return inferred;
        }
        return null;
      }

      if (node.type === NodeTypes.IF) {
        for (const branch of node.branches ?? []) {
          const inferred = inferRoleFromNode(branch);
          if (inferred)
            return inferred;
        }
      }

      return null;
    };

    const inferred = inferRoleFromNode(ast);
    if (inferred) {
      inferredNativeWrapperConfigByLookup.set(cacheKey, inferred);
      return inferred;
    }
  }
  catch {
    inferredNativeWrapperConfigByLookup.set(cacheKey, { role: "" });
    return null;
  }

  inferredNativeWrapperConfigByLookup.set(cacheKey, { role: "" });
  return null;
}

function tryWrapClickDirectiveForTestEvents(element: ElementNode, testIdAttribute: string): void {
  const jsStringLiteral = (value: string) => {
    // Use JSON.stringify to safely escape quotes/newlines.
    return JSON.stringify(value);
  };

  // Prefer using the template node's data-testid (static or bound) so wrapper components
  // like <AppButton data-testid="..."> still emit the expected id even though the
  // underlying DOM <button> doesn't have the attribute.
  const getTestIdExpressionForNode = (): string => {
    const existing = findTestIdAttribute(element, testIdAttribute);
    if (!existing) {
      return "undefined";
    }

    if (existing.type === NodeTypes.ATTRIBUTE) {
      const v = existing.value?.content;
      if (!v) {
        return "undefined";
      }
      return jsStringLiteral(v);
    }

    // :<attr>="..." / v-bind:<attr>="..."
    const directive = existing as DirectiveNode;
    const exp = directive.exp;
    if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION) {
      return "undefined";
    }
    const content = (exp.content ?? "").trim();
    if (!content) {
      return "undefined";
    }
    // Use the bound expression verbatim; it will be evaluated in the same scope as the handler.
    return `(${content})`;
  };

  const testIdExpression = getTestIdExpressionForNode();

  // Find @click / v-on:click directive.
  const clickDirective = tryGetClickDirective(element);

  if (!clickDirective)
    return;

  // Mark nodes whose click handlers we instrument so the Playwright runtime can
  // deterministically decide whether it should wait for the event.
  // (Avoids env-var gating and avoids waiting on clicks that aren't instrumented.)
  const hasInstrumentedAttr = element.props.some(p => p.type === NodeTypes.ATTRIBUTE && p.name === "data-click-instrumented");
  if (!hasInstrumentedAttr) {
    upsertAttribute(element, "data-click-instrumented", staticAttributeValue("1"));
  }

  const exp = clickDirective.exp;
  if (!exp)
    return;

  // Avoid double-wrapping if transform runs multiple times (SSR + client passes).
  const existingSource = (exp.loc?.source ?? (exp.type === NodeTypes.SIMPLE_EXPRESSION ? exp.content : "")).trim();
  if (existingSource.includes(CLICK_EVENT_NAME))
    return;

  // Best-effort extract of the original handler expression.
  // For SIMPLE_EXPRESSION, prefer content; otherwise fall back to loc.source.
  const originalExpression = (exp.type === NodeTypes.SIMPLE_EXPRESSION ? exp.content : exp.loc?.source ?? "").trim();
  if (!originalExpression)
    return;

  // Vue treats v-on expressions as raw statements in many cases (e.g. multiline @click with `if (...) ...`).
  // Our wrapper must preserve that capability; otherwise the Vue compiler will try to parse statements as
  // an expression and fail.
  const isStatementBody = (() => {
    const v = originalExpression.trim();
    if (!v)
      return false;

    // Prefer AST parsing over string heuristics.
    // - If the handler parses as an expression, we can treat it as an expression body.
    // - If it fails to parse as an expression (e.g. `if (...) ...`, `foo(); bar();`, `{ ... }` block),
    //   Vue expects statement semantics.
    try {
      parseExpression(v, { plugins: ["typescript"] });
      return false;
    }
    catch {
      return true;
    }
  })();

  // Wrap in an arrow to preserve $event semantics.
  // We intentionally read the test id at runtime from the event target rather than trying to
  // statically embed it. NOTE: wrapper components often don't forward data-testid to the actual DOM.
  // We therefore prefer the template node's data-testid expression, with an event-target fallback.
  const statementWrappedHandler = `($event) => {
  const __win = ($event && $event.view) ? $event.view : undefined;
  const __target = ($event && $event.currentTarget) ? $event.currentTarget : undefined;
  const __testIdFromNode = ${testIdExpression};
  const __testIdFromTarget = (__target && typeof __target.getAttribute === 'function') ? __target.getAttribute(${jsStringLiteral(testIdAttribute)}) : undefined;
  const __testId = (__testIdFromNode ?? __testIdFromTarget);
  const __emit = (phase, err) => {
    try {
      const __w = __win || (__target && __target.ownerDocument && __target.ownerDocument.defaultView);
      const __CustomEvent = __w && __w.CustomEvent;
      if (__w && typeof __w.dispatchEvent === 'function' && __CustomEvent) {
        __w.dispatchEvent(new __CustomEvent('${CLICK_EVENT_NAME}', { detail: { testId: __testId, phase, err: err ? String(err) : undefined } }));
      }
    } catch (e) {
      // Instrumentation must never hide failures during e2e strict mode.
      // In strict mode we rethrow so tests fail fast and the underlying problem is visible.
      // Outside strict mode we log and continue so we don't break real user clicks.
      const __w = __win || (__target && __target.ownerDocument && __target.ownerDocument.defaultView);
      if (__w && __w.console && typeof __w.console.error === 'function') {
        __w.console.error('[testid-click-event] failed to emit ${CLICK_EVENT_NAME}', e);
      }
      if (__w && (__w[${JSON.stringify(TESTID_CLICK_EVENT_STRICT_FLAG)}] === true)) {
        throw e;
      }
    }
  };
    const __w2 = __win || (__target && __target.ownerDocument && __target.ownerDocument.defaultView);
    const __P = __w2 && __w2.Promise;
  __emit('before');
  let __ret;
  try {
    __ret = (async () => {
      ${originalExpression}
    })();
  } catch (e) {
    __emit('error', e);
    throw e;
  }
    // Avoid referencing globals like Promise/globalThis directly in the template expression;
    // Vue may rewrite them to _ctx.* and break at runtime. Use window properties instead.
    if (__P && typeof __P.resolve === 'function') {
      return __P.resolve(__ret)
        .then(() => { __emit('after'); }, (e) => { __emit('error', e); throw e; });
    }
    // Fallback: if the return is thenable, attach handlers.
    if (__ret && typeof __ret.then === 'function') {
      return __ret.then(() => { __emit('after'); }, (e) => { __emit('error', e); throw e; });
    }
    __emit('after');
    return __ret;
}`;

  const expressionWrappedHandler = `($event) => {
  const __win = ($event && $event.view) ? $event.view : undefined;
  const __target = ($event && $event.currentTarget) ? $event.currentTarget : undefined;
  const __testIdFromNode = ${testIdExpression};
  const __testIdFromTarget = (__target && typeof __target.getAttribute === 'function') ? __target.getAttribute(${jsStringLiteral(testIdAttribute)}) : undefined;
  const __testId = (__testIdFromNode ?? __testIdFromTarget);
  const __emit = (phase, err) => {
    try {
      const __w = __win || (__target && __target.ownerDocument && __target.ownerDocument.defaultView);
      const __CustomEvent = __w && __w.CustomEvent;
      if (__w && typeof __w.dispatchEvent === 'function' && __CustomEvent) {
        __w.dispatchEvent(new __CustomEvent('${CLICK_EVENT_NAME}', { detail: { testId: __testId, phase, err: err ? String(err) : undefined } }));
      }
    } catch (e) {
      // Instrumentation must never hide failures during e2e strict mode.
      // In strict mode we rethrow so tests fail fast and the underlying problem is visible.
      // Outside strict mode we log and continue so we don't break real user clicks.
      const __w = __win || (__target && __target.ownerDocument && __target.ownerDocument.defaultView);
      if (__w && __w.console && typeof __w.console.error === 'function') {
        __w.console.error('[testid-click-event] failed to emit ${CLICK_EVENT_NAME}', e);
      }
      if (__w && (__w[${JSON.stringify(TESTID_CLICK_EVENT_STRICT_FLAG)}] === true)) {
        throw e;
      }
    }
  };
    const __w2 = __win || (__target && __target.ownerDocument && __target.ownerDocument.defaultView);
    const __P = __w2 && __w2.Promise;
  __emit('before');
  let __ret;
  try {
    const __maybeFn = (${originalExpression});
    __ret = (typeof __maybeFn === 'function') ? __maybeFn($event) : __maybeFn;
  } catch (e) {
    __emit('error', e);
    throw e;
  }
    // Avoid referencing globals like Promise/globalThis directly in the template expression;
    // Vue may rewrite them to _ctx.* and break at runtime. Use window properties instead.
    if (__P && typeof __P.resolve === 'function') {
      return __P.resolve(__ret)
        .then((v) => { __emit('after'); return v; }, (e) => { __emit('error', e); throw e; });
    }
    if (__ret && typeof __ret.then === 'function') {
      return __ret.then((v) => { __emit('after'); return v; }, (e) => { __emit('error', e); throw e; });
    }
    __emit('after');
    return __ret;
}`;

  clickDirective.exp = {
    type: NodeTypes.SIMPLE_EXPRESSION,
    content: isStatementBody ? statementWrappedHandler : expressionWrappedHandler,
    isStatic: false,
    constType: 0,
    // Preserve location metadata so downstream Vue compiler transforms don't crash.
    loc: exp.loc,
  } as SimpleExpressionNode;
}


let previousFileName = "";
const hierarchyMap: HierarchyMap = new Map(); // key is child, value is parent
/**
 * Creates a NodeTransform that adds data-testid attributes to elements
 */
export function createTestIdTransform(
  componentName: string,
  componentHierarchyMap: Map<string, IComponentDependencies>,
  nativeWrappers: NativeWrappersMap = {},
  excludedComponents: string[] = [],
  viewsDirAbs: string,
  options: {
    existingIdBehavior?: "preserve" | "overwrite" | "error";
    testIdAttribute?: string;
    nameCollisionBehavior?: "error" | "warn" | "suffix";
    missingSemanticNameBehavior?: "ignore" | "error";
    warn?: (message: string) => void;
    vueFilesPathMap?: Map<string, string>;
    wrapperSearchRoots?: string[];
  } = {},
): NodeTransform {
  const existingIdBehavior = options.existingIdBehavior ?? "preserve";
  const testIdAttribute = (options.testIdAttribute || "data-testid").trim() || "data-testid";
  const nameCollisionBehavior = options.nameCollisionBehavior ?? "suffix";
  const missingSemanticNameBehavior = options.missingSemanticNameBehavior ?? "ignore";
  const warn = options.warn;
  const vueFilesPathMap = options.vueFilesPathMap;
  const wrapperSearchRoots = options.wrapperSearchRoots ?? [];

  // Some projects (and dev environments) use symlinks. We want viewsDir containment checks
  // to behave like the filesystem does (real paths), but we must not crash for virtual
  // Vite filenames (e.g. /@fs/...) or any non-existent paths.
  const safeRealpath = (p: string) => {
    try {
      return fs.existsSync(p) ? fs.realpathSync(p) : p;
    } catch {
      return p;
    }
  };

  const normalizedViewsDirAbs = path.normalize(safeRealpath(path.resolve(viewsDirAbs)));

  // When generating methods incrementally, it’s possible for the same logical test id to be
  // encountered multiple times (e.g. due to wrapper behaviors, template shape, or repeated nodes).
  // Deduplicate by method *content* to avoid duplicate declarations in generated POM classes.
  const generatedMethodContentByComponent = new Map<string, Set<string>>();

  // Track the most recent conditional (v-if / v-else-if) hint for a given parent element so
  // adjacent v-else branches can derive a stable semantic hint (e.g. `else personId`).
  const lastConditionalHintByParent = new WeakMap<object, string>();
  const lastConditionalMergeGroupByParent = new WeakMap<object, string>();

  // Track conditional hints per element so descendants can inherit context when they have
  // an existing data-testid but no other naming signals.
  const conditionalHintByElement = new WeakMap<ElementNode, string>();

  // Track conditional hints per IF_BRANCH. This is required because Vue's structural transforms
  // may remove v-if/v-else directives from element.props and instead wrap elements in IF/IF_BRANCH.
  const conditionalHintByIfBranch = new WeakMap<IfBranchNode, string>();
  const conditionalMergeGroupByElement = new WeakMap<ElementNode, string>();
  const conditionalMergeGroupByElementLoc = new Map<string, string>();
  const conditionalMergeGroupByIfBranch = new WeakMap<IfBranchNode, string>();
  let conditionalMergeGroupCounter = 0;

  const getElementLocationKey = (element: ElementNode): string | null => {
    const startOffset = element.loc?.start.offset;
    const endOffset = element.loc?.end.offset;
    if (typeof startOffset !== "number" || typeof endOffset !== "number") {
      return null;
    }
    return `${element.tag}:${startOffset}:${endOffset}`;
  };

  const markConditionalMergeGroup = (nodes: TemplateChildNode[], mergeGroupKey: string) => {
    for (const child of nodes) {
      if (child.type === NodeTypes.ELEMENT) {
        const element = child as ElementNode;
        conditionalMergeGroupByElement.set(element, mergeGroupKey);
        const elementLocationKey = getElementLocationKey(element);
        if (elementLocationKey) {
          conditionalMergeGroupByElementLoc.set(elementLocationKey, mergeGroupKey);
        }
        markConditionalMergeGroup(element.children as TemplateChildNode[], mergeGroupKey);
        continue;
      }

      if (child.type === NodeTypes.IF) {
        const ifNode = child as IfNode;
        for (const branch of ifNode.branches ?? []) {
          markConditionalMergeGroup(branch.children as TemplateChildNode[], mergeGroupKey);
        }
        continue;
      }

      if (child.type === NodeTypes.IF_BRANCH || child.type === NodeTypes.FOR) {
        const branchLike = child as IfBranchNode | ForNode;
        markConditionalMergeGroup((branchLike.children ?? []) as TemplateChildNode[], mergeGroupKey);
      }
    }
  };

  return (node: RootNode | TemplateChildNode, context) => {
    if (excludedComponents.includes(componentName)) {
      return;
    }

    // Capture conditional information early (before we reach elements nested under IF_BRANCH).
    if (node.type === NodeTypes.IF) {
      const ifNode = node as IfNode;
      const branches = ifNode.branches ?? [];
      const mergeGroupKey = `if-group:${++conditionalMergeGroupCounter}`;
      const ifParentKey = context?.parent ? (context.parent as object) : null;
      if (ifParentKey) {
        lastConditionalMergeGroupByParent.set(ifParentKey, mergeGroupKey);
      }

      let lastHint: string | null = null;
      for (const branch of branches) {
        conditionalMergeGroupByIfBranch.set(branch, mergeGroupKey);
        markConditionalMergeGroup((branch.children ?? []) as TemplateChildNode[], mergeGroupKey);
        const cond = (branch.condition ?? null) as (SimpleExpressionNode | CompoundExpressionNode | null);

        if (!cond) {
          // else branch
          const hint = lastHint ? `else ${lastHint}` : "else";
          conditionalHintByIfBranch.set(branch, hint);
          continue;
        }

        const condSource = (cond.type === NodeTypes.SIMPLE_EXPRESSION
          ? (cond as SimpleExpressionNode).content
          : stringifyExpression(cond)).trim();
        const stable = tryExtractStableHintFromConditionalExpressionSource(condSource);

        if (stable) {
          conditionalHintByIfBranch.set(branch, stable);
          lastHint = stable;
        } else {
          // Still set something so downstream code can distinguish the branch shape.
          conditionalHintByIfBranch.set(branch, "if");
        }
      }

      return;
    }

    // Only process element nodes
    if (node.type !== NodeTypes.ELEMENT) {
      return;
    }

    const actualFileName = `${componentName}.vue`;
    if (previousFileName !== actualFileName) {
      previousFileName = actualFileName;
      hierarchyMap.clear();
    }

    const element = node as ElementNode;
    const parentIsRoot = context?.parent?.type === NodeTypes.ROOT;
    const parentElement = (!parentIsRoot && context?.parent?.type === NodeTypes.ELEMENT)
      ? (context.parent as ElementNode)
      : null;
    hierarchyMap.set(element, parentElement);

    // Convert any path (including Windows "C:\\..." and Vite /@fs/ paths) into a
    // normalized POSIX-ish form so `path.posix.*` helpers behave predictably.
    //
    // NOTE: `path.resolve()` on Windows returns backslashes, and `path.posix.basename()`
    // only treats '/' as a separator. If we don't normalize separators first, we can end
    // up treating the entire absolute path as the "basename" and generating invalid
    // identifiers like `export class C:\\Users\\...`.
    const normalizeFilePath = (filePath: string) => path.normalize(safeRealpath(path.resolve(filePath)));

    const normalizedFilePath = normalizeFilePath(context.filename);
    const parentComponentName = componentName;

    const dependencies = (() => {
      let deps = componentHierarchyMap.get(componentName);
      if (!deps) {
        // Treat a component as a "view" when its .vue file is contained under viewsDir.
        // This uses a real path containment check instead of substring matching.
        const relToViewsDir = path.relative(normalizedViewsDirAbs, normalizedFilePath);
        const isView = !relToViewsDir.startsWith("..") && !path.isAbsolute(relToViewsDir);

        deps = {
          filePath: context.filename,
          childrenComponentSet: new Set<string>(),
          usedComponentSet: new Set<string>(),
          dataTestIdSet: new Set(),
          isView,
          methodsContent: "",
        };
        componentHierarchyMap.set(componentName, deps);
      }
      return deps;
    })();

    const isComponentLikeTag = (tag: string) => {
      // Vue component tags are typically PascalCase or kebab-case.
      // - PascalCase: DxDataGrid
      // - kebab-case: dx-data-grid
      // HTML tags are lowercase and do not contain '-'.
      if (!tag) return false;
      const first = tag.charCodeAt(0);
      const isUpper = isAsciiUppercaseLetterCode(first);
      return isUpper || tag.includes("-");
    };

    // Track all component-like tags used in the template, even when we do not emit a data-testid.
    // This supports per-view helper attachment (e.g. Grid) based on component usage.
    if (isComponentLikeTag(element.tag)) {
      dependencies.usedComponentSet.add(element.tag);
    }

    // Opportunistically infer wrapper semantics for simple "single native input" components
    // (e.g. CustomInput/CustomTextArea) so they behave like real inputs without requiring
    // explicit configuration in vite.config.ts.
    if (!nativeWrappers[element.tag]) {
      const inferred = tryInferNativeWrapperRoleFromSfc(element.tag, vueFilesPathMap, wrapperSearchRoots);
      if (inferred?.role) {
        // Cache onto the nativeWrappers map so downstream utilities (formatTagName, wrapper transform)
        // see it consistently.
        (nativeWrappers as NativeWrappersMap)[element.tag] = { role: inferred.role, inferred: true };
      } else if (element.tag.endsWith("Button") || element.tag === "AylaButton") {
        // Recognition of conventional naming for button components.
        (nativeWrappers as NativeWrappersMap)[element.tag] = { role: "button" };
      } else if (element.tag === "DxDataGrid") {
        (nativeWrappers as NativeWrappersMap)[element.tag] = { role: "grid" };
      }
    }

    const getBestAvailableKeyValue = () => {
      const parentNode = (context.parent && typeof context.parent === "object") ? context.parent as { type?: number } : null;
      const isDirectVForChild = parentNode?.type === NodeTypes.FOR;

      const vForKey = (isDirectVForChild ? getKeyDirectiveValue(element, context) : null)
        || getContainedInVForDirectiveKeyValue(context, element, hierarchyMap);
      if (vForKey) return vForKey;

      return getContainedInSlotDataKeyValue(element, hierarchyMap);
    };

    const bestKeyInferred = getBestAvailableKeyValue();
    const isSlotKey = bestKeyInferred && !bestKeyInferred.startsWith("${");
    const bestKeyPlaceholder = isSlotKey ? `\${${bestKeyInferred}}` : bestKeyInferred;
    const bestKeyVariable = isSlotKey ? bestKeyInferred : null;

    // If we can prove the v-for iterable is a static literal list, capture the concrete
    // values (e.g. ['One', 'Two']). Downstream codegen can use this to:
    // - emit per-key methods (clickOneButton/clickTwoButton)
    // - narrow `key: string` parameters to a literal union where we still emit keyed methods
    const keyValuesOverride = tryGetContainedInStaticVForSourceLiteralValues(context, element, hierarchyMap);

    // Derive a stable semantic hint from conditional directives (v-if/v-else-if/v-else) when available.
    // This helps avoid generic Button/clickButton collisions for elements that provide a data-testid
    // but otherwise have no naming signals (and we intentionally avoid innerText-based naming).
    const parentKey = context?.parent ? (context.parent as object) : null;
    const conditional = getConditionalDirectiveInfo(element);

    let conditionalHint: string | null = null;
    const elementLocationKey = getElementLocationKey(element);
    let conditionalMergeGroupKey: string | null = (elementLocationKey
      ? conditionalMergeGroupByElementLoc.get(elementLocationKey) ?? null
      : null)
      ?? conditionalMergeGroupByElement.get(element)
      ?? null;

    if (!conditionalMergeGroupKey && context?.parent?.type === NodeTypes.IF_BRANCH) {
      const branch = context.parent as IfBranchNode;
      conditionalMergeGroupKey = conditionalMergeGroupByIfBranch.get(branch) ?? null;
    }

    // 1) If the v-if/v-else directive is still present on the element, use that.
    if (conditional && (conditional.kind === "if" || conditional.kind === "else-if")) {
      if (parentKey) {
        if (!conditionalMergeGroupKey) {
          if (conditional.kind === "if") {
            conditionalMergeGroupKey = `if-group:${++conditionalMergeGroupCounter}`;
          }
          else {
            conditionalMergeGroupKey = lastConditionalMergeGroupByParent.get(parentKey) ?? null;
          }
        }
        if (conditionalMergeGroupKey) {
          lastConditionalMergeGroupByParent.set(parentKey, conditionalMergeGroupKey);
        }
      }
      conditionalHint = tryExtractStableHintFromConditionalExpressionSource(conditional.source);
      if (conditionalHint && parentKey) {
        lastConditionalHintByParent.set(parentKey, conditionalHint);
      }
    }
    else if (conditional && conditional.kind === "else") {
      if (parentKey) {
        const previousHint = lastConditionalHintByParent.get(parentKey) ?? null;
        conditionalHint = previousHint ? `else ${previousHint}` : null;
        conditionalMergeGroupKey = lastConditionalMergeGroupByParent.get(parentKey) ?? null;
      }
    }

    // 2) If structural transforms already ran, infer from IF_BRANCH wrapper.
    if (!conditionalHint && context?.parent?.type === NodeTypes.IF_BRANCH) {
      const branch = context.parent as IfBranchNode;
      conditionalHint = conditionalHintByIfBranch.get(branch) ?? null;

      // Fallback: if we somehow missed the IF node pass (or the branch instance wasn't cached),
      // derive a stable hint directly from the branch condition.
      if (!conditionalHint) {
        const cond = (branch.condition ?? null) as (SimpleExpressionNode | CompoundExpressionNode | null);
        if (!cond) {
          conditionalHint = "else";
        } else {
          const condSource = (cond.type === NodeTypes.SIMPLE_EXPRESSION
            ? (cond as SimpleExpressionNode).content
            : stringifyExpression(cond)).trim();
          conditionalHint = tryExtractStableHintFromConditionalExpressionSource(condSource) ?? "if";
        }
      }
    }

    // 2b) Also consider v-show as contextual disambiguation (common for tab bodies).
    // This is intentionally NOT innerText-based and does not parse data-testid values.
    const showDirective = element.props.find((p): p is DirectiveNode => {
      return p.type === NodeTypes.DIRECTIVE && p.name === "show";
    });
    if (showDirective?.exp && (showDirective.exp.type === NodeTypes.SIMPLE_EXPRESSION || showDirective.exp.type === NodeTypes.COMPOUND_EXPRESSION)) {
      const exp = showDirective.exp as SimpleExpressionNode | CompoundExpressionNode;
      const source = (exp.type === NodeTypes.SIMPLE_EXPRESSION
        ? (exp as SimpleExpressionNode).content
        : stringifyExpression(exp)).trim();
      const showHint = tryExtractStableHintFromConditionalExpressionSource(source);
      if (showHint) {
        conditionalHint = conditionalHint ? `${conditionalHint} ${showHint}` : showHint;
      }
    }

    // 3) Inherit conditional context from ancestor elements.
    if (!conditionalHint) {
      let cur = hierarchyMap.get(element) || null;
      while (cur) {
        const inherited = conditionalHintByElement.get(cur) ?? null;
        if (inherited) {
          conditionalHint = inherited;
          break;
        }
        cur = hierarchyMap.get(cur) || null;
      }
    }

    if (conditionalHint) {
      conditionalHintByElement.set(element, conditionalHint);
    }

    // Some branches need a formatted tag suffix / native role. Compute lazily and cache.
    let cachedTagSuffix: string | null = null;
    const getTagSuffix = () => {
      cachedTagSuffix ??= formatTagName(element, nativeWrappers);
      return cachedTagSuffix;
    };
    const getNativeRoleFromTagSuffix = () => getTagSuffix().slice(1);

    const getHandlerAttributeValueDataTestId = (handlerAttributeValue: string): AttributeValue => {
      const tagSuffix = getTagSuffix();
      return bestKeyPlaceholder
        ? templateAttributeValue(`${componentName}_${handlerAttributeValue}-${bestKeyPlaceholder}${tagSuffix}`)
        : staticAttributeValue(`${componentName}_${handlerAttributeValue}${tagSuffix}`);
    };

    const getClickDataTestId = (clickSuffix: string): AttributeValue => {
      const tagSuffix = getTagSuffix();
      return bestKeyPlaceholder
        ? templateAttributeValue(`${componentName}-${bestKeyPlaceholder}${clickSuffix}${tagSuffix}`)
        : staticAttributeValue(`${componentName}${clickSuffix}${tagSuffix}`);
    };

    const getSubmitDataTestId = (identifier: string): string => {
      const tagSuffix = getTagSuffix();
      return `${componentName}-${identifier}${tagSuffix}`;
    };


    const applyResolvedDataTestIdForElement = (args: {
      preferredGeneratedValue: AttributeValue;
      nativeRoleOverride?: string;
      entryOverrides?: Partial<IDataTestId>;
      addHtmlAttribute?: boolean;
      semanticNameHint?: string;
      semanticNameHintAlternates?: string[];
      pomMergeKey?: string;
    }): void => {
      const nativeRole = args.nativeRoleOverride ?? getNativeRoleFromTagSuffix();
      applyResolvedDataTestId({
        element,
        componentName,
        parentComponentName,
        context,
        contextFilename: context.filename,
        dependencies,
        generatedMethodContentByComponent,
        nativeRole,
        preferredGeneratedValue: args.preferredGeneratedValue,
        bestKeyPlaceholder,
        bestKeyVariable,
        keyValuesOverride,
        entryOverrides: args.entryOverrides,
        semanticNameHint: args.semanticNameHint,
        semanticNameHintAlternates: args.semanticNameHintAlternates,
        pomMergeKey: args.pomMergeKey,
        addHtmlAttribute: args.addHtmlAttribute ?? true,
        testIdAttribute,
        existingIdBehavior,
        nameCollisionBehavior,
        warn,
      });
    };

    // Inline the old nodeShouldBeIgnored gating logic, but compute signals incrementally.
    // Native wrapper detection + option-prefix needs are computed in one place to avoid duplicate checks.
    const { nativeWrappersValue, optionDataTestIdPrefixValue, semanticNameHint } = getNativeWrapperTransformInfo(element, componentName, nativeWrappers);
    const handlerDirective = element.props.find((p): p is DirectiveNode => {
      return p.type === NodeTypes.DIRECTIVE
        && p.name === "bind"
        && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION
        && p.arg.content === "handler"
        && !!p.exp;
    }) ?? null;
    const handlerInfo = handlerDirective ? nodeHandlerAttributeInfo(element) : null;

    if (
      missingSemanticNameBehavior === "error"
      && nativeWrappers[element.tag]?.role === "button"
      && handlerDirective
      && !handlerInfo
    ) {
      const loc = element.loc?.start;
      const locationHint = loc ? `${loc.line}:${loc.column}` : "unknown";
      const handlerSource = (handlerDirective.exp?.loc?.source ?? "").trim() || "<unknown>";

      throw new Error(
        `[vue-pom-generator] Could not derive a semantic POM action name for button-like wrapper in ${componentName} (${context.filename ?? "unknown"}:${locationHint}).\n`
        + `Element: <${element.tag}>\n`
        + `Handler: ${handlerSource}\n\n`
        + `Fix: move complex inline logic into a named function (for example, const onAction = () => ...; then bind :handler="onAction"), `
        + `or simplify the handler to a direct identifier/call the generator can name. `
        + `You can also set errorBehavior = "ignore" to keep generic fallback behavior.`,
      );
    }

    if (nativeWrappersValue) {
      // Some wrappers (e.g. option-driven selects) require the option prefix even when we have a
      // native wrapper data-testid. Apply the prefix before we return.
      if (optionDataTestIdPrefixValue) {
        const existing = existingIdBehavior === "preserve"
          ? tryGetExistingElementDataTestId(element, testIdAttribute)
          : null;

        if (existing) {
          const loc = element.loc?.start;
          const locationHint = loc ? `${loc.line}:${loc.column}` : "unknown";
          const attrLabel = testIdAttribute || "data-testid";

          throw new Error(
            `[vue-pom-generator] existingIdBehavior="preserve" cannot safely preserve nested option ids for wrappers that require option-data-testid-prefix.\n`
            + `Component: ${componentName}\n`
            + `File: ${context.filename ?? "unknown"}:${locationHint}\n`
            + `Element: <${element.tag}>\n`
            + `Existing ${attrLabel}: ${JSON.stringify(existing.value)}\n\n`
            + `Fix: remove the explicit ${attrLabel}, or change existingIdBehavior to "overwrite" or "error".`,
          );
        }

        upsertAttribute(element, "option-data-testid-prefix", optionDataTestIdPrefixValue);
      }

      const nativeRole = nativeWrappers[element.tag]?.role ?? element.tag;

      const wrapperHintCandidates = [
        semanticNameHint,
        getStaticAttributeContent(element, "title"),
        getStaticAttributeContent(element, "label"),
        getStaticAttributeContent(element, "okTitle"),
        getStaticAttributeContent(element, "cancelTitle"),
        getStaticAttributeContent(element, "id") || getStaticAttributeContent(element, "name"),
        getInnerText(element) || null,
        (nameCollisionBehavior === "error" && semanticNameHint && conditionalHint)
          ? `${semanticNameHint} ${conditionalHint}`
          : conditionalHint,
      ]
        .map(value => (value ?? "").trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index);

      // Wrapper-derived hints are often shared (e.g. many branches bind the same v-model path).
      // Keep the wrapper binding as the preferred name, but make stable author-facing props
      // available as fallbacks when strict collision mode needs to disambiguate.
      const [primarySemanticHint, ...alternates] = wrapperHintCandidates;
      const pomMergeKey = semanticNameHint && conditionalMergeGroupKey
        ? `wrapper:ifgroup:${conditionalMergeGroupKey}:model:${semanticNameHint}`
        : undefined;

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue: nativeWrappersValue,
        nativeRoleOverride: nativeRole,
        semanticNameHint: primarySemanticHint,
        semanticNameHintAlternates: alternates.length ? alternates : undefined,
        pomMergeKey,
      });
      return;
    }

    const nativeHtmlRole = getNativeHtmlControlRole(element);
    if (nativeHtmlRole) {
      const rawIdentifier = getStaticAttributeContent(element, "id")
        || getStaticAttributeContent(element, "name");
      const labelText = getAssociatedLabelText(element, hierarchyMap);
      const { vModel, modelValue } = getModelBindingValues(element);
      const bindingHint = modelValue || vModel || null;
      const labelToken = labelText ? toPascalCase(labelText) : "";
      const bindingToken = bindingHint ? toPascalCase(bindingHint) : "";

      let identifierToken: string | null = null;
      let semanticNameHint: string | undefined;

      if (nativeHtmlRole === "radio" || nativeHtmlRole === "checkbox") {
        if (rawIdentifier) {
          identifierToken = rawIdentifier;
          semanticNameHint = rawIdentifier;
        }
        else if (bindingToken && labelToken) {
          identifierToken = `${bindingToken}${labelToken}`;
          semanticNameHint = `${bindingHint || bindingToken} ${labelText || labelToken}`;
        }
        else if (labelToken) {
          identifierToken = labelToken;
          semanticNameHint = labelText || labelToken;
        }
        else if (bindingToken) {
          identifierToken = bindingToken;
          semanticNameHint = bindingHint || bindingToken;
        }
      }
      else if (rawIdentifier) {
        identifierToken = rawIdentifier;
        semanticNameHint = rawIdentifier;
      }
      else if (labelToken) {
        identifierToken = labelToken;
        semanticNameHint = labelText || labelToken;
      }
      else if (bindingToken) {
        identifierToken = bindingToken;
        semanticNameHint = bindingHint || bindingToken;
      }

      if (identifierToken) {
        const preferredGeneratedValue = bestKeyPlaceholder
          ? templateAttributeValue(`${componentName}-${bestKeyPlaceholder}-${identifierToken}-${nativeHtmlRole}`)
          : staticAttributeValue(`${componentName}-${identifierToken}-${nativeHtmlRole}`);

        applyResolvedDataTestIdForElement({
          preferredGeneratedValue,
          nativeRoleOverride: nativeHtmlRole,
          semanticNameHint: semanticNameHint || conditionalHint || undefined,
        });
        return;
      }
    }

    const innerText = getInnerText(element) || null;

    // RouterLink / :to is a special case; handle it early.
    const toDirective = nodeHasToDirective(element);
    if (toDirective) {
      const dataTestId = generateToDirectiveDataTestId(componentName, element, toDirective, context, hierarchyMap, nativeWrappers);
      const target = tryResolveToDirectiveTargetComponentName(toDirective);
      const routeNameHint = toDirectiveObjectFieldNameValue(toDirective);

      const existing = tryGetExistingElementDataTestId(element, testIdAttribute);

      // IMPORTANT: Do not use innerText as a naming disambiguator here; route target identity
      // should drive merging when multiple elements navigate to the same target.
      const semanticNameHint = routeNameHint || target || undefined;

      // HOWEVER, if we have no stable target identity (routeNameHint/target are missing), 
      // we must use other signals (innerText, existing data-testid) to avoid generic collisions.
      const alternates = (target ? [] : [innerText, existing?.value, conditionalHint]).filter(Boolean) as string[];

      const rawTo = (toDirective.exp?.loc?.source ?? "").trim();
      const pomMergeKey = routeNameHint
        ? `to:name:${routeNameHint}`
        : (rawTo ? `to:expr:${rawTo}` : undefined);

      const preferredGeneratedValue = dataTestId
        ?? (existing
          ? (existing.isDynamic ? templateAttributeValue(existing.template!) : staticAttributeValue(existing.value!))
          : null);

      if (!preferredGeneratedValue) {
        return;
      }

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue,
        entryOverrides: target ? { targetPageObjectModelClass: target } : {},
        semanticNameHint,
        semanticNameHintAlternates: alternates,
        pomMergeKey,
      });
      return;
    }

    if (handlerInfo) {
      const testId = getHandlerAttributeValueDataTestId(handlerInfo.semanticNameHint);

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue: testId,
        semanticNameHint: handlerInfo.semanticNameHint || conditionalHint || undefined,
        pomMergeKey: handlerInfo.mergeKey,
      });
      return;
    }

    // From here on out, we only care about:
    // - @click nodes
    // - submit buttons with an id/name
    // - nodes that require option-data-testid-prefix (even if they don't have click/submit)
    const clickDirective = tryGetClickDirective(element);
    if (clickDirective) {
      const clickSuffix = getComposedClickHandlerContent(element, context, innerText, clickDirective, {
        componentName,
        contextFilename: context.filename,
      });

      // Derive a semantic hint from the click suffix (which is already derived from AST and/or innerText).
      // This is NOT derived by parsing the final data-testid.
      const clickHint = trimLeadingSeparators(clickSuffix) || undefined;
      const idOrName = getIdOrName(element) || undefined;

      const semanticHintCandidates = [clickHint, idOrName, innerText, conditionalHint]
        .map(value => (value ?? "").trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index);

      // Prefer semantic signal from the handler or explicit id/name, but keep the lower-priority
      // hints available so strict name-collision mode can fall back to a stable human-facing label.
      const [semanticNameHint, ...semanticNameHintAlternates] = semanticHintCandidates;

      // Use the same AST-derived click hint as the merge key so wrapper expressions like
      // `() => doThing()` and `doThing()` can still merge.
      const pomMergeKey = clickHint ? `click:hint:${clickHint}` : undefined;

      const testId = getClickDataTestId(clickSuffix);

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue: testId,
        semanticNameHint,
        semanticNameHintAlternates,
        pomMergeKey,
      });

      // Instrument @click handlers so Playwright can wait on deterministic UI-side events
      // without relying on network inspection.
      if (ENABLE_CLICK_INSTRUMENTATION) {
        tryWrapClickDirectiveForTestEvents(element, testIdAttribute);
      }
      return;
    }

    const existingElementDataTestId = tryGetExistingElementDataTestId(element, testIdAttribute);
    if (existingElementDataTestId) {
      // Only generate POM members for existing test ids when the element is something we
      // consider interactive (based on role inferred from tag suffix).
      //
      // This avoids polluting POMs with static content nodes like <label>/<p> that often
      // have data-testid for assertions but should not get click* APIs.
      const inferredRole = getNativeRoleFromTagSuffix().toLowerCase();
      const isRecognizedInteractiveRole = inferredRole === "button"
        || inferredRole === "input"
        || inferredRole === "select"
        || inferredRole === "vselect"
        || inferredRole === "checkbox"
        || inferredRole === "toggle"
        || inferredRole === "radio"
        || inferredRole === "grid"
        || isComponentLikeTag(element.tag);

      if (!isRecognizedInteractiveRole) {
        return;
      }

      // More aggressive hints for existing test-ids:
      // 1) id/name
      // 2) handler attribute
      // 3) inner text (labels)
      // 4) the data-testid value itself (last resort hint)
      const identifierHint = getIdOrName(element)
        || nodeHandlerAttributeValue(element)
        || innerText
        || existingElementDataTestId.value
        || conditionalHint
        || undefined;

      const preferredGeneratedValue = existingElementDataTestId.isDynamic
        ? templateAttributeValue(existingElementDataTestId.template!)
        : staticAttributeValue(existingElementDataTestId.value!);

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue,
        semanticNameHint: identifierHint,
      });
      return;
    }
    const isSubmit = (element.props.find((p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === "type")?.value?.content === "submit");
    if (isSubmit) {
      // Prefer explicit identity (id/name), otherwise fall back to literal inner text.
      const identifier = getIdOrName(element) || innerText;
      if (!identifier) {
        const loc = element.loc?.start;
        const locationHint = loc ? `${loc.line}:${loc.column}` : "unknown";
        throw new Error(
          `[vue-pom-generator] submit button appears identifiable but no usable identity could be derived in ${componentName} (${context.filename ?? "unknown"}:${locationHint}) — `
          + `id/name were missing/empty and innerText was also missing/invalid`,
        );
      }

      const testId = getSubmitDataTestId(identifier);

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue: staticAttributeValue(testId),
        semanticNameHint: identifier,
      });
    }
  };
}
