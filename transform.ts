import type { ElementNode, NodeTransform, RootNode, TemplateChildNode, AttributeNode, DirectiveNode, SimpleExpressionNode } from "@vue/compiler-core";
import type { AttributeValue, HierarchyMap } from "./utils";
import { NodeTypes } from "@vue/compiler-core";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { parse as parseTemplate } from "@vue/compiler-dom";
import { parseExpression } from "@babel/parser";
import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { generateViewObjectModelMethodContent } from "./class-generation";
import { TESTID_CLICK_EVENT_NAME, TESTID_CLICK_EVENT_STRICT_FLAG } from "./click-instrumentation";
import {
  upsertAttribute,
  findTestIdAttribute,
  formatTagName,
  getComposedClickHandlerContent,
  getIdOrName,
  getInnerText,
  getContainedInVForDirectiveKeyValue,
  getKeyDirectiveValue,
  getNativeWrapperTransformInfo,
  getSelfClosingForDirectiveKeyAttrValue,
  nodeHandlerAttributeValue,
  tryGetClickDirective,
  nodeHasToDirective,
  generateToDirectiveDataTestId,
  staticAttributeValue,
  templateAttributeValue,
  tryResolveToDirectiveTargetComponentName,
  IDataTestId,
  IComponentDependencies,
  NativeWrappersMap,
  applyResolvedDataTestId,
  tryGetExistingElementDataTestId,
} from "./utils";

const CLICK_EVENT_NAME = TESTID_CLICK_EVENT_NAME;
const ENABLE_CLICK_INSTRUMENTATION = true;

// Cache inferred wrapper configs across transforms/build passes.
// Keyed by component tag name (e.g. "CustomInput").
const inferredNativeWrapperConfigByTag = new Map<string, { role: string }>();

function tryInferNativeWrapperRoleFromSfc(tag: string): { role: "input" | "select" } | null {
  // Only attempt inference for PascalCase component tags.
  const first = tag.charCodeAt(0);
  const isUpper = first >= 65 && first <= 90;
  if (!isUpper)
    return null;

  const cached = inferredNativeWrapperConfigByTag.get(tag);
  if (cached)
    return cached as { role: "input" | "select" };

  // Prefer conventional paths in this repo.
  const candidates = [
    path.resolve(process.cwd(), "src/components", `${tag}.vue`),
  ];

  const filePath = candidates.find(p => fs.existsSync(p));
  if (!filePath) {
    inferredNativeWrapperConfigByTag.set(tag, { role: "" });
    return null;
  }

  let source = "";
  try {
    source = fs.readFileSync(filePath, "utf8");
  }
  catch {
    inferredNativeWrapperConfigByTag.set(tag, { role: "" });
    return null;
  }

  // Parse the SFC and then parse the template into an AST to find the first meaningful element.
  // This avoids brittle string scanning and correctly ignores comments/whitespace.
  let template = "";
  try {
    const { descriptor } = parseSfc(source, { filename: filePath });
    template = descriptor.template?.content ?? "";
  }
  catch {
    inferredNativeWrapperConfigByTag.set(tag, { role: "" });
    return null;
  }

  if (!template.trim()) {
    inferredNativeWrapperConfigByTag.set(tag, { role: "" });
    return null;
  }

  let rootTag = "";
  try {
    const ast = parseTemplate(template, { comments: false });

    // Find first Element-like node in root children (skip text/comments).
    // We intentionally only look at the first meaningful root tag; this is a conservative heuristic.
    const children = ast.children ?? [];
    for (const child of children) {
      if (!child || typeof child !== "object")
        continue;
      // NodeTypes.ELEMENT === 1
      if (child.type === NodeTypes.ELEMENT && typeof child.tag === "string") {
        rootTag = (child.tag || "").toLowerCase();
        break;
      }
    }
  }
  catch {
    inferredNativeWrapperConfigByTag.set(tag, { role: "" });
    return null;
  }

  // Only infer for a few safe primitives.
  if (rootTag === "input" || rootTag === "textarea") {
    inferredNativeWrapperConfigByTag.set(tag, { role: "input" });
    return { role: "input" };
  }
  if (rootTag === "select") {
    inferredNativeWrapperConfigByTag.set(tag, { role: "select" });
    return { role: "select" };
  }

  inferredNativeWrapperConfigByTag.set(tag, { role: "" });
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
  viewsDir: string = "/src/views/",
  options: { strictNaming?: boolean; testIdAttribute?: string } = {},
): NodeTransform {
  const strictNaming = options.strictNaming === true;
  const testIdAttribute = (options.testIdAttribute || "data-testid").trim() || "data-testid";
  const normalizedViewsDir = viewsDir.startsWith("/") ? viewsDir : `/${viewsDir}`;
  const viewsNeedle = normalizedViewsDir.endsWith("/") ? normalizedViewsDir : `${normalizedViewsDir}/`;

  // When generating methods incrementally, it’s possible for the same logical test id to be
  // encountered multiple times (e.g. due to wrapper behaviors, template shape, or repeated nodes).
  // Deduplicate by method *content* to avoid duplicate declarations in generated POM classes.
  const generatedMethodContentByComponent = new Map<string, Set<string>>();

  return (node: RootNode | TemplateChildNode, context) => {
    if (excludedComponents.includes(componentName)) {
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
    hierarchyMap.set(element, parentIsRoot ? null : context?.parent as ElementNode | null);

    const toPosixPath = (filePath: string) => path.posix.normalize(path.resolve(filePath));

    const getParentComponentName = () => {
      // Vite often provides posix-style paths, but on Windows we can still see backslashes.
      // Normalize to posix separators before using path.posix helpers.
      const normalizedFilePath = path.posix.normalize(toPosixPath(context.filename));
      return path.posix.basename(normalizedFilePath, ".vue");
    };

    const parentComponentName = getParentComponentName();

    const normalizedFilePath = path.posix.normalize(toPosixPath(context.filename));
    // Keep the existing semantics (substring match) but operate on a normalized path.
    const isView = normalizedFilePath.includes(viewsNeedle);

    const ensureDependencies = (parentComponentName: string) => {
      let dependencies = componentHierarchyMap.get(parentComponentName);
      if (!dependencies) {
        dependencies = {
          filePath: context.filename,
          childrenComponentSet: new Set<string>(),
          usedComponentSet: new Set<string>(),
          dataTestIdSet: new Set(),
          isView,
          methodsContent: "",
        };
        componentHierarchyMap.set(parentComponentName, dependencies);
      }
      return dependencies;
    };

    // Always register a dependencies entry for the current file.
    // Without this, files that happen to have no component-like tags and no injectable test ids
    // can be omitted from `componentHierarchyMap`, which then causes aggregated POM generation
    // to miss expected exported classes.
    //
    // NOTE: This is intentionally cheap and safe to call repeatedly.
    const dependencies = ensureDependencies(parentComponentName);

    const isComponentLikeTag = (tag: string) => {
      // Vue component tags are typically PascalCase or kebab-case.
      // - PascalCase: DxDataGrid
      // - kebab-case: dx-data-grid
      // HTML tags are lowercase and do not contain '-'.
      if (!tag) return false;
      const first = tag.charCodeAt(0);
      const isUpper = first >= 65 && first <= 90;
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
      const inferred = tryInferNativeWrapperRoleFromSfc(element.tag);
      if (inferred?.role) {
        // Cache onto the nativeWrappers map so downstream utilities (formatTagName, wrapper transform)
        // see it consistently.
        (nativeWrappers as NativeWrappersMap)[element.tag] = { role: inferred.role };
      }
    }

    const getBestAvailableKeyValue = () =>
      getKeyDirectiveValue(element, context)
      || getSelfClosingForDirectiveKeyAttrValue(element)
      || getContainedInVForDirectiveKeyValue(context, element, hierarchyMap);

    const bestKeyPlaceholder = getBestAvailableKeyValue();

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
        entryOverrides: args.entryOverrides,
        addHtmlAttribute: args.addHtmlAttribute,
        testIdAttribute,
        generateMethodContent: generateViewObjectModelMethodContent,
      });
    };

    // Inline the old nodeShouldBeIgnored gating logic, but compute signals incrementally.
    // Native wrapper detection + option-prefix needs are computed in one place to avoid duplicate checks.
    const { nativeWrappersValue, optionDataTestIdPrefixValue } = getNativeWrapperTransformInfo(element, componentName, nativeWrappers);

    if (nativeWrappersValue) {
      // Some wrappers (e.g. option-driven selects) require the option prefix even when we have a
      // native wrapper data-testid. Apply the prefix before we return.
      if (optionDataTestIdPrefixValue) {
        upsertAttribute(element, "option-data-testid-prefix", optionDataTestIdPrefixValue);
      }

      const nativeRole = nativeWrappers[element.tag]?.role ?? element.tag;
      applyResolvedDataTestIdForElement({
        preferredGeneratedValue: nativeWrappersValue,
        nativeRoleOverride: nativeRole,
      });
      return;
    }

    // RouterLink / :to is a special case; handle it early.
    const toDirective = nodeHasToDirective(element);
    if (toDirective) {
      const dataTestId = generateToDirectiveDataTestId(componentName, element, toDirective, context, hierarchyMap, nativeWrappers);
      const target = tryResolveToDirectiveTargetComponentName(toDirective);

      // If the author already provided a data-testid, the generator may choose not to
      // auto-generate one for :to. In that case, still register the element so we
      // generate the fluent goTo* method using the existing id.
      const existing = tryGetExistingElementDataTestId(element, testIdAttribute);

      const preferredGeneratedValue = dataTestId
        ?? (existing ? staticAttributeValue(existing.value) : null);

      if (!preferredGeneratedValue) {
        return;
      }

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue,
        entryOverrides: target ? { targetPageObjectModelClass: target } : {},
      });
      return;
    }

    const handlerAttributeValue = nodeHandlerAttributeValue(element);
    if (handlerAttributeValue) {
      const testId = getHandlerAttributeValueDataTestId(handlerAttributeValue);

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue: testId,
      });
      return;
    }

    // From here on out, we only care about:
    // - @click nodes
    // - submit buttons with an id/name
    // - nodes that require option-data-testid-prefix (even if they don't have click/submit)
    const innerText = getInnerText(element) || null;
    const clickDirective = tryGetClickDirective(element);
    if (clickDirective) {
      const clickSuffix = getComposedClickHandlerContent(element, context, innerText, clickDirective, {
        strictNaming,
        componentName,
        contextFilename: context.filename,
      });

      const testId = getClickDataTestId(clickSuffix);

      applyResolvedDataTestIdForElement({
        preferredGeneratedValue: testId,
      });

      // Instrument @click handlers so Playwright can wait on deterministic UI-side events
      // without relying on network inspection.
      if (ENABLE_CLICK_INSTRUMENTATION) {
        tryWrapClickDirectiveForTestEvents(element, testIdAttribute);
      }
      return;
    }

    const existingSubmitDataTestId = tryGetExistingElementDataTestId(element, testIdAttribute);
    if (existingSubmitDataTestId?.value) {
      applyResolvedDataTestIdForElement({
        preferredGeneratedValue: staticAttributeValue(existingSubmitDataTestId.value),
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
      });
    }
  };
}
