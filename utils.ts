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
  isAssignmentPattern,
  isArrowFunctionExpression,
  isAssignmentExpression,
  isBooleanLiteral,
  isBlockStatement,
  isCallExpression,
  isConditionalExpression,
  isExpressionStatement,
  isFile,
  isIdentifier,
  isLogicalExpression,
  isMemberExpression,
  isNullLiteral,
  isObjectExpression,
  isObjectProperty,
  isNumericLiteral,
  isOptionalCallExpression,
  isOptionalMemberExpression,
  isObjectPattern,
  isProgram,
  isRestElement,
  isSequenceExpression,
  isStringLiteral,
  isTemplateLiteral,
} from "@babel/types";
import { parse, parseExpression } from "@babel/parser";
import { createTypeScriptWriter } from "./typescript-codegen";

export { isSimpleExpressionNode } from "./compiler/ast-guards";
export type { RouterIntrospectionResult } from "./router-introspection";
export {
  getRouteNameKeyFromToDirective,
  setResolveToComponentNameFn,
  setRouteNameToComponentNameMap,
  tryResolveToDirectiveTargetComponentName,
} from "./routing/to-directive";

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

export function isAsciiUppercaseLetterCode(code: number): boolean {
  return code >= 65 && code <= 90;
}

export function isAsciiLowercaseLetterCode(code: number): boolean {
  return code >= 97 && code <= 122;
}

export function isAsciiLetterCode(code: number): boolean {
  return isAsciiUppercaseLetterCode(code) || isAsciiLowercaseLetterCode(code);
}

export function isAsciiDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

export function isAsciiAlphaNumericCode(code: number): boolean {
  return isAsciiLetterCode(code) || isAsciiDigitCode(code);
}

export type NativeRole = 'button' | 'input' | 'select' | 'vselect' | 'checkbox' | 'toggle' | 'radio' | 'grid'
// In this plugin, the hierarchy map stores: key = child element, value = parent element (or null for root).
export type Child = ElementNode;
export type Parent = ElementNode | null;
export type HierarchyMap = Map<Child, Parent>
export interface NativeWrappersMap {
  [component: string]: {
    role: NativeRole
    valueAttribute?: string
    requiresOptionDataTestIdPrefix?: boolean
    inferred?: boolean
  }
}

export interface ParsedTemplateFragment {
  source: string;
  templateLiteral: TemplateLiteral;
}

export type AttributeValue =
  | { kind: "static"; value: string }
  | { kind: "template"; template: string; parsedTemplate: ParsedTemplateFragment };

type VueExpressionNode = SimpleExpressionNode | CompoundExpressionNode;

export interface ResolvedKeyInfo {
  selectorFragment: string;
  runtimeFragment: string;
  rawExpression: string | null;
}

export function staticAttributeValue(value: string): AttributeValue {
  return { kind: "static", value };
}

export function templateAttributeValue(template: string): Extract<AttributeValue, { kind: "template" }> {
  const parsedTemplate = tryParseTemplateFragment(template);
  if (!parsedTemplate) {
    throw new Error(`[vue-pom-generator] Failed to parse generated template fragment: ${template}`);
  }

  return { kind: "template", template, parsedTemplate };
}

export function getAttributeValueText(value: AttributeValue): string {
  return value.kind === "static" ? value.value : value.template;
}

/**
 * Reads source text from a Vue compiler expression using the preferred view order.
 *
 * - `content`: original SIMPLE_EXPRESSION content
 * - `loc`: author-written template source from `loc.source`
 * - `compiled`: compiler-rewritten source from `stringifyExpression()`
 */
export function getVueExpressionSource(
  expression: VueExpressionNode | null | undefined,
  ...preferredViews: Array<"content" | "loc" | "compiled">
): string {
  if (!expression) {
    return "";
  }

  for (const view of preferredViews) {
    let value = "";
    switch (view) {
      case "content":
        value = expression.type === NodeTypes.SIMPLE_EXPRESSION ? expression.content : "";
        break;
      case "loc":
        value = expression.loc?.source ?? "";
        break;
      case "compiled":
        try {
          value = stringifyExpression(expression);
        }
        catch {
          value = "";
        }
        break;
      default:
        value = "";
        break;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
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

function findTemplateSlotScopeExpression(node: ElementNode): VueExpressionNode | null {
  if (node.tag !== "template") {
    return null;
  }

  const slotProp = node.props.find((prop): prop is DirectiveNode => {
    return prop.type === NodeTypes.DIRECTIVE && prop.name === "slot";
  });

  return slotProp?.exp && (slotProp.exp.type === NodeTypes.SIMPLE_EXPRESSION || slotProp.exp.type === NodeTypes.COMPOUND_EXPRESSION)
    ? slotProp.exp as VueExpressionNode
    : null;
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
  return findTemplateSlotScopeExpression(node) !== null;
}

/**
 * Returns true when the raw slot-scope content parses as a single identifier expression.
 *
 * This is intentionally AST-based so object destructuring, member access, and other compound
 * expressions are rejected without relying on string heuristics.
 */
function isSimpleScopeIdentifier(value: string): boolean {
  if (!value) {
    return false;
  }

  try {
    return isIdentifier(parseExpression(value, { plugins: ["typescript"] }) as BabelNode);
  }
  catch {
    // Any parse failure means the slot scope is not a bare identifier.
    return false;
  }
}

function buildSlotScopeFallbackKeyExpression(identifier: string): string {
  return `${identifier}.key ?? ${identifier}.data?.id ?? ${identifier}.id ?? ${identifier}.value ?? ${identifier}`;
}

function tryGetBindingIdentifierName(node: BabelNode | null | undefined): string | null {
  if (!node) {
    return null;
  }

  if (isIdentifier(node)) {
    return node.name;
  }

  if (isAssignmentPattern(node)) {
    return tryGetBindingIdentifierName(node.left);
  }

  if (isRestElement(node)) {
    return tryGetBindingIdentifierName(node.argument);
  }

  return null;
}

type SlotScopeKeyCandidate = {
  priority: number;
  expression: string;
};

/**
 * Flattens a nullish-coalescing chain into its top-level operand source strings.
 *
 * For example, `foo ?? bar ?? baz` becomes `["foo", "bar", "baz"]`.
 */
function splitNullishCoalescingExpression(expr: string): string[] {
  const ast = parseExpression(expr, { plugins: ["typescript"] }) as BabelNode;

  const toSourceText = (node: BabelNode): string => {
    if (node.start == null || node.end == null) {
      throw new Error("[vue-pom-generator] Unable to recover source for nullish-coalescing expression.");
    }

    return expr.slice(node.start, node.end).trim();
  };

  const parts: string[] = [];
  const visit = (node: BabelNode): void => {
    if (isLogicalExpression(node) && node.operator === "??") {
      visit(node.left as BabelNode);
      visit(node.right as BabelNode);
      return;
    }

    const candidate = toSourceText(node);
    if (candidate) {
      parts.push(candidate);
    }
  };

  visit(ast);
  return parts;
}

function getSlotScopeObjectPropertyKeyName(node: BabelNode): string | null {
  if (isIdentifier(node)) {
    return node.name;
  }

  if (isStringLiteral(node)) {
    return node.value;
  }

  return null;
}

function tryGetSlotScopeKeyCandidate(node: BabelNode | null | undefined): SlotScopeKeyCandidate | null {
  if (!node) {
    return null;
  }

  if (isIdentifier(node)) {
    return {
      priority: 2,
      expression: buildSlotScopeFallbackKeyExpression(node.name),
    };
  }

  if (isAssignmentPattern(node)) {
    return tryGetSlotScopeKeyCandidate(node.left);
  }

  if (isRestElement(node)) {
    return tryGetSlotScopeKeyCandidate(node.argument);
  }

  if (!isObjectPattern(node)) {
    return null;
  }

  let best: SlotScopeKeyCandidate | null = null;

  for (const property of node.properties) {
    let candidate: SlotScopeKeyCandidate | null = null;

    if (isRestElement(property)) {
      candidate = tryGetSlotScopeKeyCandidate(property.argument);
      if (candidate) {
        candidate = { ...candidate, priority: Math.max(candidate.priority, 2) };
      }
    }
    else if (isObjectProperty(property)) {
      const keyName = getSlotScopeObjectPropertyKeyName(property.key as BabelNode);
      const bindingName = tryGetBindingIdentifierName(property.value as BabelNode)
        ?? tryGetBindingIdentifierName(property.key as BabelNode);

      if (bindingName) {
        if (keyName === "key" || bindingName === "key") {
          candidate = {
            priority: 0,
            expression: bindingName,
          };
        }
        else {
          candidate = {
            priority: keyName === "data" ? 1 : 2,
            expression: buildSlotScopeFallbackKeyExpression(bindingName),
          };
        }
      }
    }

    if (candidate && (!best || candidate.priority < best.priority)) {
      best = candidate;
    }
  }

  return best;
}

function tryGetTemplateSlotScopeBindingNode(expression: VueExpressionNode): BabelNode | null {
  const ast = ("ast" in expression ? expression.ast : null) as BabelNode | null | false | undefined;
  if (ast) {
    if (isArrowFunctionExpression(ast)) {
      return ast.params[0] as BabelNode | undefined ?? null;
    }
    return ast;
  }

  const rawSource = getVueExpressionSource(expression, "content", "loc", "compiled");
  if (!rawSource) {
    return null;
  }

  try {
    return parseExpression(rawSource, { plugins: ["typescript"] }) as BabelNode;
  }
  catch {
    // Slot-scope destructuring like `{ data }` is not a standalone expression, so parse it as
    // the parameter list of a synthetic arrow function to recover the binding pattern AST.
  }

  try {
    const parsed = parse(`(${rawSource}) => {}`, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    const statement = parsed.program.body[0];
    if (statement && isExpressionStatement(statement) && isArrowFunctionExpression(statement.expression)) {
      return statement.expression.params[0] as BabelNode | undefined ?? null;
    }
  }
  catch {
    return null;
  }

  return null;
}

function toResolvedTemplateFragment(source: string): InterpolatedTemplateFragment | null {
  const templateLiteral = tryUnwrapTemplateLiteralSource(source);
  if (templateLiteral) {
    return {
      template: templateLiteral.template,
      rawExpression: null,
    };
  }

  return toInterpolatedTemplateFragment(source);
}

function toResolvedKeyInfo(selectorSource: string | null, runtimeSource: string | null = selectorSource): ResolvedKeyInfo | null {
  const selectorFragment = selectorSource ? toResolvedTemplateFragment(selectorSource) : null;
  const runtimeFragment = runtimeSource ? toResolvedTemplateFragment(runtimeSource) : null;
  const selectorTemplate = selectorFragment?.template ?? runtimeFragment?.template ?? null;
  const runtimeTemplate = runtimeFragment?.template ?? selectorFragment?.template ?? null;
  if (!selectorTemplate || !runtimeTemplate) {
    return null;
  }

  return {
    selectorFragment: selectorTemplate,
    runtimeFragment: runtimeTemplate,
    rawExpression: runtimeFragment?.rawExpression ?? selectorFragment?.rawExpression ?? null,
  };
}

function tryGetTemplateSlotScopeKeyInfo(expression: VueExpressionNode): ResolvedKeyInfo | null {
  const bindingNode = tryGetTemplateSlotScopeBindingNode(expression);
  const candidateExpression = bindingNode ? tryGetSlotScopeKeyCandidate(bindingNode)?.expression ?? null : null;
  return candidateExpression ? toResolvedKeyInfo(candidateExpression) : null;
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
 * Attempts to unwrap a full template-literal expression source into its body text.
 *
 * @example
 * tryUnwrapTemplateLiteralSource("`row-${item.id}`")
 * // => { template: "row-${item.id}", expressionCount: 1 }
 *
 * @example
 * tryUnwrapTemplateLiteralSource("item.id")
 * // => null
 */
function tryUnwrapTemplateLiteralSource(source: string): { template: string; expressionCount: number } | null {
  const rawSource = source.trim();
  if (!rawSource) {
    return null;
  }

  let ast: BabelNode | null | false | undefined = null;
  try {
    ast = parseExpression(rawSource, { plugins: ["typescript"] }) as BabelNode;
  }
  catch {
    return null;
  }

  if (!ast || !isTemplateLiteral(ast)) {
    return null;
  }

  const cooked = ast.quasis.map(quasi => quasi.value.cooked ?? "").join("");
  try {
    const start = typeof ast.start === "number" ? ast.start + 1 : 1;
    const end = typeof ast.end === "number" ? ast.end - 1 : rawSource.length - 1;
    return {
      template: rawSource.slice(start, end) || cooked,
      expressionCount: ast.expressions.length,
    };
  }
  catch {
    return {
      template: cooked,
      expressionCount: ast.expressions.length,
    };
  }
}

/**
 * Attempts to unwrap a template-literal expression node into its body text.
 *
 * Accepts the original Vue template-expression node so callers stay on the AST-driven path.
 * Vue commonly represents template-literal bindings as `CompoundExpressionNode`s even when the
 * attached Babel AST is a single `TemplateLiteral`, so this helper intentionally accepts both
 * simple and compound expression nodes.
 *
 * Vue also exposes two different string views of the same binding:
 * - `loc.source` preserves the author-written local scope expression (e.g. `item.id`)
 * - `stringifyExpression()` emits the compiler-rewritten form (often including `_ctx.*`)
 *
 * We still prefer carrying structured AST metadata through the pipeline, but this helper is the
 * narrow bridge where we normalize those compiler-provided string forms before reparsing a template
 * fragment later on. That keeps the rest of the codebase from having to care which compiler view
 * produced the binding in the first place.
 *
 * @example
 * const exp = findDirectiveByName(node, "bind", "key")?.exp as SimpleExpressionNode | CompoundExpressionNode;
 * tryUnwrapTemplateLiteralExpressionSource(exp)
 * // => { template: "row-${item.id}", expressionCount: 1 }
 *
 * @example
 * const exp = findDirectiveByName(node, "bind", "key")?.exp as SimpleExpressionNode | CompoundExpressionNode;
 * tryUnwrapTemplateLiteralExpressionSource(exp)
 * // => null
 */
function tryUnwrapTemplateLiteralExpressionSource(expression: SimpleExpressionNode | CompoundExpressionNode | null): { template: string; expressionCount: number } | null {
  const rawSource = getVueExpressionSource(expression, "loc", "compiled");
  return rawSource ? tryUnwrapTemplateLiteralSource(rawSource) : null;
}

/**
 * Parses the inside of a template literal as a `TemplateLiteral` AST node.
 *
 * `parseExpression()` only accepts complete JavaScript expressions, so fragments like
 * `line-${item.id}` need synthetic backticks before they can be parsed.
 *
 * @example
 * tryParseTemplateFragment("line-${item.id}")?.templateLiteral.expressions.length
 * // => 1
 *
 * @example
 * tryParseTemplateFragment("plain-text")?.templateLiteral.expressions.length
 * // => 0
 */
function tryParseTemplateFragment(fragment: string): ParsedTemplateFragment | null {
  if (!fragment) {
    return null;
  }

  try {
    // A fragment like `line-${item.id}` is the inside of a template literal, not a standalone
    // JavaScript expression, so we synthesize the surrounding backticks before parsing.
    const source = `\`${fragment}\``;
    const ast = parseExpression(source, { plugins: ["typescript"] }) as BabelNode;
    return isTemplateLiteral(ast) ? { source, templateLiteral: ast } : null;
  }
  catch {
    return null;
  }
}

function getTemplateExpressionSource(parsedTemplate: ParsedTemplateFragment, index: number): string | null {
  const expression = parsedTemplate.templateLiteral.expressions[index];
  if (!expression) {
    return null;
  }

  const start = typeof expression.start === "number" ? expression.start : null;
  const end = typeof expression.end === "number" ? expression.end : null;
  if (start === null || end === null) {
    return null;
  }

  return parsedTemplate.source.slice(start, end);
}

function getSingleExpressionTemplateFragment(parsedTemplate: ParsedTemplateFragment): {
  prefix: string;
  expressionSource: string;
  suffix: string;
} | null {
  const { templateLiteral } = parsedTemplate;
  if (templateLiteral.expressions.length !== 1 || templateLiteral.quasis.length !== 2) {
    return null;
  }

  const expressionSource = getTemplateExpressionSource(parsedTemplate, 0);
  if (expressionSource === null) {
    return null;
  }

  return {
    prefix: templateLiteral.quasis[0]?.value.raw ?? "",
    expressionSource,
    suffix: templateLiteral.quasis[1]?.value.raw ?? "",
  };
}

function templateFragmentContainsSingleExpression(container: ParsedTemplateFragment, candidate: ParsedTemplateFragment): boolean {
  const containerFragment = getSingleExpressionTemplateFragment(container);
  const candidateFragment = getSingleExpressionTemplateFragment(candidate);
  if (!containerFragment || !candidateFragment) {
    return false;
  }

  return containerFragment.expressionSource === candidateFragment.expressionSource
    && containerFragment.prefix.endsWith(candidateFragment.prefix)
    && containerFragment.suffix.startsWith(candidateFragment.suffix);
}

/**
 * Returns `true` when a template fragment already contains one or more `${...}` interpolations.
 *
 * @example
 * hasTemplateInterpolationExpressions("line-${item.id}")
 * // => true
 *
 * @example
 * hasTemplateInterpolationExpressions("item.id")
 * // => false
 */
export function hasTemplateInterpolationExpressions(fragment: string): boolean {
  return (tryParseTemplateFragment(fragment)?.templateLiteral.expressions.length ?? 0) > 0;
}

export interface InterpolatedTemplateFragment {
  template: string;
  rawExpression: string | null;
}

/**
 * Normalizes a fragment into something safe to splice into a template literal.
 *
 * Raw expressions become `${...}` placeholders; fragments that already contain template
 * interpolations are returned as-is.
 *
 * @example
 * toInterpolatedTemplateFragment("item.id")
 * // => { template: "${item.id}", rawExpression: "item.id" }
 *
 * @example
 * toInterpolatedTemplateFragment("line-${item.id}")
 * // => { template: "line-${item.id}", rawExpression: null }
 */
export function toInterpolatedTemplateFragment(fragment: string | null): InterpolatedTemplateFragment | null {
  if (!fragment) {
    return null;
  }

  if (hasTemplateInterpolationExpressions(fragment)) {
    return { template: fragment, rawExpression: null };
  }

  return {
    template: `\${${fragment}}`,
    rawExpression: fragment,
  };
}

/**
 * Reconstructs a full template-literal expression from a template AttributeValue using its parsed quasis/expressions.
 *
 * @example
 * const templateValue = templateAttributeValue("line-${item.id}");
 * if (templateValue.kind === "template") {
 *   renderTemplateLiteralExpression(templateValue)
 * }
 * // => "`line-${item.id}`"
 *
 * @example
 * const templateValue = templateAttributeValue("plain-text");
 * if (templateValue.kind === "template") {
 *   renderTemplateLiteralExpression(templateValue)
 * }
 * // => "`plain-text`"
 */
export function renderTemplateLiteralExpression(templateValue: Extract<AttributeValue, { kind: "template" }>): string {
  const templateLiteralSource = templateValue.parsedTemplate.source;
  const templateLiteral = templateValue.parsedTemplate.templateLiteral;

  // Render through the shared TypeScript writer so this codegen path follows the same
  // quoting/newline conventions as the rest of the repo's generated TypeScript output.
  const writer = createTypeScriptWriter();
  writer.write("`");
  for (let i = 0; i < templateLiteral.quasis.length; i += 1) {
    writer.write(templateLiteral.quasis[i]?.value.raw ?? "");

    const interpolation = templateLiteral.expressions[i];
    if (!interpolation) {
      continue;
    }

    const start = typeof interpolation.start === "number" ? interpolation.start : null;
    const end = typeof interpolation.end === "number" ? interpolation.end : null;
    if (start === null || end === null) {
      return templateLiteralSource;
    }

    writer.write("${");
    writer.write(templateLiteralSource.slice(start, end));
    writer.write("}");
  }

  writer.write("`");
  return writer.toString();
}

/**
 * Gets the value placeholder for a :key directive
 *
 * Returns a placeholder string if the element has a :key directive, null otherwise
 * This is used to indicate where a unique value should be interpolated
 *
 * @internal
 */
function getKeyDirectiveExpression(node: ElementNode): VueExpressionNode | null {
  const keyDirective = getKeyDirective(node);
  return keyDirective?.exp && (
    keyDirective.exp.type === NodeTypes.SIMPLE_EXPRESSION
    || keyDirective.exp.type === NodeTypes.COMPOUND_EXPRESSION
  )
    ? keyDirective.exp as SimpleExpressionNode | CompoundExpressionNode
    : null;
}

export function getKeyDirectiveInfo(node: ElementNode): ResolvedKeyInfo | null {
  const keyExpression = getKeyDirectiveExpression(node);
  if (!keyExpression) {
    return null;
  }

  const selectorSource = getVueExpressionSource(keyExpression, "compiled", "loc");
  const runtimeSource = getVueExpressionSource(keyExpression, "loc", "compiled");
  return toResolvedKeyInfo(selectorSource, runtimeSource);
}

export function getKeyDirectiveValue(node: ElementNode, _context: TransformContext | null = null): string | null {
  return getKeyDirectiveInfo(node)?.selectorFragment ?? null;
}

export function getKeyDirectiveRuntimeValue(node: ElementNode): string | null {
  return getKeyDirectiveInfo(node)?.runtimeFragment ?? null;
}

/**
 * Gets both v-model and :model-value directive values in a single pass
 * Consolidates the previous getVModelDirectiveValue and getModelValueValue helpers
 *
 * @internal
 */
export function getModelBindingValues(node: ElementNode): { vModel: string; modelValue: string | null } {
  let vModel = "";
  const vModelDirective = findDirectiveByName(node, "model");

  if (vModelDirective?.exp && (vModelDirective.exp.type === NodeTypes.SIMPLE_EXPRESSION || vModelDirective.exp.type === NodeTypes.COMPOUND_EXPRESSION)) {
    vModel = toPascalCase(getVueExpressionSource(vModelDirective.exp as VueExpressionNode, "loc", "content"));
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
      return getKeyDirectiveInfo(node)?.selectorFragment ?? null;
    }
  }
  return null;
}

/**
 * Gets the id or name attribute value from a node
 *
 * Returns the identifier, converting dashes and underscores to PascalCase.
 *
 * Dynamic `:id` / `:name` bindings are intentionally ignored here because they are not stable
 * semantic hints for generated POM member names.
 *
 * @internal
 */
export function getStaticIdOrNameHint(node: ElementNode): string {
  // Get id or name attribute (static)
  let idAttr = findAttributeByKey(node, "id");
  if (!idAttr) {
    idAttr = findAttributeByKey(node, "name");
  }

  let identifier = idAttr?.value?.content ?? "";

  // Dynamic id/name bindings are not stable identifiers for naming hints, so treat them as absent.
  if (!identifier) {
    const dynamicIdAttr = findDirectiveByName(node, "bind", "id");
    const dynamicNameAttr = findDirectiveByName(node, "bind", "name");
    if (dynamicIdAttr?.exp || dynamicNameAttr?.exp) {
      return "";
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
 * Extracts a key placeholder from a parent <template> with slot scope data.
 *
 * If the node is within a slot that has scope variables (e.g. #item="{ data }"),
 * returns a placeholder derived from that scope.
 *
 * @internal
 */
export function getContainedInSlotDataKeyValue(node: ElementNode, hierarchyMap: HierarchyMap): string | null {
  return getContainedInSlotDataKeyInfo(node, hierarchyMap)?.selectorFragment ?? null;
}

export function getContainedInSlotDataKeyInfo(node: ElementNode, hierarchyMap: HierarchyMap): ResolvedKeyInfo | null {
  let parent = getParent(hierarchyMap, node);
  while (parent) {
    if (parent.type === NodeTypes.ELEMENT && parent.tag === "template") {
      const slotScopeExpression = findTemplateSlotScopeExpression(parent);
      if (slotScopeExpression) {
        return tryGetTemplateSlotScopeKeyInfo(slotScopeExpression);
      }
    }
    parent = getParent(hierarchyMap, parent);
  }
  return null;
}

/**
 * Extracts the key value expression from a v-for directive on a parent element
 *
 * If the node is within a v-for that has a :key directive, returns the key expression.
 *
 * @internal
 */
export function getContainedInVForDirectiveKeyValue(context: TransformContext, node: ElementNode, hierarchyMap: HierarchyMap): string | null {
  const keyFragments = getContainedInVForDirectiveKeyInfo(context, node, hierarchyMap);
  return keyFragments?.selectorFragment ?? null;
}

export function getContainedInVForDirectiveKeyInfo(context: TransformContext, node: ElementNode, hierarchyMap: HierarchyMap): ResolvedKeyInfo | null {
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
        return getKeyDirectiveInfo(parent as ElementNode);
      }
    }
    parent = getParent(hierarchyMap, parent);
  }
  return null;
}

export function getContainedInVForDirectiveKeyRuntimeValue(context: TransformContext, node: ElementNode, hierarchyMap: HierarchyMap): string | null {
  const keyFragments = getContainedInVForDirectiveKeyInfo(context, node, hierarchyMap);
  return keyFragments?.runtimeFragment ?? null;
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

  const iterableRaw = getVueExpressionSource(simpleSourceExp, "compiled", "loc");

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
  return nodeHandlerAttributeInfo(node)?.semanticNameHint ?? null;
}

export interface HandlerAttributeInfo {
  /** Stable semantic hint for method/property names (never derived by parsing data-testid). */
  semanticNameHint: string;
  /** Stable semantic merge key for converging identical handler actions. */
  mergeKey: string;
}

/**
 * Extracts semantic naming and merge identity from a :handler binding.
 *
 * IMPORTANT: This never parses/derives from the generated/author-provided data-testid.
 */
export function nodeHandlerAttributeInfo(node: ElementNode): HandlerAttributeInfo | null {
  const handlerDirective = findDirectiveByName(node, "bind", "handler");
  if (!handlerDirective?.exp) {
    return null;
  }

  const exp = handlerDirective.exp as SimpleExpressionNode | CompoundExpressionNode;
  const source = getVueExpressionSource(exp, "content", "compiled");
  if (!source) {
    return null;
  }

  // Use a source-based key so identical handler expressions can converge.
  // NOTE: We intentionally do not normalize via regex/string parsing helpers in this package.
  const mergeKey = `handler:expr:${source}`;

  let expr: object;
  try {
    expr = parseExpression(source, { plugins: ["typescript", "jsx"] });
  }
  catch {
    // Even if parsing fails, still provide a merge identity.
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
  const isBooleanLiteralNode = (node: object | null): node is { type: "BooleanLiteral"; value: boolean } => {
    return isNodeType(node, "BooleanLiteral") && typeof (node as { value?: boolean }).value === "boolean";
  };
  const isNumericLiteralNode = (node: object | null): node is { type: "NumericLiteral"; value: number } => {
    return isNodeType(node, "NumericLiteral") && typeof (node as { value?: number }).value === "number";
  };
  const isNullLiteralNode = (node: object | null): node is { type: "NullLiteral" } => {
    return isNodeType(node, "NullLiteral");
  };
  const isMemberExpressionNode = (node: object | null): node is { type: "MemberExpression"; computed: boolean; object: object; property: object } => {
    if (!isNodeType(node, "MemberExpression"))
      return false;
    const n = node as { computed?: boolean; object?: object; property?: object };
    return typeof n.computed === "boolean"
      && typeof n.object === "object" && n.object !== null
      && typeof n.property === "object" && n.property !== null;
  };
  const isCallExpressionNode = (node: object | null): node is { type: "CallExpression"; callee: object; arguments: object[] } => {
    if (!isNodeType(node, "CallExpression"))
      return false;
    const n = node as { callee?: object; arguments?: object[] };
    return typeof n.callee === "object" && n.callee !== null && Array.isArray(n.arguments);
  };
  const isAwaitExpressionNode = (node: object | null): node is { type: "AwaitExpression"; argument: object } => {
    if (!isNodeType(node, "AwaitExpression"))
      return false;
    const n = node as { argument?: object };
    return typeof n.argument === "object" && n.argument !== null;
  };
  const isAssignmentExpressionNode = (node: object | null): node is { type: "AssignmentExpression"; left: object; right: object } => {
    if (!isNodeType(node, "AssignmentExpression"))
      return false;
    const n = node as { left?: object; right?: object };
    return typeof n.left === "object" && n.left !== null && typeof n.right === "object" && n.right !== null;
  };
  const isArrowFunctionExpressionNode = (node: object | null): node is { type: "ArrowFunctionExpression"; body: object } => {
    if (!isNodeType(node, "ArrowFunctionExpression"))
      return false;
    const n = node as { body?: object };
    return typeof n.body === "object" && n.body !== null;
  };
  const isBlockStatementNode = (node: object | null): node is { type: "BlockStatement"; body: object[] } => {
    if (!isNodeType(node, "BlockStatement"))
      return false;
    const n = node as { body?: object[] };
    return Array.isArray(n.body);
  };
  const isExpressionStatementNode = (node: object | null): node is { type: "ExpressionStatement"; expression: object } => {
    if (!isNodeType(node, "ExpressionStatement"))
      return false;
    const n = node as { expression?: object };
    return typeof n.expression === "object" && n.expression !== null;
  };
  const isReturnStatementNode = (node: object | null): node is { type: "ReturnStatement"; argument: object | null } => {
    if (!isNodeType(node, "ReturnStatement"))
      return false;
    const n = node as { argument?: object | null };
    return typeof n.argument === "object" || n.argument === null;
  };
  const isObjectExpressionNode = (node: object | null): node is { type: "ObjectExpression"; properties: object[] } => {
    if (!isNodeType(node, "ObjectExpression"))
      return false;
    const n = node as { properties?: object[] };
    return Array.isArray(n.properties);
  };
  const isObjectPropertyNode = (node: object | null): node is { type: "ObjectProperty"; computed: boolean; key: object; value: object } => {
    if (!isNodeType(node, "ObjectProperty"))
      return false;
    const n = node as { computed?: boolean; key?: object; value?: object };
    return typeof n.computed === "boolean"
      && typeof n.key === "object" && n.key !== null
      && typeof n.value === "object" && n.value !== null;
  };

  const getLastIdentifierFromMemberChain = (node: object | null): string | null => {
    if (!node)
      return null;
    if (isIdentifierNode(node))
      return node.name;
    if (isMemberExpressionNode(node)) {
      const prop = node.property;

      // obj.myHandler
      if (node.computed === false) {
        if (isIdentifierNode(prop))
          return prop.name;
      }

      // obj['myHandler']
      // This is a stable, explicit name; allow it.
      if (node.computed === true) {
        if (isStringLiteralNode(prop))
          return prop.value;
      }
    }
    return null;
  };

  const getRootIdentifierFromMemberChain = (node: object | null): string | null => {
    if (!node) {
      return null;
    }
    if (isIdentifierNode(node)) {
      return node.name;
    }
    if (isMemberExpressionNode(node)) {
      return getRootIdentifierFromMemberChain(node.object);
    }
    return null;
  };

  const getAssignmentTargetName = (lhs: object | null): string | null => {
    if (!lhs) {
      return null;
    }

    if (isIdentifierNode(lhs)) {
      return lhs.name;
    }

    if (isMemberExpressionNode(lhs)) {
      // Special-case Vue refs: something.value = true/false should derive from `something`.
      if (lhs.computed === false && isIdentifierNode(lhs.property) && lhs.property.name === "value") {
        return getLastIdentifierFromMemberChain(lhs.object);
      }

      return getLastIdentifierFromMemberChain(lhs);
    }

    return null;
  };

  const isTemplateLiteralNode = (node: object | null): node is { type: "TemplateLiteral"; expressions: object[]; quasis: Array<{ value?: { cooked?: string } }> } => {
    if (!isNodeType(node, "TemplateLiteral")) {
      return false;
    }
    const n = node as { expressions?: object[]; quasis?: Array<{ value?: { cooked?: string } }> };
    return Array.isArray(n.expressions) && Array.isArray(n.quasis);
  };

  const stableWordFromValue = (arg: object | null): string | null => {
    if (!arg) {
      return null;
    }

    if (isBooleanLiteralNode(arg)) {
      return arg.value ? "True" : "False";
    }

    if (isNumericLiteralNode(arg)) {
      return `Value${String(arg.value)}`;
    }

    if (isNullLiteralNode(arg)) {
      return "Null";
    }

    if (isStringLiteralNode(arg)) {
      const cleaned = (arg.value ?? "").trim();
      if (!cleaned) {
        return null;
      }
      return toPascalCase(cleaned.slice(0, 24));
    }

    // TemplateLiteral with no expressions is a stable, explicit string.
    if (isTemplateLiteralNode(arg)) {
      if ((arg.expressions ?? []).length > 0) {
        return null;
      }
      const v = (arg.quasis ?? []).map(q => q.value?.cooked ?? "").join("").trim();
      if (!v) {
        return null;
      }
      return toPascalCase(v.slice(0, 24));
    }

    // Stable member-expression values are useful suffixes for enums/constants.
    // Avoid suffixing from typical lower-camel variable identifiers (e.g. x, assignmentId), since
    // that would explode API surface and reduce stability.
    if (isMemberExpressionNode(arg)) {
      const stableName = getLastIdentifierFromMemberChain(arg);
      const rootName = getRootIdentifierFromMemberChain(arg);
      const firstChar = (rootName ?? "").charAt(0);
      const isConstantLikeRoot = firstChar !== ""
        && firstChar === firstChar.toUpperCase()
        && firstChar !== firstChar.toLowerCase();
      if (stableName && isConstantLikeRoot) {
        return toPascalCase(stableName.slice(0, 24));
      }
    }

    // Allow Identifier suffixes only when they look like constants (PascalCase/UPPER_CASE).
    if (isIdentifierNode(arg)) {
      const firstChar = arg.name.charAt(0);
      const isUpperAlpha = firstChar !== "" && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase();
      if (isUpperAlpha) {
        return toPascalCase(arg.name.slice(0, 24));
      }
    }

    return null;
  };

  const getStableSuffixFromCall = (call: { arguments: object[] }): string | null => {
    const args = call.arguments ?? [];
    const first = (args.length > 0 ? args[0] : null) as object | null;

    // Preferred pattern: fn({ option: true/false, ... }) => OptionTrue...
    if (!isObjectExpressionNode(first)) {
      // Secondary pattern: fn(rowData, 'assign', RebootPreference.Suppress), fn('all'), fn(true), etc.
      // Skip unstable leading args and keep the first stable literal/constant-like values we can find.
      const parts: string[] = [];
      for (const arg of args.slice(0, 4)) {
        const w = stableWordFromValue(arg ?? null);
        if (!w) {
          continue;
        }
        parts.push(w);
        if (parts.length >= 2) {
          break;
        }
      }

      if (parts.length === 0) {
        return null;
      }

      return parts.join("");
    }

    interface Part { key: string; value: string }
    const parts: Part[] = [];
    for (const prop of first.properties ?? []) {
      if (!isObjectPropertyNode(prop)) {
        continue;
      }
      if (prop.computed) {
        continue;
      }

      const keyName = isIdentifierNode(prop.key)
        ? prop.key.name
        : (isStringLiteralNode(prop.key) ? prop.key.value : null);
      if (!keyName) {
        continue;
      }

      let valueWord: string | null = null;
      if (isBooleanLiteralNode(prop.value)) {
        valueWord = prop.value.value ? "True" : "False";
      } else if (isStringLiteralNode(prop.value)) {
        const cleaned = (prop.value.value ?? "").trim();
        if (cleaned) {
          // Avoid generating unreasonably long names from large literals.
          valueWord = toPascalCase(cleaned.slice(0, 24));
        }
      } else if (isNumericLiteralNode(prop.value)) {
        valueWord = `Value${String(prop.value.value)}`;
      } else if (isNullLiteralNode(prop.value)) {
        valueWord = "Null";
      }

      if (!valueWord) {
        continue;
      }

      parts.push({ key: keyName, value: valueWord });
    }

    if (parts.length === 0) {
      return null;
    }

    // Sort for stability (property order differences should not rename the POM member).
    parts.sort((a, b) => a.key.localeCompare(b.key));

    // Limit suffix size.
    const limited = parts.slice(0, 2);
    return limited.map(p => `${toPascalCase(p.key)}${p.value}`).join("");
  };

  // :handler="myHandler" or :handler="obj.myHandler"
  const direct = getLastIdentifierFromMemberChain(expr);
  if (direct) {
    return { semanticNameHint: toPascalCase(direct), mergeKey };
  }

  // :handler="(x) => myHandler(x)" or :handler="() => obj.myHandler()"
  if (isArrowFunctionExpressionNode(expr)) {
    const body = expr.body;

    const tryFromCallExpression = (call: object | null) => {
      const resolvedCall = isAwaitExpressionNode(call)
        ? call.argument
        : call;
      if (!isCallExpressionNode(resolvedCall)) {
        return null;
      }
      const name = getLastIdentifierFromMemberChain(resolvedCall.callee);
      if (!name) {
        return null;
      }
      const suffix = getStableSuffixFromCall(resolvedCall);
      const semanticNameHint = suffix
        ? `${toPascalCase(name)}${suffix}`
        : toPascalCase(name);
      return semanticNameHint;
    };

    // ArrowFunctionExpression with implicit return call: () => fn(...)
    const directCall = tryFromCallExpression(body);
    if (directCall) {
      return { semanticNameHint: directCall, mergeKey };
    }

    // ArrowFunctionExpression with assignment body: () => someFlag = true
    if (isAssignmentExpressionNode(body)) {
      const lhs = getAssignmentTargetName(body.left);
      if (lhs) {
        const rhs = stableWordFromValue(body.right);
        const semanticNameHint = `Set${toPascalCase(lhs)}${rhs ?? ""}`;
        return { semanticNameHint, mergeKey };
      }
    }

    // ArrowFunctionExpression block: () => { return fn(...) } or () => { fn(...) }
    if (isBlockStatementNode(body)) {
      const stmts = body.body ?? [];
      if (stmts.length > 0) {
        const firstStmt = stmts[0] as object;
        if (isReturnStatementNode(firstStmt)) {
          const fromReturn = tryFromCallExpression(firstStmt.argument ?? null);
          if (fromReturn) {
            return { semanticNameHint: fromReturn, mergeKey };
          }
        }
        if (isExpressionStatementNode(firstStmt)) {
          const fromExpr = tryFromCallExpression(firstStmt.expression ?? null);
          if (fromExpr) {
            return { semanticNameHint: fromExpr, mergeKey };
          }
        }
      }
    }

    // Fallback: () => myHandler
    const bodyName = getLastIdentifierFromMemberChain(body);
    if (bodyName) {
      return { semanticNameHint: toPascalCase(bodyName), mergeKey };
    }
  }

  return null;
}

export interface NativeWrapperTransformInfo {
  /** data-testid for wrappers that can be derived from valueAttribute or v-model */
  nativeWrappersValue: AttributeValue | null;
  /** Value to assign to option-data-testid-prefix (when required by wrapper config) */
  optionDataTestIdPrefixValue: AttributeValue | null;

  /** Semantic naming hint for POM method generation (never derived by parsing data-testid). */
  semanticNameHint: string | null;
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
    return { nativeWrappersValue: null, optionDataTestIdPrefixValue: null, semanticNameHint: null };
  }

  const { role, valueAttribute, requiresOptionDataTestIdPrefix, inferred } = wrapperConfig;

  // Some wrappers (notably checkbox/toggle/radio/select) can end up with synthetic click
  // listeners in the compiler output (via v-model expansion). Treat those as implementation
  // details and still prefer wrapper-derived ids.
  //
  // For button-like wrappers, an author-specified @click is meaningful and we prefer the
  // click-derived naming pipeline.
  if (nodeHasClickDirective(node) && role === "button") {
    return { nativeWrappersValue: null, optionDataTestIdPrefixValue: null, semanticNameHint: null };
  }

  // 1) The traditional native wrapper path (valueAttribute or v-model)
  if (valueAttribute) {
    const value = getDataTestIdValueFromValueAttribute(node, componentName, valueAttribute, role);

    // Derive a semantic name hint from the wrapper's value attribute.
    // This is intentionally based on the source expression/value, NOT by parsing the generated test id.
    const attrStatic = findAttributeByKey(node, valueAttribute);
    if (attrStatic?.value?.content) {
      return { nativeWrappersValue: value || null, optionDataTestIdPrefixValue: null, semanticNameHint: attrStatic.value.content };
    }

    const attrDynamic = findDirectiveByName(node, "bind", valueAttribute);
    if (attrDynamic && "exp" in attrDynamic && attrDynamic.exp && "ast" in attrDynamic.exp && attrDynamic.exp.ast) {
      const { name } = getClickHandlerNameFromAst(attrDynamic.exp.ast as BabelNode);
      if (name) {
        return { nativeWrappersValue: value || null, optionDataTestIdPrefixValue: null, semanticNameHint: name };
      }
      // Fall back to the raw expression source.
      const raw = (attrDynamic.exp as SimpleExpressionNode).loc?.source ?? "";
      return { nativeWrappersValue: value || null, optionDataTestIdPrefixValue: null, semanticNameHint: raw || null };
    }

    return { nativeWrappersValue: value || null, optionDataTestIdPrefixValue: null, semanticNameHint: null };
  }

  const { vModel, modelValue } = getModelBindingValues(node);
  const shouldUseModelBinding = !!vModel || (!inferred && !!modelValue);
  if (shouldUseModelBinding) {
    const vmodelvalue = getDataTestIdFromGroupOption(vModel);
    const nativeWrappersValue = staticAttributeValue(`${componentName}-${modelValue || vmodelvalue}-${role}`);

    const semanticNameHint = modelValue || vModel || null;

    // 2) Some wrappers additionally require option-data-testid-prefix.
    if (requiresOptionDataTestIdPrefix) {
      const value = vmodelvalue || modelValue;
      return {
        nativeWrappersValue,
        optionDataTestIdPrefixValue: staticAttributeValue(`${componentName}-${value}`),
        semanticNameHint,
      };
    }

    return { nativeWrappersValue, optionDataTestIdPrefixValue: null, semanticNameHint };
  }

  return { nativeWrappersValue: null, optionDataTestIdPrefixValue: null, semanticNameHint: null };
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
    let value = getVueExpressionSource(attrDynamic.exp as VueExpressionNode, "loc", "compiled");

    if (attrDynamic.exp.ast?.type === "MemberExpression") {
      // eslint-disable-next-line no-restricted-syntax
      return staticAttributeValue(`${actualFileName}-${value.replaceAll(".", "")}-${role}`);
    }

    if (attrDynamic.exp.ast?.type === "CallExpression") {
      value = getVueExpressionSource(attrDynamic.exp as VueExpressionNode, "compiled", "loc");
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

      const source = getVueExpressionSource(toDirective.exp as VueExpressionNode, "compiled", "loc");

      const toAst = toDirective.exp.ast;
      const interpolated = (toAst !== undefined && toAst !== null && toAst !== false) && isTemplateLiteral(toAst as BabelNode);
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
export function toDirectiveObjectFieldNameValue(node: DirectiveNode): string | null {
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
  _context: TransformContext,
  innerText: string | null,
  clickDirective?: DirectiveNode,
  _options: { componentName?: string; contextFilename?: string } = {}
): string {
  // Prefer caller-provided directive (so we don't re-scan props multiple times).
  const click = clickDirective ?? tryGetClickDirective(node);
  if (!click) {
    return "";
  }

  // Extract handler name from directive expression
  let handlerName = "";

  if (click.exp) {
    const exp = click.exp as SimpleExpressionNode | CompoundExpressionNode;
    const source = getVueExpressionSource(exp, "content", "compiled");

    if (source) {
      const parsed = tryParseBabelAstFromHandlerSource(source);
      if (parsed) {
        const astName = getStableClickHandlerNameFromAst(parsed as BabelNode);
        if (astName) {
          handlerName = astName;
        }
      }
    }
  }

  const hName = normalizeHandlerName(handlerName);

  // Prefer semantic signal from the handler identity. If the handler is generic
  // (e.g. an inline assignment), fall back to inner text to provide a stable name.
  const name = hName || innerText || "";

  // Normalize handler names for codegen:
  // - innerText comes in kebab-ish already (via getInnerText)
  // - handler names are typically camelCase; convert to PascalCase for readability/stability
  const normalizedHandlerSegment = name ? `-${toPascalCase(name)}` : "";
  const result = normalizedHandlerSegment;

  // eslint-disable-next-line no-restricted-syntax
  return result.replace(/[^a-z-]/gi, "");
}

function tryParseBabelAstFromHandlerSource(source: string): object | null {
  const trimmed = source.trim();
  if (!trimmed)
    return null;

  // Most handlers are expression-shaped; parse that first.
  try {
    return parseExpression(trimmed, { plugins: ["typescript", "jsx"] }) as object;
  }
  catch {
    // Handlers can also be statement-shaped (e.g. `a(); b()` or `if (...) ...`). Parse as a file.
  }

  try {
    return parse(trimmed, { sourceType: "module", plugins: ["typescript", "jsx"] }) as object;
  }
  catch {
    return null;
  }
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

function getStableClickHandlerNameFromAst(ast: BabelNode | null): string {
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

    // Vue compiler may wrap handlers for modifiers: withModifiers(fn, ['prevent']).
    // Prefer the underlying handler identity.
    if (isIdentifier(callee) && (callee.name === "withModifiers" || callee.name === "_withModifiers")) {
      const firstArg = exp.arguments[0];
      return getStableClickHandlerNameFromExpression(firstArg as BabelNode);
    }

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
    const left = getAssignmentTargetNameFromBabel(exp.left as BabelNode);
    if (left) {
      const right = getStableAssignmentValueSuffixFromBabel(exp.right as BabelNode);
      return `Set${toPascalCase(left)}${right}`;
    }
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
    // Keep this narrower helper behavior for non-click paths like :modelValue / valueAttribute.
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

function getLastIdentifierFromMemberChainBabel(node: BabelNode | null | undefined): string {
  if (!node) {
    return "";
  }

  if (isIdentifier(node)) {
    return node.name;
  }

  if (isMemberExpression(node) || isOptionalMemberExpression(node)) {
    if (!node.computed) {
      if (isIdentifier(node.property)) {
        return node.property.name;
      }
    }
    else if (isStringLiteral(node.property)) {
      return node.property.value;
    }
  }

  return "";
}

function getAssignmentTargetNameFromBabel(node: BabelNode | null | undefined): string {
  if (!node) {
    return "";
  }

  if (isIdentifier(node)) {
    return node.name;
  }

  if (isMemberExpression(node) || isOptionalMemberExpression(node)) {
    if (!node.computed && isIdentifier(node.property) && node.property.name === "value") {
      return getLastIdentifierFromMemberChainBabel(node.object as BabelNode);
    }

    return getLastIdentifierFromMemberChainBabel(node);
  }

  return "";
}

function getStableAssignmentValueSuffixFromBabel(node: BabelNode | null | undefined): string {
  if (!node) {
    return "";
  }

  if (isBooleanLiteral(node)) {
    return node.value ? "True" : "False";
  }

  if (isNumericLiteral(node)) {
    return `Value${String(node.value)}`;
  }

  if (isNullLiteral(node)) {
    return "Null";
  }

  if (isStringLiteral(node)) {
    const cleaned = (node.value ?? "").trim();
    return cleaned ? toPascalCase(cleaned.slice(0, 24)) : "";
  }

  if (isTemplateLiteral(node) && node.expressions.length === 0) {
    const value = node.quasis.map(q => q.value?.cooked ?? "").join("").trim();
    return value ? toPascalCase(value.slice(0, 24)) : "";
  }

  if (isMemberExpression(node) || isOptionalMemberExpression(node)) {
    const name = getLastIdentifierFromMemberChainBabel(node);
    return name ? toPascalCase(name.slice(0, 24)) : "";
  }

  if (isIdentifier(node)) {
    const firstChar = node.name.charAt(0);
    const isUpperAlpha = firstChar !== "" && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase();
    return isUpperAlpha ? toPascalCase(node.name.slice(0, 24)) : "";
  }

  return "";
}

function isCompilerGeneratedReferenceRoot(name: string): boolean {
  return name.startsWith("_") || name.startsWith("$");
}

function tryGetPreservableDynamicReferenceExpression(node: BabelNode | null | false | undefined): string | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  if (isIdentifier(node)) {
    return isCompilerGeneratedReferenceRoot(node.name) ? null : node.name;
  }

  if (!isMemberExpression(node) || node.computed) {
    return null;
  }

  const objectExpression = tryGetPreservableDynamicReferenceExpression(node.object as BabelNode);
  if (!objectExpression || !isIdentifier(node.property)) {
    return null;
  }

  return `${objectExpression}.${node.property.name}`;
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

  /** When the binding can be preserved as a one-slot template, the unwrapped template text (without backticks). */
  template?: string;
  /** Parsed template metadata for preserve-safe template ids. */
  parsedTemplate?: ParsedTemplateFragment;
  /** Number of interpolations in the template literal, if known. */
  templateExpressionCount?: number;
  /** For non-template dynamic bindings, the raw expression string (identifier/call/etc). */
  rawExpression?: string;
}

export interface ResolvedDataTestIdValues {
  selectorValue: AttributeValue;
  runtimeValue: AttributeValue;
  fromExisting: boolean;
}

/**
 * Extracts existing data-testid info from an element.
 *
 * Supports:
 * - data-testid="literal"
 * - :data-testid="`Foo-${bar}`" (TemplateLiteral)
 * - :data-testid="'foo'" (StringLiteral)
 * - :data-testid="p.parameter.name" (simple Identifier/MemberExpression path)
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

  const simpleExp = exp as SimpleExpressionNode;
  const ast = simpleExp.ast;

  const unwrappedTemplateLiteral = tryUnwrapTemplateLiteralExpressionSource(simpleExp);
  if (unwrappedTemplateLiteral) {
    const isStatic = unwrappedTemplateLiteral.expressionCount === 0;
    if (isStatic) {
      return { value: unwrappedTemplateLiteral.template, isDynamic: false, isStaticLiteral: true };
    }

    const templateValue = templateAttributeValue(unwrappedTemplateLiteral.template);
    return {
      value: templateValue.template,
      isDynamic: true,
      isStaticLiteral: false,
      template: templateValue.template,
      parsedTemplate: templateValue.parsedTemplate,
      templateExpressionCount: unwrappedTemplateLiteral.expressionCount,
    };
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

  const preservableReference = tryGetPreservableDynamicReferenceExpression(ast as BabelNode | null | false | undefined);
  if (preservableReference) {
    const templateValue = templateAttributeValue(`\${${preservableReference}}`);
    return {
      value: preservableReference,
      isDynamic: true,
      isStaticLiteral: false,
      template: templateValue.template,
      parsedTemplate: templateValue.parsedTemplate,
      templateExpressionCount: 1,
      rawExpression: preservableReference,
    };
  }

  const raw = (simpleExp.content ?? "").trim();
  if (!raw) {
    return null;
  }

  let fallbackAst = ast as BabelNode | null | false | undefined;
  if (!fallbackAst) {
    try {
      fallbackAst = parseExpression(raw, { plugins: ["typescript"] }) as BabelNode;
    }
    catch {
      fallbackAst = null;
    }
  }

  if (fallbackAst && typeof fallbackAst === "object" && "type" in fallbackAst && (fallbackAst as { type: string }).type === "StringLiteral") {
    const sl = fallbackAst as { value?: string };
    return { value: sl.value ?? "", isDynamic: false, isStaticLiteral: true };
  }

  const fallbackPreservableReference = tryGetPreservableDynamicReferenceExpression(fallbackAst);
  if (fallbackPreservableReference) {
    const templateValue = templateAttributeValue(`\${${fallbackPreservableReference}}`);
    return {
      value: fallbackPreservableReference,
      isDynamic: true,
      isStaticLiteral: false,
      template: templateValue.template,
      parsedTemplate: templateValue.parsedTemplate,
      templateExpressionCount: 1,
      rawExpression: fallbackPreservableReference,
    };
  }

  return { value: raw, isDynamic: true, isStaticLiteral: false, rawExpression: raw };
}

function isTemplatePlaceholder(part: string) {
  const parsedTemplate = tryParseTemplateFragment(part);
  const templateFragment = parsedTemplate ? getSingleExpressionTemplateFragment(parsedTemplate) : null;
  return !!templateFragment && templateFragment.prefix === "" && templateFragment.suffix === "";
}

function isAllCapsOrDigits(value: string): boolean {
  if (value.length <= 1) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const isUpper = isAsciiUppercaseLetterCode(c);
    const isDigit = isAsciiDigitCode(c);
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
  return isAsciiDigitCode(c);
}

function stripNonIdentifierChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const isUnderscore = c === 95;
    if (isAsciiAlphaNumericCode(c) || isUnderscore) {
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

/**
 * Replaces any `${...}` interpolation in a template string with the stable POM placeholder `${key}`.
 *
 * This is only for the generated POM selector shape. Runtime/test-id generation keeps the real
 * interpolation expressions; the POM layer just needs to know that a keyed slot exists and where
 * it sits relative to the surrounding literal text.
 */
function toPomKeyPattern(templateValue: Extract<AttributeValue, { kind: "template" }>): string {
  const { templateLiteral } = templateValue.parsedTemplate;
  let out = "";
  for (let i = 0; i < templateLiteral.quasis.length; i += 1) {
    out += templateLiteral.quasis[i]?.value.raw ?? "";
    if (templateLiteral.expressions[i]) {
      out += "${key}";
    }
  }
  return out;
}

// Internal exports for unit testing (not part of the public plugin API).
export const __internal = {
  isSimpleScopeIdentifier,
  safeMethodNameFromParts,
  splitNullishCoalescingExpression,
  toPomKeyPattern,
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
  preferredRuntimeValue?: AttributeValue;
  keyInfo: ResolvedKeyInfo | null;
  /** Optional enumerable key values (e.g. derived from v-for="item in ['One','Two']"). */
  keyValuesOverride?: string[] | null;
  entryOverrides?: Partial<IDataTestId>;
  /**
   * Semantic naming hint used for generating method/property names.
   *
   * IMPORTANT: This exists so we do NOT need to parse the `data-testid` value to
   * derive POM API surface.
   */
  semanticNameHint?: string;

  /**
   * Optional fallback semantic hints to use when the primary hint would cause a member-name collision.
   *
   * These are still derived from the Vue template/AST (e.g. static inner text, id/name attributes),
   * never by parsing the data-testid value.
   */
  semanticNameHintAlternates?: string[];

  /**
   * Optional semantic merge key for grouping multiple elements into a single POM action.
   *
   * Examples:
   * - click handler identity (e.g. `click:cancel(item.key)`)
   * - navigation target identity (e.g. `to:name:EditIntegrationType`)
   */
  pomMergeKey?: string;
  addHtmlAttribute?: boolean;
  /** Attribute name to use for injection and parsing. Defaults to data-testid. */
  testIdAttribute?: string;
  /**
   * How to handle an author-provided existing test id attribute when we encounter one.
   *
   * - "preserve": keep the existing value (default)
   * - "overwrite": replace it with the generated value
   * - "error": throw to force cleanup/migration
   */
  existingIdBehavior?: "preserve" | "overwrite" | "error";

  /**
   * Controls what happens when the generator would emit duplicate POM member names within the same class.
   * - "error": throw and fail compilation
   * - "warn": warn and append a suffix
   * - "suffix": append a suffix silently (default)
   */
  nameCollisionBehavior?: "error" | "warn" | "suffix";

  /** Optional warning sink (typically the shared generator logger). */
  warn?: (message: string) => void;
}): ResolvedDataTestIdValues {
  const addHtmlAttribute = args.addHtmlAttribute ?? true;
  const entryOverrides = args.entryOverrides ?? {};
  const testIdAttribute = args.testIdAttribute ?? "data-testid";
  const existingIdBehavior = args.existingIdBehavior ?? "preserve";
  const nameCollisionBehavior = args.nameCollisionBehavior ?? "suffix";
  const warn = args.warn;

  const getBestKeyAccessCandidates = (expr: string | null | undefined) => {
    if (!expr) {
      return [];
    }

    return splitNullishCoalescingExpression(expr);
  };

  // 1) Resolve effective data-testid (respecting any existing attribute).
  let dataTestId = args.preferredGeneratedValue;
  let runtimeDataTestId = args.preferredRuntimeValue ?? args.preferredGeneratedValue;
  let fromExisting = false;
  const bestKeyPreservePlaceholder = args.keyInfo?.runtimeFragment ?? null;
  const bestKeyVariable = args.keyInfo?.rawExpression ?? null;

  const existing = tryGetExistingElementDataTestId(args.element, testIdAttribute);
  if (existing) {
    const loc = args.element.loc?.start;
    const locationHint = loc ? `${loc.line}:${loc.column}` : "unknown";
    const file = args.contextFilename ?? "unknown";
    const attrLabel = testIdAttribute || "data-testid";

    if (existingIdBehavior === "error") {
      throw new Error(
        `[vue-pom-generator] Found existing ${attrLabel} while existingIdBehavior="error".\n`
        + `Component: ${args.componentName}\n`
        + `File: ${file}:${locationHint}\n`
        + `Existing ${attrLabel}: ${JSON.stringify(existing.value)}\n\n`
        + `Fix: remove the explicit ${attrLabel}, or change existingIdBehavior to "preserve" or "overwrite".\n`
        + `Bulk cleanup: run ESLint with the @immense/vue-pom-generator/remove-existing-test-id-attributes rule and --fix to strip explicit ${attrLabel} attributes project-wide before enforcing this mode.`,
      );
    }

    if (existingIdBehavior === "preserve") {
      // Preserve only when the existing id can be used as a stable selector at test runtime.
      // - Static literals are always OK.
      // - Template literals are ONLY allowed when they contain exactly one interpolation and
      //   that interpolation is the v-for key placeholder we inferred (when present).
      // - All other dynamic expressions are rejected (they would serialize to e.g. "__props.name").

      if (existing.isDynamic) {
        if (existing.template) {
          const existingTemplateValue = existing.parsedTemplate
            ? { kind: "template", template: existing.template, parsedTemplate: existing.parsedTemplate } as const
            : templateAttributeValue(existing.template);
          const existingTemplateFragment = getSingleExpressionTemplateFragment(existingTemplateValue.parsedTemplate);
          const requiredKeyTemplateValue = bestKeyPreservePlaceholder ? templateAttributeValue(bestKeyPreservePlaceholder) : null;

          if ((existing.templateExpressionCount ?? 0) !== 1 || !existingTemplateFragment) {
            throw new Error(
              `[vue-pom-generator] Existing ${attrLabel} is a template literal with multiple interpolations and cannot be preserved safely.\n`
              + `Component: ${args.componentName}\n`
              + `File: ${file}:${locationHint}\n`
              + `Existing ${attrLabel}: ${JSON.stringify(existing.value)}\n\n`
              + `Fix: reduce the template to a single key-based interpolation, or remove the explicit ${attrLabel} so it can be auto-generated.`,
            );
          }

          const hasExact = requiredKeyTemplateValue
            ? templateFragmentContainsSingleExpression(existingTemplateValue.parsedTemplate, requiredKeyTemplateValue.parsedTemplate)
            : false;
          const hasVarAccess = getBestKeyAccessCandidates(bestKeyVariable)
            .some(candidate => existingTemplateFragment.expressionSource === candidate);

          if (!hasExact && !hasVarAccess && bestKeyPreservePlaceholder) {
            throw new Error(
              `[vue-pom-generator] Existing ${attrLabel} appears to be missing the key placeholder needed to keep it unique.\n`
              + `Component: ${args.componentName}\n`
              + `File: ${file}:${locationHint}\n`
              + `Existing ${attrLabel}: ${JSON.stringify(existing.value)}\n`
              + `Required placeholder: ${JSON.stringify(bestKeyPreservePlaceholder)}${bestKeyVariable ? ` or an access on "${bestKeyVariable}"` : ""}\n\n`
              + `Fix: either (1) include ${bestKeyPreservePlaceholder} in your :${attrLabel} template literal, or (2) remove the explicit ${attrLabel} so it can be auto-generated.`,
            );
          }

          dataTestId = existingTemplateValue;
          runtimeDataTestId = existingTemplateValue;
          fromExisting = true;
        }
        else {
          throw new Error(
            `[vue-pom-generator] Existing ${attrLabel} is dynamic and cannot be preserved as a stable runtime selector.\n`
            + `Component: ${args.componentName}\n`
            + `File: ${file}:${locationHint}\n`
            + `Existing ${attrLabel} expression: ${JSON.stringify(existing.rawExpression ?? existing.value)}\n\n`
            + `Fix: change it to a string literal (e.g. ${attrLabel}="foo" or :${attrLabel}="'foo'") or remove the explicit ${attrLabel} so it can be auto-generated.\n`
            + `If you really need a computed id, do not set existingIdBehavior="preserve".`,
          );
        }
      }
      else {
        if (bestKeyPreservePlaceholder && existing.isStaticLiteral) {
          throw new Error(
            `[vue-pom-generator] Existing ${attrLabel} appears to be missing the key placeholder needed to keep it unique.\n`
            + `Component: ${args.componentName}\n`
            + `File: ${file}:${locationHint}\n`
            + `Existing ${attrLabel}: ${JSON.stringify(existing.value)}\n`
            + `Required placeholder: ${JSON.stringify(bestKeyPreservePlaceholder)}${bestKeyVariable ? ` or an access on "${bestKeyVariable}"` : ""}\n\n`
            + `Fix: either (1) include ${bestKeyPreservePlaceholder} in your :${attrLabel} template literal, or (2) remove the explicit ${attrLabel} so it can be auto-generated.`,
          );
        }

        dataTestId = staticAttributeValue(existing.value);
        runtimeDataTestId = staticAttributeValue(existing.value);
        fromExisting = true;
      }
    }
    // existingIdBehavior === "overwrite": ignore existing and proceed with generated id.
  }

  // 2) Derive method naming/params WITHOUT parsing the data-testid string.
  //
  // We only ever use the data-testid value as *data* (the selector string).
  // POM *shape* (method names, params) comes from semantic hints + Vue/Babel AST-derived
  // signals collected during the transform phase.

  const getKeyTypeFromValues = (values: string[] | null | undefined) => {
    if (!values || values.length === 0) {
      return "string";
    }
    return values.map(v => JSON.stringify(v)).join(" | ");
  };

  const keyTypeFromValues = getKeyTypeFromValues(args.keyValuesOverride ?? null);

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
      case "grid":
        return role;
      default:
        return undefined;
    }
  };

  const normalizedRole: NativeRole = normalizeNativeRole(args.nativeRole) ?? "button";

  // NOTE: `targetPageObjectModelClass` is used to decide whether we emit `goToX`.
  // It can be provided via entryOverrides (e.g. router-link :to resolution).
  const targetPageObjectModelClass = entryOverrides.targetPageObjectModelClass;

  // Keyed-ness is represented in the selector pattern, not derived by parsing the test id.
  const formattedDataTestIdForPom = dataTestId.kind === "template"
    ? toPomKeyPattern(dataTestId)
    : dataTestId.value;

  const isKeyed = formattedDataTestIdForPom.includes("${key}");

  const deriveBaseMethodNameFromHint = (hint: string | undefined) => {
    const hintRaw = (hint ?? "").trim();
    const trimEdgeSeparators = (value: string): string => {
      if (!value) {
        return "";
      }
      let start = 0;
      let end = value.length;
      const isSep = (ch: string) => ch === "-" || ch === "_" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
      while (start < end && isSep(value[start])) {
        start += 1;
      }
      while (end > start && isSep(value[end - 1])) {
        end -= 1;
      }
      return value.slice(start, end);
    };

    const hintClean = trimEdgeSeparators(hintRaw);

    // If we have no hint, fall back to a role-based name.
    if (!hintClean) {
      const roleName = upperFirst(toPascalCase(normalizedRole));
      return roleName || "Element";
    }

    // Convert to a safe identifier-ish PascalCase.
    // We intentionally do NOT split/interpret `data-testid` values here.
    const name = toPascalCase(hintClean);
    const safe = safeMethodNameFromParts([name]);
    return safe || "Element";
  };

  const deriveBaseMethodName = () => {
    return deriveBaseMethodNameFromHint(args.semanticNameHint);
  };

  // Ensure the primary method name is unique within the class.
  // IMPORTANT: We do NOT parse data-testid values to generate names. When collisions occur
  // (common for role-based fallbacks like "Button"), we append a numeric suffix.
  const removeByKeySegment = (value: string): string => {
    const idx = value.lastIndexOf("ByKey");
    if (idx < 0) {
      return value;
    }
    return value.slice(0, idx) + value.slice(idx + "ByKey".length);
  };

  const hasRoleSuffix = (baseName: string, roleSuffix: string) => {
    if (baseName.endsWith(roleSuffix)) {
      return true;
    }
    // Treat role + numeric suffix as already-suffixed to avoid awkward names like Button2Button.
    // Example: baseName=Button2, roleSuffix=Button => property should be Button2.
    // eslint-disable-next-line no-restricted-syntax
    const re = new RegExp(`^${roleSuffix}\\d+$`);
    return re.test(baseName);
  };

  const getPrimaryGetterName = (primaryMethodName: string): string => {
    const roleSuffix = upperFirst(normalizedRole || "Element");
    const baseName = upperFirst(primaryMethodName);
    const propertyName = hasRoleSuffix(baseName, roleSuffix) ? baseName : `${baseName}${roleSuffix}`;
    // Keep behavior aligned with TS emitter: keyed getters expose `Foo[key]` by removing `ByKey`.
    return isKeyed ? removeByKeySegment(propertyName) : propertyName;
  };

  const getPrimaryGetterNameCandidates = (primaryMethodName: string): { primary: string; alternate?: string } => {
    const roleSuffix = upperFirst(normalizedRole || "Element");
    const baseName = upperFirst(primaryMethodName);
    const propertyName = hasRoleSuffix(baseName, roleSuffix) ? baseName : `${baseName}${roleSuffix}`;

    if (!isKeyed) {
      return { primary: propertyName };
    }

    const stripped = removeByKeySegment(propertyName);
    const kept = propertyName;
    return stripped === kept ? { primary: stripped } : { primary: stripped, alternate: kept };
  };

  const getPrimaryActionMethodName = (primaryMethodName: string): string => {
    const methodNameUpper = upperFirst(primaryMethodName);
    const radioMethodNameUpper = upperFirst(primaryMethodName || "Radio");
    const isNavigation = !!targetPageObjectModelClass;

    if (isNavigation) {
      return `goTo${methodNameUpper}`;
    }

    switch (normalizedRole) {
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

  args.dependencies.reservedPomMemberNames ??= new Set<string>();
  const reservedMembers = args.dependencies.reservedPomMemberNames;

  // Internal maps used for merge-by-handler/target.
  args.dependencies.__pomPrimaryByActionName ??= new Map<string, IDataTestId>();
  args.dependencies.__pomPrimaryByGetterName ??= new Map<string, IDataTestId>();
  const primaryByActionName = args.dependencies.__pomPrimaryByActionName;

  const hintCandidates = (() => {
    // We always consider alternates (typically id/name/label text) when choosing a 1st-pass name,
    // so that we prefer e.g. "EditButton" over generic "Button" even in suffix mode.
    //
    // Note that in "suffix"/"warn" modes, once a base hint is chosen it will be suffixed 
    // (e.g. Button2) rather than trying the next hint in the list. Alternates are mainly 
    // useful when the primary hint is missing or when in "error" mode.
    const baseHints: Array<string | undefined> = [
      args.semanticNameHint,
      ...(args.semanticNameHintAlternates ?? []),
    ];
    // De-dupe while preserving order.
    const out: string[] = [];
    const seen = new Set<string>();
    for (const h of baseHints) {
      const v = (h ?? "").trim();
      if (!v) {
        continue;
      }
      if (seen.has(v)) {
        continue;
      }
      seen.add(v);
      out.push(v);
    }
    // If we have no usable hints, allow the role-based fallback path.
    if (!out.length) {
      out.push("");
    }
    return out;
  })();

  const tryMergeWithExistingPrimary = (candidateActionName: string): boolean => {
    const mergeKey = (args.pomMergeKey ?? "").trim();

    const existingEntry = primaryByActionName.get(candidateActionName);
    const existingPom = existingEntry?.pom;
    if (!existingEntry || !existingPom) {
      return false;
    }

    const existingSelectors = [
      existingPom.formattedDataTestId,
      ...(existingPom.alternateFormattedDataTestIds ?? []),
    ];
    const sharesSelectorIdentity = existingSelectors.includes(formattedDataTestIdForPom);

    // Keyed selectors are only safe to merge when both entries already resolve to the exact
    // same keyed selector pattern. Distinct keyed lists should still force authors to
    // disambiguate their semantic hints instead of collapsing to one API.
    if (isKeyed && !sharesSelectorIdentity) {
      return false;
    }

    // If both candidates already resolve to the exact same selector, separate generated
    // names would be fake differentiation. Merge them even without an explicit merge key.
    if (!mergeKey && !sharesSelectorIdentity) {
      return false;
    }
    if (mergeKey && (existingPom.mergeKey ?? "").trim() !== mergeKey && !sharesSelectorIdentity) {
      return false;
    }

    // Only merge when the semantic behavior matches.
    if (existingPom.nativeRole !== normalizedRole) {
      return false;
    }
    if ((existingEntry.targetPageObjectModelClass ?? null) !== (targetPageObjectModelClass ?? null)) {
      return false;
    }

    // Merge the selector(s) into the existing primary.
    if (existingPom.formattedDataTestId !== formattedDataTestIdForPom) {
      existingPom.alternateFormattedDataTestIds ??= [];
      if (!existingPom.alternateFormattedDataTestIds.includes(formattedDataTestIdForPom)) {
        existingPom.alternateFormattedDataTestIds.push(formattedDataTestIdForPom);
      }
    }

    return true;
  };

  let methodName = "";
  let getterNameOverride: string | undefined;
  let mergedIntoExisting = false;
  let collisionDetails: { getterName: string; actionName: string } | null = null;
  let collisionHint: string | null = null;

  // Try each hint candidate. In error mode, we only try suffix=1 for each hint.
  for (const hint of hintCandidates) {
    const base = hint ? deriveBaseMethodNameFromHint(hint) : deriveBaseMethodName();
    let suffix = 1;

    while (true) {
      const baseWithSuffix = suffix === 1 ? base : `${base}${suffix}`;
      // Keep the ByKey segment at the end so downstream logic (and keyed getter naming)
      // can reliably strip it when needed.
      const candidate = isKeyed ? `${baseWithSuffix}ByKey` : baseWithSuffix;

      const actionName = getPrimaryActionMethodName(candidate);

      const getterCandidates = getPrimaryGetterNameCandidates(candidate);
      let chosenGetterName = getterCandidates.primary;
      let chosenGetterOverride: string | undefined;

      const hasConflicts = (getter: string) => reservedMembers.has(getter)
        || reservedMembers.has(actionName)
        || (args.dependencies.generatedMethods?.has(actionName) ?? false);

      let conflicts = hasConflicts(chosenGetterName);

      // Edge-case: keyed getter name (FooButton[key]) can collide with a non-keyed FooButton.
      // When that happens, keep the ByKey segment on the keyed getter name.
      if (conflicts && getterCandidates.alternate) {
        const alt = getterCandidates.alternate;
        const altConflicts = hasConflicts(alt);
        if (!altConflicts) {
          chosenGetterName = alt;
          chosenGetterOverride = alt;
          conflicts = false;
        }
      }

      // If this candidate already resolves to the same semantic action/selector as an
      // existing primary, merge it before we try to synthesize a role-suffixed variant.
      // Otherwise keyed/template selectors that collapse to one real selector identity can
      // spuriously manufacture fake APIs like `ValueButtonByKey`.
      if (conflicts && nameCollisionBehavior === "error" && tryMergeWithExistingPrimary(actionName)) {
        methodName = candidate;
        mergedIntoExisting = true;
        break;
      }

      // In strict mode (error), prefer trying role-suffixed candidates over hint alternates
      // when we cannot safely merge with an existing primary. This prevents common
      // collisions where different roles share the same semantic hint (e.g. a select +
      // radio bound to the same v-model path), causing actionName clashes like
      // `selectFoo` vs `selectFoo` with different signatures.
      if (conflicts && nameCollisionBehavior === "error") {
        const roleSuffix = upperFirst(normalizedRole || "Element");
        const baseNameUpper = upperFirst(baseWithSuffix);

        // Only try role-suffixing when the base name isn't already role-suffixed.
        if (!hasRoleSuffix(baseNameUpper, roleSuffix)) {
          const baseWithRoleSuffix = `${baseWithSuffix}${roleSuffix}`;
          const candidateWithRoleSuffix = isKeyed ? `${baseWithRoleSuffix}ByKey` : baseWithRoleSuffix;
          const actionNameWithRoleSuffix = getPrimaryActionMethodName(candidateWithRoleSuffix);

          const getterCandidatesWithRoleSuffix = getPrimaryGetterNameCandidates(candidateWithRoleSuffix);
          let chosenGetterNameWithRoleSuffix = getterCandidatesWithRoleSuffix.primary;
          let chosenGetterOverrideWithRoleSuffix: string | undefined;

          const hasConflictsWithRoleSuffix = (getter: string) => reservedMembers.has(getter)
            || reservedMembers.has(actionNameWithRoleSuffix)
            || (args.dependencies.generatedMethods?.has(actionNameWithRoleSuffix) ?? false);

          let conflictsWithRoleSuffix = hasConflictsWithRoleSuffix(chosenGetterNameWithRoleSuffix);

          // Preserve keyed edge-case behavior: allow keeping ByKey segment on the getter.
          if (conflictsWithRoleSuffix && getterCandidatesWithRoleSuffix.alternate) {
            const alt = getterCandidatesWithRoleSuffix.alternate;
            const altConflicts = hasConflictsWithRoleSuffix(alt);
            if (!altConflicts) {
              chosenGetterNameWithRoleSuffix = alt;
              chosenGetterOverrideWithRoleSuffix = alt;
              conflictsWithRoleSuffix = false;
            }
          }

          if (!conflictsWithRoleSuffix) {
            methodName = candidateWithRoleSuffix;
            getterNameOverride = chosenGetterOverrideWithRoleSuffix;
            reservedMembers.add(chosenGetterNameWithRoleSuffix);
            reservedMembers.add(actionNameWithRoleSuffix);
            break;
          }
        }
      }

      if (!conflicts) {
        methodName = candidate;
        getterNameOverride = chosenGetterOverride;

        if (collisionDetails && nameCollisionBehavior === "warn") {
          const loc = args.element.loc?.start;
          const locationHint = loc ? `${loc.line}:${loc.column}` : "unknown";
          const file = args.contextFilename ?? args.dependencies.filePath ?? "unknown";
          const hintLabel = (args.semanticNameHint ?? "").trim() || "<none>";
          (warn ?? ((m) => console.warn(`[vue-pom-generator] ${m}`)))(
            `[pom] member-name collision in ${args.parentComponentName} (${file}:${locationHint}). `
            + `role=${normalizedRole}, semanticNameHint=${JSON.stringify(hintLabel)}. `
            + `Conflicts: getter=${collisionDetails.getterName}, method=${collisionDetails.actionName}. `
            + `Using suffixed name: ${candidate}.`,
          );
        }

        reservedMembers.add(chosenGetterName);
        reservedMembers.add(actionName);
        break;
      }

      if (!collisionDetails) {
        collisionDetails = { getterName: chosenGetterName, actionName };
        collisionHint = hint || (args.semanticNameHint ?? "").trim() || null;
      }

      // In error mode, do not suffix; instead, try the next hint candidate.
      if (nameCollisionBehavior === "error") {
        break;
      }

      suffix += 1;
    }

    if (methodName) {
      break;
    }
  }

  if (!methodName) {
    const loc = args.element.loc?.start;
    const locationHint = loc ? `${loc.line}:${loc.column}` : "unknown";
    const file = args.contextFilename ?? args.dependencies.filePath ?? "unknown";
    const hint = (collisionHint ?? "<none>").trim() || "<none>";
    const last = collisionDetails ?? { getterName: "<unknown>", actionName: "<unknown>" };

    throw new Error(
      `[vue-pom-generator] POM member-name collision in ${args.parentComponentName} (${file}:${locationHint}).\n`
      + `role=${normalizedRole}, semanticNameHint=${JSON.stringify(hint)}\n`
      + `Conflicts: getter=${last.getterName}, method=${last.actionName}\n\n`
      + `Fix: make the element identifiable (e.g. add id/name/inner text or use a more specific click handler name), `
      + `or switch generation.nameCollisionBehavior to "warn"/"suffix".`,
    );
  }

  const params: Record<string, string> = {};
  if (isKeyed) {
    params.key = keyTypeFromValues;
  }

  switch (normalizedRole) {
    case "input":
      params.text = "string";
      params.annotationText = "string = \"\"";
      if (!isKeyed) delete params.key;
      break;
    case "select":
      params.value = "string";
      params.annotationText = "string = \"\"";
      if (!isKeyed) delete params.key;
      break;
    case "vselect":
      params.value = "string";
      params.timeOut = "number = 500";
      params.annotationText = "string = \"\"";
      if (!isKeyed) delete params.key;
      break;
    case "radio":
      // radio can be keyed (e.g. `${key}` option ids) or not.
      params.annotationText = "string = \"\"";
      break;
    default:
      break;
  }

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

  // Store the primary POM spec so emitters can generate POMs for multiple languages.
  // Some special cases will mark emitPrimary=false and instead add extra methods.
  dataTestIdEntry.pom = {
    nativeRole: normalizedRole,
    methodName,
    getterNameOverride,
    formattedDataTestId: formattedDataTestIdForPom,
    alternateFormattedDataTestIds: undefined,
    mergeKey: args.pomMergeKey,
    params,
    keyValuesOverride: args.keyValuesOverride ?? null,
    // emitPrimary defaults to true; special cases (including merge) may set it to false below.
  };

  if (mergedIntoExisting && dataTestIdEntry.pom) {
    dataTestIdEntry.pom.emitPrimary = false;
  }

  args.dependencies.childrenComponentSet.add(childComponentName);
  args.dependencies.usedComponentSet.add(childComponentName);
  args.dependencies.dataTestIdSet.add(dataTestIdEntry);

  const getGeneratedMethodName = () => {
    const role = normalizedRole;
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
    const role = normalizedRole;
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
        return needsKey
          ? { params: `key: ${keyType}, text: string, annotationText: string = ""`, argNames: ["key", "text", "annotationText"] }
          : { params: "text: string, annotationText: string = \"\"", argNames: ["text", "annotationText"] };
      case "select":
        return needsKey
          ? { params: `key: ${keyType}, value: string, annotationText: string = ""`, argNames: ["key", "value", "annotationText"] }
          : { params: "value: string, annotationText: string = \"\"", argNames: ["value", "annotationText"] };
      case "vselect":
        return needsKey
          ? { params: `key: ${keyType}, value: string, timeOut = 500`, argNames: ["key", "value", "timeOut"] }
          : { params: "value: string, timeOut = 500", argNames: ["value", "timeOut"] };
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

  const registerPrimaryOnce = (pom: PomPrimarySpec) => {
    const stableParams = pom.params
      ? Object.fromEntries(Object.entries(pom.params).sort((a, b) => a[0].localeCompare(b[0])))
      : undefined;

    const alternates = (pom.alternateFormattedDataTestIds ?? []).slice().sort();

    // Deduplicate by a stable key rather than by emitted code strings.
    const key = JSON.stringify({
      kind: "primary",
      role: pom.nativeRole,
      methodName: pom.methodName,
      getterNameOverride: pom.getterNameOverride ?? null,
      formattedDataTestId: pom.formattedDataTestId,
      alternateFormattedDataTestIds: alternates.length ? alternates : undefined,
      params: stableParams,
      target: dataTestIdEntry.targetPageObjectModelClass ?? null,
      emitPrimary: pom.emitPrimary ?? true,
    });

    const seen = args.generatedMethodContentByComponent.get(args.parentComponentName) ?? new Set<string>();
    if (!args.generatedMethodContentByComponent.has(args.parentComponentName)) {
      args.generatedMethodContentByComponent.set(args.parentComponentName, seen);
    }
    if (!seen.has(key)) {
      seen.add(key);
      dataTestIdEntry.pom = pom;
    }
  };

  const addExtraClickMethod = (spec: PomExtraClickMethodSpec): boolean => {
    const stableParams = spec.params
      ? Object.fromEntries(Object.entries(spec.params).sort((a, b) => a[0].localeCompare(b[0])))
      : undefined;

    // IMPORTANT:
    // De-dupe based on semantic identity (testId+params+keyLiteral), not the emitted method name.
    // This prevents repeated passes over the same element from generating new unique names
    // (e.g. selectFoo -> selectFoo2) and growing the output.
    const key = JSON.stringify({ kind: spec.kind, selector: spec.selector, keyLiteral: spec.keyLiteral ?? null, params: stableParams });
    const seen = args.generatedMethodContentByComponent.get(args.parentComponentName) ?? new Set<string>();
    if (!args.generatedMethodContentByComponent.has(args.parentComponentName)) {
      args.generatedMethodContentByComponent.set(args.parentComponentName, seen);
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    args.dependencies.pomExtraMethods ??= [];
    args.dependencies.pomExtraMethods.push(spec);
    return true;
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
      const raw = getVueExpressionSource(
        exp as VueExpressionNode,
        args.context ? "compiled" : "loc",
        args.context ? "loc" : "compiled",
      );
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
  const roleForOptions = normalizedRole;
  const optionsDirective = findDirectiveByName(args.element, "bind", "options");
  const canHandleOptions = roleForOptions === "radio" && !!optionsDirective?.exp;

  if (canHandleOptions) {
    // For option-driven radio wrappers, generated POM methods should target the wrapper root
    // and select options semantically by label instead of relying on injected child test ids.
    const wrapperTestId = formattedDataTestIdForPom;

    const optionsAst = optionsDirective ? tryGetDirectiveExpressionAst(optionsDirective) : null;
    const staticLabels = optionsAst ? tryExtractStaticOptionLabelsFromOptionsAst(optionsAst) : null;

    // We derive the base method name from the existing methodName, but strip the "Radio" suffix
    // so option methods read like `selectFooBarBaz()` instead of `selectFooBarRadioBaz()`.
    const base = methodName.endsWith("Radio") ? methodName.slice(0, -"Radio".length) : methodName;
    const baseUpper = upperFirst(base || "Radio");

    if (staticLabels && staticLabels.length) {
      // Match legacy behavior: when we can enumerate static options, we only generate per-option
      // helpers and skip the generic select/click method for the wrapper.
      if (dataTestIdEntry.pom) {
        dataTestIdEntry.pom.emitPrimary = false;
        registerPrimaryOnce(dataTestIdEntry.pom);
      }
      for (const label of staticLabels) {
        const optionPart = getDataTestIdFromGroupOption(label);
        if (!optionPart) {
          continue;
        }

        const safeOptionSuffix = toPascalCase(label) || optionPart;
        const generatedName = ensureUniqueGeneratedName(`select${baseUpper}${safeOptionSuffix}`);

        const added = addExtraClickMethod({
          kind: "click",
          name: generatedName,
          selector: {
            kind: "withinTestIdByLabel",
            rootFormattedDataTestId: wrapperTestId,
            formattedLabel: label,
            exact: true,
          },
          params: { annotationText: `string = ""` },
        });

        if (added) {
          registerGeneratedMethodSignature(generatedName, { params: `annotationText: string = ""`, argNames: ["annotationText"] });
        }
      }

      // For statically-known options, we intentionally do NOT generate the generic parameterized method.
      return { selectorValue: dataTestId, runtimeValue: runtimeDataTestId, fromExisting };
    }

    // Dynamic options expression: generate a single method that accepts an option label string.
    const generatedName = ensureUniqueGeneratedName(`select${upperFirst(methodName || "Radio")}`);

    if (dataTestIdEntry.pom) {
      dataTestIdEntry.pom.emitPrimary = false;
      registerPrimaryOnce(dataTestIdEntry.pom);
    }

    // Dynamic options expression: generate a single method that accepts an option string.
    const added = addExtraClickMethod({
      kind: "click",
      name: generatedName,
      selector: {
        kind: "withinTestIdByLabel",
        rootFormattedDataTestId: wrapperTestId,
        formattedLabel: "${value}",
        exact: true,
      },
      params: { value: "string", annotationText: `string = ""` },
    });

    if (added) {
      registerGeneratedMethodSignature(generatedName, { params: `value: string, annotationText: string = ""`, argNames: ["value", "annotationText"] });
    }
    return { selectorValue: dataTestId, runtimeValue: runtimeDataTestId, fromExisting };
  }

  // Special handling for v-for driven by a static literal list.
  // When we can enumerate the keys (e.g. ['One','Two']), prefer emitting separate
  // methods like `clickOneButton()` / `clickTwoButton()` instead of a single
  // `click*ByKey(key: ...)`.
  //
  // This keeps the POM ergonomic and avoids pushing key plumbing into tests.
  const staticKeyValues = (args.keyValuesOverride ?? null);
  const needsKey = Object.prototype.hasOwnProperty.call(params, "key")
    && typeof formattedDataTestIdForPom === "string"
    && formattedDataTestIdForPom.includes("${key}");
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
    if (dataTestIdEntry.pom) {
      dataTestIdEntry.pom.emitPrimary = false;
      registerPrimaryOnce(dataTestIdEntry.pom);
    }

    const roleSuffix = upperFirst(toPascalCase(args.nativeRole || "Element"));

    for (const rawValue of staticKeyValues) {
      const valueName = toPascalCase(rawValue);
      if (!valueName) {
        continue;
      }

      const generatedName = ensureUniqueGeneratedName(`click${valueName}${roleSuffix}`);

      const added = addExtraClickMethod({
        kind: "click",
        name: generatedName,
        selector: {
          kind: "testId",
          formattedDataTestId: formattedDataTestIdForPom,
        },
        keyLiteral: rawValue,
        params: { wait: "boolean = true" },
      });

      if (added) {
        registerGeneratedMethodSignature(generatedName, { params: `wait: boolean = true`, argNames: ["wait"] });
      }
    }

    // For statically-known keys, we intentionally do NOT emit the generic keyed method.
    return { selectorValue: dataTestId, runtimeValue: runtimeDataTestId, fromExisting };
  }

  // Default/legacy behavior: emit the primary method+locator for this element.
  if (dataTestIdEntry.pom) {
    // Register merge lookup only for emitted primaries.
    if (dataTestIdEntry.pom.emitPrimary !== false) {
      const actionName = getGeneratedMethodName();
      primaryByActionName.set(actionName, dataTestIdEntry);
      const getterName = dataTestIdEntry.pom.getterNameOverride ?? getPrimaryGetterName(methodName);
      args.dependencies.__pomPrimaryByGetterName?.set(getterName, dataTestIdEntry);
    }

    registerPrimaryOnce(dataTestIdEntry.pom);
    const signature = getSignatureForGeneratedMethod();
    const generatedName = getGeneratedMethodName();
    registerGeneratedMethodSignature(generatedName, signature);
  }

  return { selectorValue: dataTestId, runtimeValue: runtimeDataTestId, fromExisting };
}

export interface IDataTestId {
  value: string;

  /** Optional parsed/constructed template literal for AST-based formatting in codegen. */
  templateLiteral?: TemplateLiteral;
  /** When the element is a router-link-like navigation, the resolved target page class name (e.g. TenantDetailsPage). */
  targetPageObjectModelClass?: string;

  /**
   * Generator-provided Page Object Model info for this element.
   *
   * IMPORTANT: This exists so emitters (TS/C#) can generate the POM API without
   * ever needing to parse the `data-testid` string itself.
   */
  pom?: PomPrimarySpec;
}

/**
 * Structured representation of a generated element for POM emission.
 *
 * - `formattedDataTestId` may contain the placeholder `${key}` when keyed.
 * - `params` is TypeScript-flavored today because TS is our reference emitter;
 *   C# emission maps these params to C# types.
 */
export interface PomPrimarySpec {
  nativeRole: NativeRole;
  /** Base semantic name (PascalCase). Verb prefixes are added by emitters. */
  methodName: string;
  /** Optional override for the generated locator getter name (used for edge-case collision avoidance). */
  getterNameOverride?: string;
  /** Test id pattern used by generated POM methods (may include `${key}` placeholder). */
  formattedDataTestId: string;
  /** Additional test id patterns that should be treated as equivalent to formattedDataTestId (merge-by-action). */
  alternateFormattedDataTestIds?: string[];

  /** Optional key used to decide whether distinct elements should be merged into one POM member. */
  mergeKey?: string;
  /** TypeScript param blocks used by the TS emitter (and signature metadata). */
  params: Record<string, string>;
  /** Optional enum values for key when derived from a static v-for list. */
  keyValuesOverride?: string[] | null;

  /** When false, emitters should NOT emit the primary method/locator for this entry. */
  emitPrimary?: boolean;
}

export type PomSelectorSpec =
  | {
    kind: "testId";
    /** Static or keyed test id; keyed uses `${key}` placeholder. */
    formattedDataTestId: string;
  }
  | {
    kind: "withinTestIdByLabel";
    /** Wrapper/root test id to scope the label search under. */
    rootFormattedDataTestId: string;
    /** Visible label text; may include `${value}` placeholder for dynamic methods. */
    formattedLabel: string;
    exact?: boolean;
  };

/**
 * Extra generated methods that are not a 1:1 mapping of an element's primary role.
 *
 * Examples:
 * - per-option radio helpers (selectFooBarBaz)
 * - per-key v-for helpers (clickOneButton/clickTwoButton)
 */
export interface PomExtraClickMethodSpec {
  kind: "click";
  name: string;
  selector: PomSelectorSpec;
  /** Optional fixed key to substitute into `${key}` in the method body. */
  keyLiteral?: string;
  params: Record<string, string>;
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

  /**
   * Extra methods emitted for this component/view (beyond the primary per-element methods).
   * These are stored as structured specs so additional language emitters can mirror behavior.
   */
  pomExtraMethods?: PomExtraClickMethodSpec[];

  /**
   * Internal: names reserved for generated members (getters + methods) to avoid collisions.
   *
   * This is populated during transform-time collection so the generator never needs to
   * parse `data-testid` values to disambiguate names.
   */
  reservedPomMemberNames?: Set<string>;

  /**
   * Internal: lookup of already-emitted primaries by their generated action method name.
   * Used to merge multiple elements with the same click handler / navigation target.
   */
  __pomPrimaryByActionName?: Map<string, IDataTestId>;

  /** Internal: lookup of already-emitted primaries by their generated getter name. */
  __pomPrimaryByGetterName?: Map<string, IDataTestId>;
}
