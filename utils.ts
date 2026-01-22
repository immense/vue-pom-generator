import type {
  AttributeNode,
  CompoundExpressionNode,
  DirectiveNode,
  ElementNode,
  SimpleExpressionNode,
  TextNode,
  TransformContext,
} from "@vue/compiler-core";
import {
  createSimpleExpression,
  ConstantTypes,
  NodeTypes,
  stringifyExpression,
} from "@vue/compiler-core";
import type {
  AssignmentExpression,
  ArrayExpression,
  File,
  MemberExpression,
  Node as BabelNode,
  OptionalMemberExpression,
  Program,
  TemplateLiteral,
  ObjectExpression,
  ObjectProperty
} from "@babel/types";
import {
  VISITOR_KEYS,
  isArrayExpression,
  isArrowFunctionExpression,
  isAssignmentExpression,
  isBlockStatement,
  isCallExpression,
  isConditionalExpression,
  isExpressionStatement,
  isFile,
  isIdentifier,
  isLogicalExpression,
  isMemberExpression,
  isObjectExpression,
  isObjectProperty,
  isOptionalCallExpression,
  isOptionalMemberExpression,
  isProgram,
  isSequenceExpression,
  isStringLiteral,
  isTemplateLiteral,
} from "@babel/types";
import { parseExpression } from "@babel/parser";
import { generateViewObjectModelMethodContent } from "./method-generation";

function getDataTestIdFromGroupOption(text: string) {
  // eslint-disable-next-line no-restricted-syntax
  return text.replace(/[-_]/g, " ").split(" ").filter(a => a).map((str: string) => {
    if (str.length > 1) {
      return str[0].toUpperCase() + str.slice(1);
    }
    return str.toUpperCase();
  }).join("");
};

export function upperFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Type guard for Vue compiler-core SimpleExpressionNode.
 *
 * We accept `object | null` (instead of `unknown`) to satisfy the repo lint rule
 * against `: unknown` annotations while still being safe at runtime.
 */
export function isSimpleExpressionNode(value: object | null): value is SimpleExpressionNode {
  return value !== null
    && "type" in value
    && (value as { type: number }).type === NodeTypes.SIMPLE_EXPRESSION;
}
export type NativeRole = 'button' | 'input' | 'select' | 'vselect' | 'checkbox' | 'toggle' | 'radio'
// In this plugin, the hierarchy map stores: key = child element, value = parent element (or null for root).
export type Child = ElementNode;
export type Parent = ElementNode | null;
export type HierarchyMap = Map<Child, Parent>
export interface NativeWrappersMap {
  [component: string]: {
    role: NativeRole
    valueAttribute?: string
    requiresOptionDataTestIdPrefix?: boolean
  }
}

export type AttributeValue =
  | { kind: "static"; value: string }
  | { kind: "template"; template: string };

export function staticAttributeValue(value: string): AttributeValue {
  return { kind: "static", value };
}

export function templateAttributeValue(template: string): AttributeValue {
  return { kind: "template", template };
}

export function getAttributeValueText(value: AttributeValue): string {
  return value.kind === "static" ? value.value : value.template;
}

/**
 * Converts a string to PascalCase.
 *
 * This is used for generating method/class names, so it is resilient to punctuation
 * and common template remnants.
 */
export function toPascalCase(str: string): string {
  // Normalize to identifier-ish tokens. This is used for generating method names,
  // so we need to be resilient to punctuation such as "?", "[0]", "${...}" remnants, etc.
  // eslint-disable-next-line no-restricted-syntax
  const cleaned = (str ?? "")
    // eslint-disable-next-line no-restricted-syntax
    .replace(/\$\{[^}]*\}/g, " ")
    // eslint-disable-next-line no-restricted-syntax
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();

  if (!cleaned) {
    return "";
  }

  // eslint-disable-next-line no-restricted-syntax
  return cleaned
    // eslint-disable-next-line no-restricted-syntax
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      // If the token already appears to be camelCase/PascalCase (e.g. NewBranding),
      // preserve its internal capitalization rather than forcing the tail to lowercase.
      // This keeps generated identifiers closer to the source intent.
      // eslint-disable-next-line no-restricted-syntax
      const preserveInternalCaps = /[a-z][A-Z]/.test(word);
      return preserveInternalCaps
        ? upperFirst(word)
        : upperFirst(word.toLowerCase());
    })
    .join("");
}


/**
 * Finds a regular attribute by key name (non-directive)
 * Equivalent to findAttributeByKey in  utils
 */
function findAttributeByKey(node: ElementNode, keyName: string): AttributeNode | undefined {
  return node.props.find((attr): attr is AttributeNode => {
    return attr.type === NodeTypes.ATTRIBUTE && attr.name === keyName;
  });
}

/**
 * Finds a directive by name and optional argument
 * e.g., findDirectiveByName(element, "bind", "key") finds :key
 */
function findDirectiveByName(node: ElementNode, directiveName: string, argumentName?: string): DirectiveNode | undefined {
  return node.props.find((attr): attr is DirectiveNode => {
    if (attr.type !== NodeTypes.DIRECTIVE) {
      return false;
    }
    const directive = attr as DirectiveNode;
    const matchesDirective = directive.name === directiveName;

    if (argumentName) {
      return matchesDirective
        && directive.arg?.type === NodeTypes.SIMPLE_EXPRESSION
        && (directive.arg as SimpleExpressionNode).content === argumentName;
    }
    return matchesDirective;
  }) as DirectiveNode | undefined;
}

/**
 * Checks if a prop/attribute is a @click directive
 *
 * @internal
 */
function isClickDirective(prop: AttributeNode | DirectiveNode): boolean {
  if (prop.type !== NodeTypes.DIRECTIVE) {
    return false;
  }

  const directive = prop as DirectiveNode;
  return directive.name === "on"
    && directive.arg?.type === NodeTypes.SIMPLE_EXPRESSION
    && (directive.arg as SimpleExpressionNode).content === "click";
}

/**
 * Returns the @click / v-on:click directive if present.
 *
 * Prefer this over re-scanning node.props in multiple places.
 */
export function tryGetClickDirective(node: ElementNode): DirectiveNode | undefined {
  return node.props.find((p): p is DirectiveNode => isClickDirective(p as AttributeNode | DirectiveNode)) as DirectiveNode | undefined;
}

/**
 * Checks if a node has an @click or v-on:click directive
 * Helper function that uses isClickDirective
 *
 * @internal
 */
export function nodeHasClickDirective(node: ElementNode): boolean {
  return tryGetClickDirective(node) !== undefined;
}

/**
 * Checks if a node is a <template> element with slot scope data
 *
 * This detects template elements with v-slot directives that have parameters,
 * such as <template #item="{ data }"> or <template v-slot="item">
 *
 * Returns true if the template has a slot scope with at least one parameter
 *
 * @internal
 */
function isTemplateWithData(node: ElementNode): boolean {
  if (node.tag !== "template") {
    return false;
  }

  return node.props.some((prop) => {
    if (prop.type !== NodeTypes.DIRECTIVE) {
      return false;
    }

    const directive = prop as DirectiveNode;

    // Check for v-slot directive (name === "slot")
    // The Vue compiler normalizes both v-slot and # syntax to name: "slot"
    if (directive.name !== "slot") {
      return false;
    }

    // Check if the directive has an expression (the slot scope parameters)
    // COMPOUND_EXPRESSION: destructuring like { data } or complex expressions
    // SIMPLE_EXPRESSION: simple identifiers like "item"
    return (
      directive.exp !== undefined &&
      (directive.exp.type === NodeTypes.SIMPLE_EXPRESSION ||
        directive.exp.type === NodeTypes.COMPOUND_EXPRESSION)
    );
  });
}

/**
 * Checks if node has a :to directive (for router links)
 *
 * Returns the directive if found, undefined otherwise
 *
 * @internal
 */
export function nodeHasToDirective(node: ElementNode): DirectiveNode | undefined {
  const toDirective = findDirectiveByName(node, "bind", "to");

  // Check if the directive has an expression
  if (toDirective?.exp) {
    return toDirective;
  }

  return undefined;
}

/**
 * Checks if node has a v-for directive
 *
 * @internal
 */
function nodeHasForDirective(node: ElementNode): boolean {
  return node.props.some(attr =>
    attr.type === NodeTypes.DIRECTIVE && (attr as DirectiveNode).name === "for",
  );
}

/**
 * Router-backed route name -> component name map.
 *
 * Populated once per Vite build by the plugin runtime (see `vite-plugins/vue-pom-generator/index.ts`).
 * The transform phase uses this to turn `:to` directives into POM return types.
 */
let routeNameToComponentName: Map<string, string> | null = null;

interface RouteLocationLike {
  name?: string;
  path?: string;
  params?: Record<string, string | number>;
}

type ResolveToComponentNameFn = (to: RouteLocationLike | string) => string | null;

let resolveToComponentName: ResolveToComponentNameFn | null = null;

export function setRouteNameToComponentNameMap(map: Map<string, string> | null) {
  routeNameToComponentName = map;
}

export function setResolveToComponentNameFn(fn: ResolveToComponentNameFn | null) {
  resolveToComponentName = fn;
}

function buildPlaceholderParams(keys: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const k of keys)
    params[k] = "__placeholder__";
  return params;
}

function getRouteLocationLikeFromToDirective(toDirective: DirectiveNode): RouteLocationLike | string | null {
  if (!toDirective.exp)
    return null;

  // Parse the JS expression with Babel and extract supported shapes.
  const exp = toDirective.exp;
  const rawSource = stringifyExpression(exp).trim();

  let expr: object;
  try {
    expr = parseExpression(rawSource, { plugins: ["typescript"] });
  }
  catch {
    return null;
  }

  const isNodeType = (node: object | null, type: string): node is { type: string } => {
    return node !== null && (node as { type?: string }).type === type;
  };
  const isStringLiteralNode = (node: object | null): node is { type: "StringLiteral"; value: string } => {
    return isNodeType(node, "StringLiteral") && typeof (node as { value?: string }).value === "string";
  };
  const isIdentifierNode = (node: object | null): node is { type: "Identifier"; name: string } => {
    return isNodeType(node, "Identifier") && typeof (node as { name?: string }).name === "string";
  };
  const isObjectPropertyNode = (node: object | null): node is { type: "ObjectProperty"; key: object; value: object } => {
    if (!isNodeType(node, "ObjectProperty"))
      return false;
    const n = node as { key?: object; value?: object };
    return typeof n.key === "object" && n.key !== null && typeof n.value === "object" && n.value !== null;
  };
  const isObjectExpressionNode = (node: object | null): node is { type: "ObjectExpression"; properties: object[] } => {
    if (!isNodeType(node, "ObjectExpression"))
      return false;
    const n = node as { properties?: object[] };
    return Array.isArray(n.properties);
  };

  if (isStringLiteralNode(expr)) {
    // :to="'/some/path'"
    return expr.value;
  }

  if (!isObjectExpressionNode(expr)) {
    return null;
  }

  const getStringField = (fieldName: "name" | "path") => {
    const prop = expr.properties.find((p) => {
      if (!isObjectPropertyNode(p))
        return false;
      const key = p.key as object;
      return (isIdentifierNode(key) && key.name === fieldName) || (isStringLiteralNode(key) && key.value === fieldName);
    });
    if (!prop || !isObjectPropertyNode(prop) || !isStringLiteralNode(prop.value as object))
      return null;
    return (prop.value as { value: string }).value;
  };

  const name = getStringField("name");
  const path = getStringField("path");

  const paramsProp = expr.properties.find((p) => {
    if (!isObjectPropertyNode(p))
      return false;
    const key = p.key as object;
    return (isIdentifierNode(key) && key.name === "params") || (isStringLiteralNode(key) && key.value === "params");
  });

  let params: Record<string, string> | undefined;
  if (paramsProp && isObjectPropertyNode(paramsProp) && isObjectExpressionNode(paramsProp.value as object)) {
    const keys: string[] = [];
    for (const prop of (paramsProp.value as { properties: object[] }).properties) {
      if (!isObjectPropertyNode(prop))
        continue;
      const key = prop.key as object;
      if (isIdentifierNode(key))
        keys.push(key.name);
      else if (isStringLiteralNode(key))
        keys.push(key.value);
    }
    if (keys.length) {
      params = buildPlaceholderParams(Array.from(new Set(keys)));
    }
  }

  if (name) {
    // Keep the router-facing name as-is (spaces etc). Normalization is only for codegen naming.
    return { name, params };
  }
  if (path) {
    return { path, params };
  }
  return null;
}

/**
 * Attempts to extract a *stable* route name key from a `:to` directive.
 *
 * Supported (best-effort):
 * - :to="{ name: 'Tenant Details', params: { ... } }"
 * - :to="someVar" (cannot be resolved statically; returns null)
 */
export function getRouteNameKeyFromToDirective(toDirective: DirectiveNode): string | null {
  // Prefer object-literal `name: '...'` parsing.
  const objectName = toDirectiveObjectFieldNameValue(toDirective);
  if (objectName)
    return objectName;

  // If Vue provided an AST, we can sometimes detect { name: '...' } without regex.
  // Currently we keep this conservative: if it isn't a literal object with name, return null.
  return null;
}

/**
 * Given a `:to` directive, try to resolve the target view/page component name.
 *
 * Returns the Vue component identifier (e.g. `TenantDetailsPage`) when available.
 */
export function tryResolveToDirectiveTargetComponentName(toDirective: DirectiveNode): string | null {
  // Prefer router.resolve (more accurate; can handle path or name + placeholder params).
  const to = getRouteLocationLikeFromToDirective(toDirective);
  if (to && resolveToComponentName) {
    const resolved = resolveToComponentName(to);
    if (resolved)
      return resolved;
  }

  // Fallback: route name -> component map (best-effort)
  const key = getRouteNameKeyFromToDirective(toDirective);
  if (!key || !routeNameToComponentName)
    return null;

  return routeNameToComponentName.get(key) ?? null;
}
/**
 * Gets the :key directive from a node
 *
 * Returns the directive if found, null otherwise
 *
 * @internal
 */
function getKeyDirective(node: ElementNode): DirectiveNode | null {
  return findDirectiveByName(node, "bind", "key") ?? null;
}

/**
 * Gets the value placeholder for a :key directive
 *
 * Returns a placeholder string if the element has a :key directive, null otherwise
 * This is used to indicate where a unique value should be interpolated
 *
 * @internal
 */
export function getKeyDirectiveValue(node: ElementNode, context: TransformContext | null = null): string | null {
  const keyDirective = getKeyDirective(node);
  let value = (keyDirective?.exp?.loc.source);
  if (value) {
    if (context) {
      value = stringifyExpression(keyDirective!.exp!);
    }
    return `\${${value}}`;
  }
  return null;
}

/**
 * Gets both v-model and :model-value directive values in a single pass
 * Consolidates the previous getVModelDirectiveValue and getModelValueValue helpers
 *
 * @internal
 */
function getModelBindingValues(node: ElementNode): { vModel: string; modelValue: string | null } {
  let vModel = "";
  const vModelDirective = findDirectiveByName(node, "model");

  if (vModelDirective?.exp?.loc.source) {
    vModel = toPascalCase(vModelDirective.exp.loc.source);
  }

  let modelValue: string | null = null;
  const modelValueDirective = findDirectiveByName(node, "bind", "modelValue");

  if (modelValueDirective?.exp?.ast) {
    const { name: mv } = getClickHandlerNameFromAst(modelValueDirective.exp.ast as BabelNode);
    modelValue = mv;
  }

  return { vModel, modelValue };
}

/**
 * Gets the key directive value for self-closing elements with v-for
 *
 * Returns the key placeholder if the element is self-closing and has v-for
 *
 * @internal
 */
export function getSelfClosingForDirectiveKeyAttrValue(node: ElementNode): string | null {
  // In Vue compiler AST, we check if isSelfClosing is true
  if (node.isSelfClosing) {
    const hasForDirective = nodeHasForDirective(node);

    if (hasForDirective) {
      return getKeyDirectiveValue(node);
    }
  }
  return null;
}

/**
 * Gets the id or name attribute value from a node
 *
 * Returns the identifier, converting dashes and underscores to PascalCase
 * Returns a placeholder if a dynamic :id is found
 *
 * @internal
 */
export function getIdOrName(node: ElementNode): string {
  // Get id or name attribute (static)
  let idAttr = findAttributeByKey(node, "id");
  if (!idAttr) {
    idAttr = findAttributeByKey(node, "name");
  }

  let identifier = idAttr?.value?.content ?? "";

  // If no static id or name attribute is found, check for a dynamic v-bind:id directive
  if (!identifier) {
    const dynamicIdAttr = findDirectiveByName(node, "bind", "id");
    if (dynamicIdAttr?.exp) {
      // TODO: Make sure this is still necessary and if so maybe pick a better name
      identifier = `\${someUniqueValueToDifferentiateInstanceFromOthersOnPageUsuallyAnId}`;
    }
  }

  // Convert dashes and underscores to PascalCase
  if (identifier.includes("-")) {
    // eslint-disable-next-line no-restricted-syntax
    identifier = identifier.split("-").map(toPascalCase).join("");
  }
  if (identifier.includes("_")) {
    // eslint-disable-next-line no-restricted-syntax
    identifier = identifier.split("_").map(toPascalCase).join("");
  }

  return identifier;
}

// NOTE: insertBeforeLastUnderscore intentionally removed.
// The only call site was simplified to conditionally interpolate the key directly into the testId.

/**
 * Checks if a node is contained within a template element that has slot scope data
 *
 * Walks up the parent chain looking for a <template> element with v-slot or #default
 * that includes slot scope variables.
 *
 * @internal
 */
export function isNodeContainedInTemplateWithData(node: ElementNode, hierarchyMap: HierarchyMap): boolean {
  let parent = getParent(hierarchyMap, node);
  while (parent) {
    if (parent.type === NodeTypes.ELEMENT && parent.tag === "template") {
      if (isTemplateWithData(parent)) {
        return true;
      }
    }
    // Walk up the tree
    parent = getParent(hierarchyMap, parent);
  }
  return false;
}

/**
 * Extracts the key value expression from a v-for directive on a parent element
 *
 * If the node is within a v-for that has a :key directive, returns the key expression.
 *
 * @internal
 */
export function getContainedInVForDirectiveKeyValue(context: TransformContext, node: ElementNode, hierarchyMap: HierarchyMap): string | null {
  // Check if we're in a v-for scope
  if (!context.scopes.vFor || context.scopes.vFor === 0) {
    return null;
  }

  // Walk up to find the parent element with v-for
  let parent = getParent(hierarchyMap, node);
  while (parent) {
    if (parent.type === NodeTypes.ELEMENT) {
      const forDirective = findDirectiveByName(parent as ElementNode, "for");
      if (forDirective) {
        // Found the v-for element, now look for :key
        const keyValue = getKeyDirectiveValue(parent as ElementNode);
        return keyValue;
      }
    }
    parent = getParent(hierarchyMap, parent);
  }
  return null;
}

/**
 * If the current node is inside a v-for whose iterable is a static array literal,
 * returns the iterable's *string literal values*.
 *
 * Example:
 * - v-for="item in ['One', 'Two']" => ['One', 'Two']
 */
export function tryGetContainedInStaticVForSourceLiteralValues(
  context: TransformContext,
  _node: ElementNode,
  _hierarchyMap: HierarchyMap,
): string[] | null {
  // If we're not in v-for scope, don't waste time walking parents.
  if (!context.scopes.vFor || context.scopes.vFor === 0) {
    return null;
  }

  // In the Vue compiler AST, v-for is represented as a ForNode (NodeTypes.FOR)
  // whose `source` is the iterable expression.
  // When visiting the repeated element, its immediate parent is usually that ForNode.
  const parentObj = (context.parent && typeof context.parent === "object") ? context.parent as object : null;
  if (!parentObj || !("type" in parentObj) || (parentObj as { type: number }).type !== NodeTypes.FOR) {
    // No direct ForNode parent; we don't currently attempt to walk further up.
    return null;
  }

  const sourceExp = (parentObj as { source?: object | null }).source;
  if (!sourceExp || typeof sourceExp !== "object") {
    return null;
  }

  // Mirror Vue compiler-core's own stability check (see `transformFor` in `vFor.ts`):
  // only a SIMPLE_EXPRESSION source participates in constType-based stability.
  if ((sourceExp as { type?: number }).type !== NodeTypes.SIMPLE_EXPRESSION) {
    return null;
  }

  const simpleSourceExp = sourceExp as SimpleExpressionNode;

  // Trust the Vue compiler's own const analysis first. If the source isn't
  // considered constant by Vue, we should not attempt to infer an enumerable
  // set of keys.
  if (simpleSourceExp.constType === ConstantTypes.NOT_CONSTANT) {
    return null;
  }

  const iterableRaw = (() => {
    try {
      return stringifyExpression(simpleSourceExp).trim();
    }
    catch {
      return (simpleSourceExp.loc?.source ?? "").trim();
    }
  })();

  if (!iterableRaw) {
    return null;
  }

  let iterableAst: BabelNode | null = null;
  try {
    iterableAst = parseExpression(iterableRaw, { plugins: ["typescript"] }) as BabelNode;
  }
  catch {
    iterableAst = null;
  }

  if (!iterableAst || !isArrayExpression(iterableAst)) {
    return null;
  }

  const values: string[] = [];
  for (const el of (iterableAst as ArrayExpression).elements ?? []) {
    if (!el) {
      return null;
    }
    if (isStringLiteral(el)) {
      if (!el.value.trim()) {
        continue;
      }
      values.push(el.value);
      continue;
    }
    if (isTemplateLiteral(el)) {
      if ((el.expressions ?? []).length > 0) {
        return null;
      }
      const v = (el.quasis ?? []).map(q => q.value?.cooked ?? "").join("");
      if (!v.trim()) {
        continue;
      }
      values.push(v);
      continue;
    }
    // Non-literal values make the set non-enumerable.
    return null;
  }

  const distinct = Array.from(new Set(values));
  if (!distinct.length) {
    return null;
  }

  return distinct;
}

function getParent(hierarchyMap: HierarchyMap, node: ElementNode): ElementNode | null {
  return hierarchyMap.get(node) || null;
}

/**
 * Analyzes a :handler directive to extract the handler name
 *
 * Supports common patterns:
 * - Simple identifier: :handler="myHandler"
 * - Member expression: :handler="obj.myHandler"
 * - Arrow function: :handler="(x) => myHandler(x)"
 *
 * Returns the handler name in PascalCase format, or null if not found.
 *
 * @internal
 */
export function nodeHandlerAttributeValue(node: ElementNode): string | null {
  const handlerDirective = findDirectiveByName(node, "bind", "handler");
  if (!handlerDirective?.exp || handlerDirective.exp.type !== NodeTypes.SIMPLE_EXPRESSION) {
    return null;
  }

  const source = (handlerDirective.exp as SimpleExpressionNode).content.trim();

  let expr: object;
  try {
    expr = parseExpression(source, { plugins: ["typescript"] });
  }
  catch {
    return null;
  }

  const isNodeType = (node: object | null, type: string): node is { type: string } => {
    return node !== null && (node as { type?: string }).type === type;
  };
  const isIdentifierNode = (node: object | null): node is { type: "Identifier"; name: string } => {
    return isNodeType(node, "Identifier") && typeof (node as { name?: string }).name === "string";
  };
  const isStringLiteralNode = (node: object | null): node is { type: "StringLiteral"; value: string } => {
    return isNodeType(node, "StringLiteral") && typeof (node as { value?: string }).value === "string";
  };
  const isMemberExpressionNode = (node: object | null): node is { type: "MemberExpression"; computed: boolean; property: object } => {
    if (!isNodeType(node, "MemberExpression"))
      return false;
    const n = node as { computed?: boolean; property?: object };
    return typeof n.computed === "boolean" && typeof n.property === "object" && n.property !== null;
  };
  const isCallExpressionNode = (node: object | null): node is { type: "CallExpression"; callee: object } => {
    if (!isNodeType(node, "CallExpression"))
      return false;
    const n = node as { callee?: object };
    return typeof n.callee === "object" && n.callee !== null;
  };
  const isArrowFunctionExpressionNode = (node: object | null): node is { type: "ArrowFunctionExpression"; body: object } => {
    if (!isNodeType(node, "ArrowFunctionExpression"))
      return false;
    const n = node as { body?: object };
    return typeof n.body === "object" && n.body !== null;
  };

  const getLastIdentifierFromMemberChain = (node: object | null): string | null => {
    if (!node)
      return null;
    if (isIdentifierNode(node))
      return node.name;
    if (isMemberExpressionNode(node) && node.computed === false) {
      const prop = node.property;
      if (isIdentifierNode(prop))
        return prop.name;
      if (isStringLiteralNode(prop))
        return prop.value;
    }
    return null;
  };

  // :handler="myHandler" or :handler="obj.myHandler"
  const direct = getLastIdentifierFromMemberChain(expr);
  if (direct)
    return toPascalCase(direct);

  // :handler="(x) => myHandler(x)" or :handler="() => obj.myHandler()"
  if (isArrowFunctionExpressionNode(expr)) {
    const body = expr.body;
    if (isCallExpressionNode(body)) {
      const name = getLastIdentifierFromMemberChain(body.callee);
      if (name)
        return toPascalCase(name);
    }
    const bodyName = getLastIdentifierFromMemberChain(body);
    if (bodyName)
      return toPascalCase(bodyName);
  }

  return null;
}

export interface NativeWrapperTransformInfo {
  /** data-testid for wrappers that can be derived from valueAttribute or v-model */
  nativeWrappersValue: AttributeValue | null;
  /** Value to assign to option-data-testid-prefix (when required by wrapper config) */
  optionDataTestIdPrefixValue: AttributeValue | null;
}

/**
 * Computes native-wrapper related transform info in a single pass.
 *
 * This consolidates:
 * - getNativeWrappersValue (data-testid from valueAttribute/v-model)
 * - assignOptionDataTestIdPrefix (option-data-testid-prefix + wrapper test id)
 *
 * NOTE: This function is pure (no AST mutation). Callers should apply attributes explicitly.
 */
export function getNativeWrapperTransformInfo(
  node: ElementNode,
  componentName: string,
  nativeWrappers: NativeWrappersMap,
): NativeWrapperTransformInfo {
  // If not a configured wrapper, nothing to do.
  const wrapperConfig = nativeWrappers[node.tag];
  if (!wrapperConfig) {
    return { nativeWrappersValue: null, optionDataTestIdPrefixValue: null };
  }

  const { role, valueAttribute, requiresOptionDataTestIdPrefix } = wrapperConfig;

  // Some wrappers (notably checkbox/toggle/radio/select) can end up with synthetic click
  // listeners in the compiler output (via v-model expansion). Treat those as implementation
  // details and still prefer wrapper-derived ids.
  //
  // For button-like wrappers, an author-specified @click is meaningful and we prefer the
  // click-derived naming pipeline.
  if (nodeHasClickDirective(node) && role === "button") {
    return { nativeWrappersValue: null, optionDataTestIdPrefixValue: null };
  }

  // 1) The traditional native wrapper path (valueAttribute or v-model)
  if (valueAttribute) {
    const value = getDataTestIdValueFromValueAttribute(node, componentName, valueAttribute, role);
    return { nativeWrappersValue: value || null, optionDataTestIdPrefixValue: null };
  }

  const { vModel, modelValue } = getModelBindingValues(node);
  if (vModel || modelValue) {
    const vmodelvalue = getDataTestIdFromGroupOption(vModel);
    const nativeWrappersValue = staticAttributeValue(`${componentName}-${modelValue || vmodelvalue}-${role}`);

    // 2) Some wrappers additionally require option-data-testid-prefix.
    if (requiresOptionDataTestIdPrefix) {
      const value = vmodelvalue || modelValue;
      return {
        nativeWrappersValue,
        optionDataTestIdPrefixValue: staticAttributeValue(`${componentName}-${value}`),
      };
    }

    return { nativeWrappersValue, optionDataTestIdPrefixValue: null };
  }

  return { nativeWrappersValue: null, optionDataTestIdPrefixValue: null };
}

function getDataTestIdValueFromValueAttribute(
  node: ElementNode,
  actualFileName: string,
  attributeKey: string,
  role: string,
): AttributeValue | null {
  const attrStatic = findAttributeByKey(node, attributeKey);
  if (attrStatic) {
    const value = attrStatic.value?.content || "";
    return staticAttributeValue(`${actualFileName}-${value}-${role}`);
  }

  const attrDynamic = findDirectiveByName(node, "bind", attributeKey);
  if (attrDynamic && 'exp' in attrDynamic && attrDynamic.exp && 'ast' in attrDynamic.exp && attrDynamic.exp.ast) {
    let value = attrDynamic.exp.loc.source;

    if (attrDynamic.exp.ast?.type === "MemberExpression") {
      // eslint-disable-next-line no-restricted-syntax
      return staticAttributeValue(`${actualFileName}-${value.replaceAll(".", "")}-${role}`);
    }

    if (attrDynamic.exp.ast?.type === "CallExpression") {
      value = stringifyExpression(attrDynamic.exp);
      return templateAttributeValue(`${actualFileName}-\${${value}}-${role}`);
    }
    return staticAttributeValue(`${actualFileName}-${value}-${role}`);
  }
  return null;
}

export function generateToDirectiveDataTestId(componentName: string, node: ElementNode, toDirective: DirectiveNode, context: TransformContext, hierarchyMap: HierarchyMap, nativeWrappers: NativeWrappersMap): AttributeValue | null {
  const key = getKeyDirectiveValue(node, context) || getSelfClosingForDirectiveKeyAttrValue(node) || getContainedInVForDirectiveKeyValue(context, node, hierarchyMap);
  if (key) {
    return templateAttributeValue(`${componentName}-${key}-${formatTagName(node, nativeWrappers)}`);
  } else {
    let name = toDirectiveObjectFieldNameValue(toDirective);
    if (!name) {
      if (toDirective.exp == null) {
        return null;
      }

      const source = stringifyExpression(toDirective.exp);

      const toAst = toDirective.exp.ast;
      const interpolated = !(toAst == null || toAst === false || toAst) && isTemplateLiteral(toAst);
      return templateAttributeValue(`${componentName}-\${${source}${interpolated ? ".replaceAll(' ', '')" : "?.name?.replaceAll(' ', '') ?? ''"}}${formatTagName(node, nativeWrappers)}`);
    } else {
      const innerText = getInnerText(node);
      if (innerText && !name.includes(innerText)) {
        name += `-${innerText}`;
      }
      return staticAttributeValue(`${componentName}-${name}${formatTagName(node, nativeWrappers)}`);
    }
  }
}

// NOTE: We intentionally keep the underlying helper functions public so the transform can
// compute decisions incrementally (instead of bundling all signals into one return object).

export function formatTagName(node: ElementNode, nativeWrappers: NativeWrappersMap): string {
  if (Object.keys(nativeWrappers).includes(node.tag)) {
    return `-${nativeWrappers[node.tag].role}`;
  }

  // eslint-disable-next-line no-restricted-syntax
  const nodeName = node.tag.replace(/-/g, "").toLowerCase();
  return `-${nodeName}`;
}

/**
 * Extracts the route name from a :to directive with an object value
 *
 * Parses patterns like:
 * - :to="{ name: 'routeName' }"
 * - :to="{ name: 'routeName', params: {...} }"
 *
 * Returns the route name in PascalCase, or null if not found.
 *
 * @internal
 */
function toDirectiveObjectFieldNameValue(node: DirectiveNode): string | null {
  if (!node.exp || (node.exp.type !== NodeTypes.COMPOUND_EXPRESSION && node.exp.type !== NodeTypes.SIMPLE_EXPRESSION)) {
    return null;
  }

  const source = (node.exp as CompoundExpressionNode).loc.source.trim();
  try {
    const expr = parseExpression(source, { plugins: ["typescript"] }) as object;

    const isNodeType = (n: object | null, type: string): n is { type: string } => {
      return n !== null && (n as { type?: string }).type === type;
    };
    const isStringLiteralNode = (n: object | null): n is { type: "StringLiteral"; value: string } => {
      return isNodeType(n, "StringLiteral") && typeof (n as { value?: string }).value === "string";
    };
    const isIdentifierNode = (n: object | null): n is { type: "Identifier"; name: string } => {
      return isNodeType(n, "Identifier") && typeof (n as { name?: string }).name === "string";
    };
    const isObjectPropertyNode = (n: object | null): n is { type: "ObjectProperty"; key: object; value: object } => {
      if (!isNodeType(n, "ObjectProperty"))
        return false;
      const nn = n as { key?: object; value?: object };
      return typeof nn.key === "object" && nn.key !== null && typeof nn.value === "object" && nn.value !== null;
    };
    const isObjectExpressionNode = (n: object | null): n is { type: "ObjectExpression"; properties: object[] } => {
      if (!isNodeType(n, "ObjectExpression"))
        return false;
      const nn = n as { properties?: object[] };
      return Array.isArray(nn.properties);
    };

    if (!isObjectExpressionNode(expr))
      return null;

    const nameProp = (expr as { properties: object[] }).properties.find((p) => {
      if (!isObjectPropertyNode(p))
        return false;
      const key = p.key as object;
      return (isIdentifierNode(key) && key.name === "name") || (isStringLiteralNode(key) && key.value === "name");
    });
    if (!nameProp || !isObjectPropertyNode(nameProp) || !isStringLiteralNode(nameProp.value as object))
      return null;
    return toPascalCase((nameProp.value as { value: string }).value);
  }
  catch {
    return null;
  }
}

export function addComponentTestIds(componentName: string, componentTestIds: Map<string, Set<string>>, desiredTestId: string) {
  if (!componentTestIds.has(componentName)) {
    componentTestIds.set(componentName, new Set<string>());
  }
  componentTestIds.get(componentName)?.add(desiredTestId);
}

// Helper function to generate test IDs //method name must start verb word
// NOTE: generateTestId intentionally removed.
// The transform now inlines the three primary code paths (handler/to/click) directly.

export function getComposedClickHandlerContent(
  node: ElementNode,
  context: TransformContext,
  innerText: string | null,
  clickDirective?: DirectiveNode,
  options: { strictNaming?: boolean; componentName?: string; contextFilename?: string } = {}
): string {
  // Prefer caller-provided directive (so we don't re-scan props multiple times).
  const click = clickDirective ?? tryGetClickDirective(node);
  if (!click) {
    return innerText ? `-${innerText}` : "";
  }

  // Extract handler name from directive expression
  let handlerName = "";

  if (click.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
    const astValue = click.exp.ast;

    // Prefer AST-derived handler extraction. This is the most robust path (supports arrow wrappers,
    // optional chaining, logical guards, Program/statement handlers, etc) and avoids string/regex parsing.
    if (astValue && typeof astValue === "object") {
      const astName = getStableClickHandlerNameFromAst(astValue as BabelNode);
      if (astName) {
        handlerName = astName;
      }
    }

    // Vue parser fast-path: when the directive expression is a simple identifier,
    // Vue sets exp.ast = null. In that case, exp.content is already the stable name.
    if (!handlerName && astValue === null) {
      handlerName = click.exp.content.trim();
    }

    // Special-case: v-model style toggle expansion like `setPrimaryUser = !setPrimaryUser`.
    // This yields a stable semantic name (`setPrimaryUser`) even though it's an assignment.
    if (!handlerName && astValue && typeof astValue === "object") {
      // Special-case: v-model style toggle expansion like `setPrimaryUser = !setPrimaryUser`.
      // This yields a stable semantic name (`setPrimaryUser`) even though it's an assignment.
      const ast = astValue as AssignmentExpression;
      if (
        ast
        && ast.left?.type === "Identifier"
        && ast.right.type === "UnaryExpression"
        && ast.right.operator === "!"
        && ast.right.argument.type === "Identifier"
        && ast.right.argument.name === ast.left.name
      ) {
        handlerName = ast.left.name;
      }
    }
  }

  handlerName = normalizeHandlerName(handlerName);

  // Normalize handler names for codegen:
  // - innerText comes in kebab-ish already (via getInnerText)
  // - handler names are typically camelCase; convert to PascalCase for readability/stability
  const normalizedHandlerSegment = handlerName ? `-${toPascalCase(handlerName)}` : "";
  const result = normalizedHandlerSegment || (innerText ? `-${innerText}` : "");

  // In strict mode, require a stable name signal for clickable elements.
  // Without either a resolvable handler name or literal inner text, the generated data-testid
  // will be too generic and likely collide.
  if (options.strictNaming === true && !result) {
    const componentName = options.componentName ?? "unknown";
    const filename = options.contextFilename ?? context?.filename ?? "unknown";

    const loc = node.loc?.start;
    const locationHint = loc ? `${loc.line}:${loc.column}` : "unknown";

    const clip = (value: string | undefined, max = 220) => {
      const v = (value ?? "").trim();
      if (!v)
        return "";
      return v.length > max ? `${v.slice(0, max)}…` : v;
    };

    const elementSource = clip(node.loc?.source);
    const clickDirectiveSource = clip(click.loc?.source);
    const clickExpressionSource = clip(click.exp?.loc?.source);

    const lines = [
      `[vue-pom-generator] Unable to derive a stable name for clickable element in ${componentName} (${filename}:${locationHint}).`,
      elementSource ? `Element: ${elementSource}` : "",
      clickDirectiveSource ? `Click: ${clickDirectiveSource}` : "",
      clickExpressionSource ? `Click expression: ${clickExpressionSource}` : "",
      `Fix: add an explicit test id attribute, or use a named click handler (e.g. @click="save"), or provide literal button text.`,
    ].filter(Boolean);

    throw new Error(lines.join("\n"));
  }

  // eslint-disable-next-line no-restricted-syntax
  return result.replace(/[^a-z-]/gi, "");
}

function extractEmittedEventNameFromAst(ast: BabelNode): string {
  // Vue may give us:
  // - Expression (most common)
  // - ExpressionStatement wrapper
  // - Program (v-on with `;` => statements parse mode)
  // - File (depending on who parsed it)
  // This helper makes emit('$event') discoverable across those shapes.

  const root: BabelNode = isFile(ast) ? (ast as File).program : ast;

  const found = walkForEmittedEventName(root);
  return found || "";
}

function walkForEmittedEventName(node: object | null): string | null {
  if (!node)
    return null;

  const n = node as BabelNode;

  // Handle calls: emit('event') / $emit('event')
  if (isCallExpression(n) || isOptionalCallExpression(n)) {
    const callee = n.callee;
    if (isIdentifier(callee) && (callee.name === "emit" || callee.name === "$emit")) {
      const firstArg = n.arguments[0];
      if (firstArg && isStringLiteral(firstArg)) {
        return firstArg.value;
      }
    }
  }

  // Special-case Program so we don't depend on VISITOR_KEYS for top-level.
  if (isProgram(n)) {
    for (const stmt of (n as Program).body) {
      const hit = walkForEmittedEventName(stmt);
      if (hit)
        return hit;
    }
    return null;
  }

  const keys = VISITOR_KEYS[n.type] as readonly string[] | undefined;
  if (!keys)
    return null;

  type NodeChild = BabelNode | BabelNode[] | null | undefined | string | number | boolean;
  for (const key of keys) {
    const child = Reflect.get(n as object, key) as NodeChild;
    if (!child)
      continue;

    if (Array.isArray(child)) {
      for (const item of child) {
        // Only recurse into object nodes
        if (item && typeof item === "object") {
          const hit = walkForEmittedEventName(item);
          if (hit)
            return hit;
        }
      }
      continue;
    }

    if (typeof child === "object") {
      const hit = walkForEmittedEventName(child);
      if (hit)
        return hit;
    }
  }

  return null;
}

function getStableClickHandlerNameFromAst(ast: BabelNode | undefined): string {
  if (!ast)
    return "";

  // First, try to find emitted event names anywhere in the handler AST.
  // This covers:
  // - @click="emit('clicked')"
  // - @click="a(); emit('clicked')" (Program)
  // - @click="if (x) emit('clicked')" (statement-shaped)
  const emitted = extractEmittedEventNameFromAst(ast);
  if (emitted)
    return emitted;

  // Vue's expression AST sometimes wraps as ExpressionStatement.
  if (isExpressionStatement(ast)) {
    return getStableClickHandlerNameFromExpression(ast.expression);
  }

  // Most often it's already an Expression.
  return getStableClickHandlerNameFromExpression(ast);
}

function getStableClickHandlerNameFromExpression(exp: BabelNode | null | undefined): string {
  if (!exp)
    return "";

  // Arrow wrapper: () => selectCommand(...)
  if (isArrowFunctionExpression(exp)) {
    const body = exp.body;
    // Body can be an Expression or a BlockStatement. We only support expression bodies here.
    if (body && !isBlockStatement(body)) {
      return getStableClickHandlerNameFromExpression(body);
    }
    return "";
  }

  // emit('event') / $emit('event') calls
  if (isCallExpression(exp) || isOptionalCallExpression(exp)) {
    const callee = exp.callee;
    if (isIdentifier(callee) && callee.name === "emit") {
      const firstArg = exp.arguments[0];
      if (firstArg && isStringLiteral(firstArg)) {
        return firstArg.value;
      }
    }
    if (isIdentifier(callee) && callee.name === "$emit") {
      const firstArg = exp.arguments[0];
      if (firstArg && isStringLiteral(firstArg)) {
        return firstArg.value;
      }
    }
    return extractNameFromCallee(callee);
  }

  if (isAssignmentExpression(exp)) {
    // Best-effort: stable semantic name from the LHS.
    const left = exp.left;
    if (isIdentifier(left))
      return left.name;
    if (isMemberExpression(left) || isOptionalMemberExpression(left))
      return extractMemberPropertyName(left);
    return "";
  }

  // Optional chaining: foo?.bar / foo?.bar()
  if (isOptionalMemberExpression(exp)) {
    return extractMemberPropertyName(exp);
  }

  if (isMemberExpression(exp)) {
    return extractMemberPropertyName(exp);
  }

  if (isIdentifier(exp)) {
    return exp.name;
  }

  // clickGuard && doThing()
  if (isLogicalExpression(exp)) {
    return getStableClickHandlerNameFromExpression(exp.right);
  }

  // cond ? a() : b()
  if (isConditionalExpression(exp)) {
    // Prefer a stable name if both branches resolve identically.
    const cons = getStableClickHandlerNameFromExpression(exp.consequent);
    const alt = getStableClickHandlerNameFromExpression(exp.alternate);
    if (cons && cons === alt)
      return cons;
    return cons || alt;
  }

  // (a(), doThing())
  if (isSequenceExpression(exp)) {
    const last = exp.expressions[exp.expressions.length - 1];
    return getStableClickHandlerNameFromExpression(last);
  }

  return "";
}

function getClickHandlerNameFromAst(ast: BabelNode | undefined): { name: string; isAssignment: boolean } {
  if (!ast) {
    return { name: "", isAssignment: false };
  }

  if (isAssignmentExpression(ast)) {
    // Best-effort: treat simple assignment as a stable semantic name derived from the LHS.
    // Examples:
    // - showAdvanced = !showAdvanced      -> showAdvanced
    // - model.semanticVersion = suggested -> semanticVersion
    const left = ast.left;
    if (isIdentifier(left)) {
      return { name: left.name, isAssignment: true };
    }
    if (isMemberExpression(left)) {
      return { name: extractMemberPropertyName(left), isAssignment: true };
    }
    return { name: "", isAssignment: true };
  }

  if (isCallExpression(ast)) {
    return { name: extractNameFromCallee(ast.callee), isAssignment: false };
  }

  if (isMemberExpression(ast)) {
    return { name: extractMemberPropertyName(ast), isAssignment: false };
  }

  if (isIdentifier(ast)) {
    return { name: ast.name, isAssignment: false };
  }

  return { name: "", isAssignment: false };
}

function extractNameFromCallee(callee: BabelNode): string {
  if (isIdentifier(callee)) {
    return callee.name;
  }

  if (isMemberExpression(callee)) {
    return extractMemberPropertyName(callee);
  }

  if (isOptionalMemberExpression(callee)) {
    return extractMemberPropertyName(callee);
  }

  return "";
}

function extractMemberPropertyName(member: MemberExpression | OptionalMemberExpression): string {
  if (member.computed) {
    return "";
  }

  const prop = member.property;
  if (isIdentifier(prop)) {
    return prop.name;
  }

  return "";
}

function normalizeHandlerName(name: string): string {
  if (!name) {
    return "";
  }

  const sanitized = name.toLowerCase().startsWith("on") ? name.slice(2) : name;
  return sanitized;
}

export function getInnerText(node: ElementNode): string {
  // Use Vue compiler AST: children can be VText, Interpolation, or other nodes
  // eslint-disable-next-line no-restricted-syntax
  const innerText = (node.children || [])
    .filter((child): child is TextNode =>
      child.type === NodeTypes.TEXT
      && Boolean(child.content?.trim())
    )
    .map(child => child.content.trim())
    .join(" ")
    // eslint-disable-next-line no-restricted-syntax
    .replace(/\([^)]*\)/g, "") // Remove everything in ( )
    // eslint-disable-next-line no-restricted-syntax
    .replace(/["'`;:.,!?_—\-\\/]/g, "") // Remove quotes, punctuation, forward/back slashes
    // eslint-disable-next-line no-restricted-syntax
    .replace(/[^a-z\s]/gi, "") // Remove non-alphabetic characters
    // eslint-disable-next-line no-restricted-syntax
    .replace(/\s+/g, "-");

  return innerText || "";
}


/**
 * Finds an existing test id attribute (static or bound).
 */
export function findTestIdAttribute(element: ElementNode, attributeName: string): AttributeNode | DirectiveNode | null {
  const staticAttr = findAttributeByKey(element, attributeName);
  if (staticAttr)
    return staticAttr;

  return findDirectiveByName(element, "bind", attributeName) ?? null;
}

/**
 * Finds an existing data-testid attribute.
 *
 * @deprecated Prefer `findTestIdAttribute(element, attributeName)`.
 */
export function findDataTestIdAttribute(element: ElementNode): AttributeNode | DirectiveNode | null {
  return findTestIdAttribute(element, "data-testid");
}

/**
 * Upserts a test id attribute (static or bound) on an element.
 * Removes existing matches before adding the new value.
 */
export function upsertAttribute(
  element: ElementNode,
  attributeName: string,
  value: AttributeValue,
): void {
  element.props = element.props.filter((prop) => {
    // Remove static attribute: data-testid="..."
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === attributeName) {
      return false;
    }

    // Remove dynamic directive: :data-testid="..." or v-bind:data-testid="..."
    if (
      prop.type === NodeTypes.DIRECTIVE
      && prop.name === "bind"
      && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && prop.arg.content === attributeName
    ) {
      return false;
    }

    return true;
  });

  if (value.kind === "template") {
    // Dynamic binding: :data-testid="`ComponentName_tag_${key}`"
    element.props.push({
      type: NodeTypes.DIRECTIVE,
      name: "bind",
      arg: {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: attributeName,
        isStatic: true,
        constType: 0,
        loc: element.loc,
      },
      exp: createSimpleExpression(`\`${value.template}\``, false, element.loc),
      modifiers: [],
      loc: element.loc,
    } as DirectiveNode);
  }
  else {
    // Static attribute: data-testid="ComponentName_tag_button"
    element.props.push({
      type: NodeTypes.ATTRIBUTE,
      name: attributeName,
      value: {
        type: NodeTypes.TEXT,
        content: value.value,
        loc: element.loc,
      },
      loc: element.loc,
    } as AttributeNode);
  }
}

export interface ExistingElementDataTestIdInfo {
  value: string;
  /** Whether the provided test id is clearly dynamic (e.g. template literal with expressions). */
  isDynamic: boolean;
  /** Whether the value is a statically-known literal (safe to join). */
  isStaticLiteral: boolean;
}

/**
 * Extracts existing data-testid info from an element.
 *
 * Supports:
 * - data-testid="literal"
 * - :data-testid="`Foo-${bar}`" (TemplateLiteral)
 * - :data-testid="'foo'" (StringLiteral)
 *
 * Unknown expressions are treated as dynamic/unknown.
 */
export function tryGetExistingElementDataTestId(node: ElementNode, attributeName: string = "data-testid"): ExistingElementDataTestIdInfo | null {
  const existing = findTestIdAttribute(node, attributeName);
  if (!existing) {
    return null;
  }

  if (existing.type === NodeTypes.ATTRIBUTE) {
    const value = existing.value?.content ?? null;
    if (!value) {
      return null;
    }
    // A static attribute is always treated as a literal string.
    // (If it contains "${" it's still just characters, not interpolation.)
    return { value, isDynamic: false, isStaticLiteral: true };
  }

  // :data-testid="..." / v-bind:data-testid="..."
  const directive = existing as DirectiveNode;
  const exp = directive.exp;
  if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION) {
    return null;
  }

  // Prefer AST-based detection when available.
  // Vue's compiler attaches Babel AST to SimpleExpressionNode.exp.ast.
  const simpleExp = exp as SimpleExpressionNode;
  const ast = simpleExp.ast;

  // Template literal: :data-testid="`Foo-${bar}`"
  // - If it has zero expressions, it's effectively a static string.
  // - If it has expressions, it's dynamic.
  if (ast && typeof ast === "object" && "type" in ast && (ast as { type: string }).type === "TemplateLiteral") {
    const tl = ast as { quasis: Array<{ value?: { cooked?: string } }>; expressions: unknown[] };
    const cooked = (tl.quasis ?? []).map(q => q.value?.cooked ?? "").join("");
    const isStatic = (tl.expressions ?? []).length === 0;
    return { value: cooked, isDynamic: !isStatic, isStaticLiteral: isStatic };
  }

  // String literal: :data-testid="'foo'"
  if (ast && typeof ast === "object" && "type" in ast && (ast as { type: string }).type === "StringLiteral") {
    const sl = ast as { value?: string };
    const value = sl.value ?? "";
    if (!value) {
      return null;
    }
    return { value, isDynamic: false, isStaticLiteral: true };
  }

  // Fallback: we have no parseable AST shape (identifier/call/etc).
  // Treat as dynamic/unknown to avoid false positives.
  const raw = (simpleExp.content ?? "").trim();
  if (!raw) {
    return null;
  }

  return { value: raw, isDynamic: true, isStaticLiteral: false };
}

function replaceAllTemplateExpressionsWithKey(literalAst: TemplateLiteral) {
  const quasis = literalAst.quasis.map(q => q.value.raw ?? "");
  let out = quasis[0] ?? "";
  for (let i = 1; i < quasis.length; i++) {
    out += `\${key}${quasis[i] ?? ""}`;
  }
  return out;
}

function isTemplatePlaceholder(part: string) {
  // Avoid regex literals here; this only needs to detect the simple `${...}` wrapper.
  return part.startsWith("${") && part.endsWith("}") && part.length >= 3;
}

function splitOnDash(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "-") {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function isAllCapsOrDigits(value: string): boolean {
  if (value.length <= 1) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isDigit = c >= 48 && c <= 57;
    if (!isUpper && !isDigit) {
      return false;
    }
  }
  return true;
}

function startsWithDigit(value: string): boolean {
  if (!value.length) {
    return false;
  }
  const c = value.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function stripNonIdentifierChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    const isDigit = c >= 48 && c <= 57;
    const isUnderscore = c === 95;
    if (isUpper || isLower || isDigit || isUnderscore) {
      out += value[i];
    }
  }
  return out;
}

function safeMethodNameFromParts(parts: string[]) {
  const toPascalCasePreserveAcronyms = (p: string) => {
    // Preserve all-caps identifiers (e.g. DEPLOY, HTTP, ID) so we don't
    // collapse them into the same name as title-cased variants.
    const trimmed = p.trim();
    if (isAllCapsOrDigits(trimmed)) {
      return trimmed;
    }
    return toPascalCase(trimmed);
  };

  const cleaned = parts
    .map(p => p.trim())
    .filter(p => p.length > 0)
    // Drop any dynamic placeholders from method names; they map to the `key` param.
    .filter(p => !isTemplatePlaceholder(p));

  const rawName = cleaned.map(toPascalCasePreserveAcronyms).join("");
  const name = stripNonIdentifierChars(rawName);
  if (!name.length) {
    return "Element";
  }
  // Identifiers cannot start with a digit.
  if (startsWithDigit(name)) {
    return `Value${name}`;
  }
  return name;
}

function getMethodInfoForDataTestIdInternal(
  componentName: string,
  dataTestIdAttribute: AttributeValue,
  nativeRole?: string,
): {
  methodName: string;
  formattedDataTestId: string;
  params: Record<string, string>;
} {
  const dataTestIdValue = getAttributeValueText(dataTestIdAttribute);
  const parsed = parseExpression(`\`${dataTestIdValue}\``, { plugins: ["typescript"] }) as BabelNode;
  if (!isTemplateLiteral(parsed)) {
    throw new Error("Expected TemplateLiteral when parsing data-testid");
  }
  const literalAst = parsed as TemplateLiteral;

  const isDynamic = (literalAst.expressions?.length ?? 0) > 0;
  const formattedDataTestId = isDynamic
    ? replaceAllTemplateExpressionsWithKey(literalAst)
    : dataTestIdValue;
  const parts = splitOnDash(formattedDataTestId);

  const rolesToStripFromMethodName = new Set([
    "button",
    "input",
    "select",
    "checkbox",
  ]);

  if (nativeRole && rolesToStripFromMethodName.has(nativeRole.toLowerCase()) && parts.length > 1) {
    const last = (parts[parts.length - 1] || "").toLowerCase();
    if (last === nativeRole.toLowerCase()) {
      parts.pop();
    }
  }

  // If the component prefix is present (ComponentName-...), drop it from the method name.
  if (parts.length && parts[0] === componentName) {
    parts.shift();
  }

  let methodName = safeMethodNameFromParts(parts);
  if (isDynamic && !methodName.endsWith("ByKey")) {
    methodName = `${methodName}ByKey`;
  }

  if (methodName === "Element" && nativeRole) {
    const roleName = upperFirst(toPascalCase(nativeRole));
    methodName = isDynamic ? `${roleName}ByKey` : roleName;
  }

  const params: Record<string, string> = {};
  if (isDynamic) {
    params.key = "string";
  }

  switch ((nativeRole ?? "").toLowerCase()) {
    case "input":
      params.text = "string";
      params.annotationText = "string = \"\"";
      delete params.key;
      break;
    case "select":
      params.value = "string";
      params.annotationText = "string = \"\"";
      delete params.key;
      break;
    case "vselect":
      params.value = "string";
      params.timeOut = "number = 500";
      params.annotationText = "string = \"\"";
      delete params.key;
      break;
    case "radio":
      params.annotationText = "string = \"\"";
      break;
    default:
      break;
  }

  return { methodName, formattedDataTestId, params };
}

// Internal exports for unit testing (not part of the public plugin API).
export const __internal = {
  replaceAllTemplateExpressionsWithKey(literal: string) {
    const parsed = parseExpression(`\`${literal}\``, { plugins: ["typescript"] }) as BabelNode;
    if (!isTemplateLiteral(parsed)) {
      throw new Error("Expected TemplateLiteral when parsing data-testid");
    }
    return replaceAllTemplateExpressionsWithKey(parsed as TemplateLiteral);
  },
  safeMethodNameFromParts,
};

/**
 * Resolve/apply a data-testid for an element, record it into dependencies, and append generated POM method content.
 *
 * This respects author-provided data-testid attributes and enforces v-for uniqueness rules when a key placeholder is present.
 */
export function applyResolvedDataTestId(args: {
  element: ElementNode;
  componentName: string;
  parentComponentName: string;
  context?: TransformContext | null;
  contextFilename?: string;
  dependencies: IComponentDependencies;
  generatedMethodContentByComponent: Map<string, Set<string>>;
  nativeRole: string;
  preferredGeneratedValue: AttributeValue;
  bestKeyPlaceholder: string | null;
  /** Optional enumerable key values (e.g. derived from v-for="item in ['One','Two']"). */
  keyValuesOverride?: string[] | null;
  entryOverrides?: Partial<IDataTestId>;
  addHtmlAttribute?: boolean;
  /** Attribute name to use for injection and parsing. Defaults to data-testid. */
  testIdAttribute?: string;
}): void {
  const addHtmlAttribute = args.addHtmlAttribute ?? true;
  const entryOverrides = args.entryOverrides ?? {};
  const testIdAttribute = args.testIdAttribute ?? "data-testid";

  // 1) Resolve effective data-testid (respecting any existing attribute).
  let dataTestId = args.preferredGeneratedValue;
  let fromExisting = false;

  const existing = tryGetExistingElementDataTestId(args.element, testIdAttribute);
  if (existing) {
    if (args.bestKeyPlaceholder && existing.isStaticLiteral) {
      const loc = args.element.loc?.start;
      const locationHint = loc ? `${loc.line}:${loc.column}` : "unknown";
      const file = args.contextFilename ?? "unknown";
      const attrLabel = testIdAttribute || "data-testid";
      throw new Error(
        `[vue-pom-generator] Existing ${attrLabel} appears to be missing the key placeholder needed to keep it unique.\n`
        + `Component: ${args.componentName}\n`
        + `File: ${file}:${locationHint}\n`
        + `Existing ${attrLabel}: ${JSON.stringify(existing.value)}\n`
        + `Required placeholder: ${JSON.stringify(args.bestKeyPlaceholder)}\n\n`
        + `Fix: either (1) include ${args.bestKeyPlaceholder} in your :${attrLabel} template literal, or (2) remove the explicit ${attrLabel} so it can be auto-generated.`,
      );
    }

    dataTestId = staticAttributeValue(existing.value);
    fromExisting = true;
  }

  // 2) Derive method naming/params based on the effective data-testid.
  const { methodName, formattedDataTestId: elementDataTestIdForMethod, params } = getMethodInfoForDataTestIdInternal(
    args.parentComponentName,
    dataTestId,
    args.nativeRole,
  );

  const getKeyTypeFromValues = (values: string[] | null | undefined) => {
    if (!values || values.length === 0) {
      return "string";
    }
    return values.map(v => JSON.stringify(v)).join(" | ");
  };

  const keyTypeFromValues = getKeyTypeFromValues(args.keyValuesOverride ?? null);

  // If the caller provided enumerable key values (e.g. derived from a static v-for list),
  // propagate a literal-union type into the underlying keyed locator method signature.
  if (keyTypeFromValues !== "string" && Object.prototype.hasOwnProperty.call(params, "key")) {
    params.key = keyTypeFromValues;
  }

  // 3) Apply attribute (only when we generated it) and register for POM generation.
  if (addHtmlAttribute && !fromExisting) {
    upsertAttribute(args.element, testIdAttribute, dataTestId);
  }

  const childComponentName = args.element.tag;
  const dataTestIdEntry: IDataTestId = {
    value: getAttributeValueText(dataTestId),
    templateLiteral: undefined,
    ...entryOverrides,
  };

  args.dependencies.childrenComponentSet.add(childComponentName);
  args.dependencies.usedComponentSet.add(childComponentName);
  args.dependencies.dataTestIdSet.add(dataTestIdEntry);

  const normalizeNativeRole = (value: string): NativeRole | undefined => {
    const role = (value || "").toLowerCase();
    switch (role) {
      case "button":
      case "input":
      case "select":
      case "vselect":
      case "checkbox":
      case "toggle":
      case "radio":
        return role;
      default:
        return undefined;
    }
  };

  const getGeneratedMethodName = () => {
    const role = normalizeNativeRole(args.nativeRole);
    const isNavigation = !!dataTestIdEntry.targetPageObjectModelClass;

    const methodNameUpper = upperFirst(methodName);
    const radioMethodNameUpper = upperFirst(methodName || "Radio");

    if (isNavigation) {
      return `goTo${methodNameUpper}`;
    }

    switch (role) {
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
  };

  const getSignatureForGeneratedMethod = () => {
    const role = normalizeNativeRole(args.nativeRole);
    const isNavigation = !!dataTestIdEntry.targetPageObjectModelClass;
    const needsKey = Object.prototype.hasOwnProperty.call(params, "key");
    const keyType = keyTypeFromValues;

    if (isNavigation) {
      if (needsKey) {
        return { params: `key: ${keyType}`, argNames: ["key"] };
      }
      return { params: "", argNames: [] };
    }

    switch (role) {
      case "input":
        return { params: "text: string, annotationText: string = \"\"", argNames: ["text", "annotationText"] };
      case "select":
        return { params: "value: string, annotationText: string = \"\"", argNames: ["value", "annotationText"] };
      case "vselect":
        return { params: "value: string, timeOut = 500", argNames: ["value", "timeOut"] };
      case "radio":
        return needsKey
          ? { params: `key: ${keyType}, annotationText: string = ""`, argNames: ["key", "annotationText"] }
          : { params: "annotationText: string = \"\"", argNames: ["annotationText"] };
      default:
        if (needsKey) {
          return { params: `key: ${keyType}`, argNames: ["key"] };
        }
        return { params: "", argNames: [] };
    }
  };

  const methodContent = generateViewObjectModelMethodContent(
    dataTestIdEntry.targetPageObjectModelClass,
    methodName,
    args.nativeRole,
    elementDataTestIdForMethod,
    params,
  );

  const appendMethodOnce = (content: string) => {
    const normalizedKey = content.trim();
    if (!normalizedKey) {
      return;
    }
    const seen = args.generatedMethodContentByComponent.get(args.parentComponentName) ?? new Set<string>();
    if (!args.generatedMethodContentByComponent.has(args.parentComponentName)) {
      args.generatedMethodContentByComponent.set(args.parentComponentName, seen);
    }
    if (!seen.has(normalizedKey)) {
      seen.add(normalizedKey);
      args.dependencies.methodsContent ??= "";
      // Preserve indentation (important for readability in generated output).
      // De-duping is done via a normalized key instead of mutating the content.
      args.dependencies.methodsContent += `\n${content.trimEnd()}\n`;
    }
  };

  const registerGeneratedMethodSignature = (name: string, signature: { params: string; argNames: string[] } | null) => {
    args.dependencies.generatedMethods ??= new Map<string, { params: string; argNames: string[] } | null>();
    const prev = args.dependencies.generatedMethods.get(name);
    if (prev === undefined) {
      args.dependencies.generatedMethods.set(name, signature);
      return;
    }
    if (prev === null) {
      return;
    }
    if (signature === null || prev.params !== signature.params) {
      args.dependencies.generatedMethods.set(name, null);
    }
  };

  const reservedGeneratedNames = new Set<string>();
  const ensureUniqueGeneratedName = (baseName: string) => {
    let candidate = baseName;
    let i = 2;
    while (
      reservedGeneratedNames.has(candidate)
      || (args.dependencies.generatedMethods?.has(candidate) ?? false)
    ) {
      candidate = `${baseName}${i}`;
      i += 1;
    }
    reservedGeneratedNames.add(candidate);
    return candidate;
  };

  const tryGetDirectiveExpressionAst = (dir: DirectiveNode): BabelNode | null => {
    const exp = dir.exp;
    if (!exp) {
      return null;
    }

    // Prefer Vue-populated `exp.ast` when present.
    if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
      const simple = exp as SimpleExpressionNode;
      const ast = simple.ast as object | null;
      if (ast && "type" in ast) {
        return ast as BabelNode;
      }
    }

    // Fallback: parse the expression source.
    try {
      const raw = args.context ? stringifyExpression(exp) : exp.loc.source;
      return parseExpression(raw, { plugins: ["typescript"] }) as BabelNode;
    }
    catch {
      return null;
    }
  };

  const tryGetStaticStringFromBabel = (node: BabelNode | null): string | null => {
    if (!node) {
      return null;
    }
    if (isStringLiteral(node)) {
      return node.value;
    }
    if (isTemplateLiteral(node)) {
      // Only treat template literals with no expressions as static.
      if ((node.expressions ?? []).length > 0) {
        return null;
      }
      return (node.quasis ?? []).map(q => q.value?.cooked ?? "").join("");
    }
    return null;
  };

  const tryExtractStaticOptionLabelsFromOptionsAst = (optionsAst: BabelNode): string[] | null => {
    if (!isArrayExpression(optionsAst)) {
      return null;
    }

    const arr = optionsAst as ArrayExpression;
    const out: string[] = [];

    for (const el of (arr.elements ?? [])) {
      if (!el) {
        continue;
      }

      // Allow array-of-strings: ["A", "B"]
      const literal = tryGetStaticStringFromBabel(el as BabelNode);
      if (literal !== null) {
        if (literal.trim()) {
          out.push(literal);
        }
        continue;
      }

      // Allow array-of-objects: [{ text: "A" }, { label: "B" }]
      if (!isObjectExpression(el as BabelNode)) {
        return null;
      }
      const obj = el as ObjectExpression;

      const labelKeys = new Set(["text", "label", "name", "title"]);
      const props = (obj.properties ?? []) as unknown[];

      const findProp = () => {
        for (const p of props) {
          if (!p || typeof p !== "object") {
            continue;
          }
          const prop = p as BabelNode;
          if (!isObjectProperty(prop)) {
            continue;
          }
          const op = prop as ObjectProperty;
          const keyNode = op.key;
          const keyName = isIdentifier(keyNode)
            ? keyNode.name
            : (isStringLiteral(keyNode) ? keyNode.value : "");
          if (!labelKeys.has(keyName)) {
            continue;
          }
          return op;
        }
        return null;
      };

      const labelProp = findProp();
      if (!labelProp) {
        return null;
      }

      const label = tryGetStaticStringFromBabel(labelProp.value as BabelNode);
      if (label === null || !label.trim()) {
        return null;
      }
      out.push(label);
    }

    return out.length ? out : null;
  };

  // Special handling for option-driven wrappers.
  // If an element has an `:options` directive and represents a radio-group-like wrapper,
  // attempt to generate more ergonomic per-option methods.
  const normalizedRole = normalizeNativeRole(args.nativeRole);
  const optionsDirective = findDirectiveByName(args.element, "bind", "options");
  const canHandleOptions = normalizedRole === "radio" && !!optionsDirective?.exp;

  if (canHandleOptions) {
    // The wrapper data-testid is typically: `${prefix}-radio`.
    // The option data-testid is typically: `${prefix}_${OptionText}_radio`.
    const wrapperTestId = elementDataTestIdForMethod;
    const prefix = wrapperTestId.endsWith("-radio")
      ? wrapperTestId.slice(0, -"-radio".length)
      : wrapperTestId;

    const optionsAst = optionsDirective ? tryGetDirectiveExpressionAst(optionsDirective) : null;
    const staticLabels = optionsAst ? tryExtractStaticOptionLabelsFromOptionsAst(optionsAst) : null;

    // We derive the base method name from the existing methodName, but strip the "Radio" suffix
    // so option methods read like `selectFooBarBaz()` instead of `selectFooBarRadioBaz()`.
    const base = methodName.endsWith("Radio") ? methodName.slice(0, -"Radio".length) : methodName;
    const baseUpper = upperFirst(base || "Radio");

    if (staticLabels && staticLabels.length) {
      for (const label of staticLabels) {
        const optionPart = getDataTestIdFromGroupOption(label);
        if (!optionPart) {
          continue;
        }

        const optionTestId = `${prefix}_${optionPart}_radio`;
        const safeOptionSuffix = toPascalCase(label) || optionPart;
        const generatedName = ensureUniqueGeneratedName(`select${baseUpper}${safeOptionSuffix}`);
        const optionTestIdLiteral = JSON.stringify(optionTestId);

        appendMethodOnce(
          `  async ${generatedName}(annotationText: string = "") {\n` +
          `    await this.clickByTestId(${optionTestIdLiteral}, annotationText);\n` +
          `  }\n`,
        );
        registerGeneratedMethodSignature(generatedName, { params: `annotationText: string = ""`, argNames: ["annotationText"] });
      }

      // For statically-known options, we intentionally do NOT generate the generic parameterized method.
      return;
    }

    // Dynamic options expression: generate a single method that accepts an option string.
    // We build the option test id using the provided value directly.
    const generatedName = `select${upperFirst(methodName || "Radio")}`;
    appendMethodOnce(
      `  async ${generatedName}(value: string, annotationText: string = "") {\n`
      + `    const testId = \`${prefix}_\${value}_radio\`;\n`
      + `    await this.clickByTestId(testId, annotationText);\n`
      + `  }\n`,
    );
    registerGeneratedMethodSignature(generatedName, { params: `value: string, annotationText: string = ""`, argNames: ["value", "annotationText"] });
    return;
  }

  // Special handling for v-for driven by a static literal list.
  // When we can enumerate the keys (e.g. ['One','Two']), prefer emitting separate
  // methods like `clickOneButton()` / `clickTwoButton()` instead of a single
  // `click*ByKey(key: ...)`.
  //
  // This keeps the POM ergonomic and avoids pushing key plumbing into tests.
  const staticKeyValues = (args.keyValuesOverride ?? null);
  const needsKey = Object.prototype.hasOwnProperty.call(params, "key")
    && typeof elementDataTestIdForMethod === "string"
    && elementDataTestIdForMethod.includes("${key}");
  const isNavigation = !!dataTestIdEntry.targetPageObjectModelClass;

  if (
    staticKeyValues
    && staticKeyValues.length > 0
    && needsKey
    && !isNavigation
    && normalizedRole !== "input"
    && normalizedRole !== "select"
    && normalizedRole !== "vselect"
    && normalizedRole !== "radio"
  ) {
    const roleSuffix = upperFirst(toPascalCase(args.nativeRole || "Element"));

    for (const rawValue of staticKeyValues) {
      const valueName = toPascalCase(rawValue);
      if (!valueName) {
        continue;
      }

      const generatedName = ensureUniqueGeneratedName(`click${valueName}${roleSuffix}`);

      appendMethodOnce(
        `  async ${generatedName}(wait: boolean = true) {\n`
        + `    const key = ${JSON.stringify(rawValue)};\n`
        + `    await this.clickByTestId(\`${elementDataTestIdForMethod}\`, "", wait);\n`
        + `  }\n`,
      );

      registerGeneratedMethodSignature(generatedName, { params: `wait: boolean = true`, argNames: ["wait"] });
    }

    // For statically-known keys, we intentionally do NOT emit the generic keyed method.
    return;
  }

  appendMethodOnce(methodContent);
  const signature = getSignatureForGeneratedMethod();
  const generatedName = getGeneratedMethodName();
  registerGeneratedMethodSignature(generatedName, signature);
}

export interface IDataTestId {
  value: string;

  /** Optional parsed/constructed template literal for AST-based formatting in codegen. */
  templateLiteral?: TemplateLiteral;
  /** When the element is a router-link-like navigation, the resolved target page class name (e.g. TenantDetailsPage). */
  targetPageObjectModelClass?: string;
}

export interface IComponentDependencies {
  filePath: string;
  childrenComponentSet: Set<string>; // all child components used in this component
  /**
   * All component-like tags encountered in the template (PascalCase or kebab-case).
   *
   * Unlike childrenComponentSet, this is NOT gated by whether a data-testid was generated
   * for that element.
   */
  usedComponentSet: Set<string>;
  dataTestIdSet: Set<IDataTestId>; // all data-testid values used in this component
  /** Optional cached codegen output so buildEnd can skip re-deriving method strings. */
  methodsContent?: string;
  /**
   * Structured metadata about generated methods.
   *
   * Used by aggregated stub generation to safely emit pass-through methods
   * (e.g. NewTenantPage.typeTenantName delegates to TenantDetailsEditForm.typeTenantName)
   * without re-parsing the generated TypeScript.
   *
   * - key: method name
   * - value: { params, argNames } when the signature is known and consistent
   *          null when multiple distinct signatures were observed for the same name
   */
  generatedMethods?: Map<string, { params: string; argNames: string[] } | null>;
  isView?: boolean;
}
