// Shared Babel AST type guards for semantic-name extraction.
// Consolidated from four per-function re-declarations (utils.ts x2,
// transform.ts, routing/to-directive.ts).

export const isNodeType = (node: object | null, type: string): node is { type: string } => {
  return node !== null && (node as { type?: string }).type === type;
};
export const isIdentifierNode = (node: object | null): node is { type: "Identifier"; name: string } => {
  return isNodeType(node, "Identifier") && typeof (node as { name?: string }).name === "string";
};
export const isStringLiteralNode = (node: object | null): node is { type: "StringLiteral"; value: string } => {
  return isNodeType(node, "StringLiteral") && typeof (node as { value?: string }).value === "string";
};
export const isBooleanLiteralNode = (node: object | null): node is { type: "BooleanLiteral"; value: boolean } => {
  return isNodeType(node, "BooleanLiteral") && typeof (node as { value?: boolean }).value === "boolean";
};
export const isNumericLiteralNode = (node: object | null): node is { type: "NumericLiteral"; value: number } => {
  return isNodeType(node, "NumericLiteral") && typeof (node as { value?: number }).value === "number";
};
export const isNullLiteralNode = (node: object | null): node is { type: "NullLiteral" } => {
  return isNodeType(node, "NullLiteral");
};
export const isMemberExpressionNode = (node: object | null): node is { type: "MemberExpression"; computed: boolean; object: object; property: object } => {
  if (!isNodeType(node, "MemberExpression"))
    return false;
  const n = node as { computed?: boolean; object?: object; property?: object };
  return typeof n.computed === "boolean"
    && typeof n.object === "object" && n.object !== null
    && typeof n.property === "object" && n.property !== null;
};
export const isCallExpressionNode = (node: object | null): node is { type: "CallExpression"; callee: object; arguments: object[] } => {
  if (!isNodeType(node, "CallExpression"))
    return false;
  const n = node as { callee?: object; arguments?: object[] };
  return typeof n.callee === "object" && n.callee !== null && Array.isArray(n.arguments);
};
export const isAwaitExpressionNode = (node: object | null): node is { type: "AwaitExpression"; argument: object } => {
  if (!isNodeType(node, "AwaitExpression"))
    return false;
  const n = node as { argument?: object };
  return typeof n.argument === "object" && n.argument !== null;
};
export const isAssignmentExpressionNode = (node: object | null): node is { type: "AssignmentExpression"; left: object; right: object } => {
  if (!isNodeType(node, "AssignmentExpression"))
    return false;
  const n = node as { left?: object; right?: object };
  return typeof n.left === "object" && n.left !== null && typeof n.right === "object" && n.right !== null;
};
export const isArrowFunctionExpressionNode = (node: object | null): node is { type: "ArrowFunctionExpression"; body: object } => {
  if (!isNodeType(node, "ArrowFunctionExpression"))
    return false;
  const n = node as { body?: object };
  return typeof n.body === "object" && n.body !== null;
};
export const isBlockStatementNode = (node: object | null): node is { type: "BlockStatement"; body: object[] } => {
  if (!isNodeType(node, "BlockStatement"))
    return false;
  const n = node as { body?: object[] };
  return Array.isArray(n.body);
};
export const isExpressionStatementNode = (node: object | null): node is { type: "ExpressionStatement"; expression: object } => {
  if (!isNodeType(node, "ExpressionStatement"))
    return false;
  const n = node as { expression?: object };
  return typeof n.expression === "object" && n.expression !== null;
};
export const isReturnStatementNode = (node: object | null): node is { type: "ReturnStatement"; argument: object | null } => {
  if (!isNodeType(node, "ReturnStatement"))
    return false;
  const n = node as { argument?: object | null };
  return typeof n.argument === "object" || n.argument === null;
};
export const isObjectExpressionNode = (node: object | null): node is { type: "ObjectExpression"; properties: object[] } => {
  if (!isNodeType(node, "ObjectExpression"))
    return false;
  const n = node as { properties?: object[] };
  return Array.isArray(n.properties);
};
export const isObjectPropertyNode = (node: object | null): node is { type: "ObjectProperty"; computed: boolean; key: object; value: object } => {
  if (!isNodeType(node, "ObjectProperty"))
    return false;
  const n = node as { computed?: boolean; key?: object; value?: object };
  return typeof n.computed === "boolean"
    && typeof n.key === "object" && n.key !== null
    && typeof n.value === "object" && n.value !== null;
};

/**
 * Same shape test without the `computed` field check — matches the guard
 * previously inlined in utils.ts's to-directive metadata reader and in
 * routing/to-directive.ts.
 */
export const isObjectPropertyNodeShallow = (node: object | null): node is { type: "ObjectProperty"; key: object; value: object } => {
  if (!isNodeType(node, "ObjectProperty"))
    return false;
  const n = node as { key?: object; value?: object };
  return typeof n.key === "object" && n.key !== null && typeof n.value === "object" && n.value !== null;
};
export const isLogicalExpressionNode = (node: object | null): node is { type: "LogicalExpression"; operator: string; left: object; right: object } => {
  if (!isNodeType(node, "LogicalExpression"))
    return false;
  const n = node as { operator?: string; left?: object; right?: object };
  return typeof n.operator === "string"
    && typeof n.left === "object" && n.left !== null
    && typeof n.right === "object" && n.right !== null;
};
