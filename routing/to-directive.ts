import type { DirectiveNode } from "@vue/compiler-core";
import { stringifyExpression } from "@vue/compiler-core";
import { parseExpression } from "@babel/parser";

interface RouteLocationLike {
  name?: string;
  path?: string;
  params?: Record<string, string | number>;
}

type ResolveToComponentNameFn = (to: RouteLocationLike | string) => string | null;

function toPascalCaseRouteKey(value: string): string {
  // Local, minimal PascalCase conversion for route names.
  // Avoids string.match/replace/split (restricted in this package).
  let out = "";
  let newWord = true;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = ch.charCodeAt(0);

    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isAlphaNum = isDigit || isUpper || isLower;

    if (!isAlphaNum) {
      newWord = true;
      continue;
    }

    if (newWord) {
      out += isLower ? ch.toUpperCase() : ch;
      newWord = false;
      continue;
    }

    out += ch;
  }
  return out;
}

// Router-backed route name -> component name map.
//
// Populated once per Vite build by the plugin runtime (see `vite-plugins/vue-pom-generator/index.ts`).
// The transform phase uses this to turn `:to` directives into POM return types.
let routeNameToComponentName: Map<string, string> | null = null;
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

function toDirectiveObjectFieldNameValue(toDirective: DirectiveNode): string | null {
  const to = getRouteLocationLikeFromToDirective(toDirective);
  if (!to || typeof to === "string")
    return null;

  const name = to.name;
  if (typeof name !== "string")
    return null;

  const trimmed = name.trim();
  if (!trimmed.length)
    return null;

  return toPascalCaseRouteKey(trimmed);
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
