import type { DirectiveNode } from "@vue/compiler-core";
import { stringifyExpression } from "@vue/compiler-core";
import { parseExpression } from "@babel/parser";

import {
  isAsciiAlphaNumericCode,
  isAsciiLowercaseLetterCode,
} from "../utils";

interface RouteLocationLike {
  name?: string;
  path?: string;
  params?: Record<string, string | number>;
}

interface RouteLocationTarget {
  name?: string;
  path?: string;
}

export type RouteDirectiveTargetAnalysis =
  | {
    kind: "resolved";
    rawSource: string;
    target: string | RouteLocationTarget;
    routeNameKey: string | null;
    paramKeys: string[];
  }
  | {
    kind: "unsupported";
    rawSource: string | null;
    reason: "missing-expression" | "dynamic-expression" | "missing-name-or-path";
  }
  | {
    kind: "parse-error";
    rawSource: string;
    reason: "parse-error";
    error: string;
  };

type ResolveToComponentNameFn = (to: RouteLocationLike | string) => string | null;

function toPascalCaseRouteKey(value: string): string {
  // Local, minimal PascalCase conversion for route names.
  // Avoids string.match/replace/split (restricted in this package).
  let out = "";
  let newWord = true;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = ch.charCodeAt(0);

    const isLower = isAsciiLowercaseLetterCode(code);
    const isAlphaNum = isAsciiAlphaNumericCode(code);

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

function materializeResolvedRouteTarget(
  target: string | RouteLocationTarget,
  paramKeys: string[],
): RouteLocationLike | string {
  if (typeof target === "string")
    return target;
  if (!paramKeys.length)
    return target;
  return {
    ...target,
    params: buildPlaceholderParams(paramKeys),
  };
}

export function analyzeToDirectiveTarget(toDirective: DirectiveNode): RouteDirectiveTargetAnalysis {
  if (!toDirective.exp) {
    return {
      kind: "unsupported",
      rawSource: null,
      reason: "missing-expression",
    };
  }

  const rawSource = stringifyExpression(toDirective.exp).trim();

  let expr: object;
  try {
    expr = parseExpression(rawSource, { plugins: ["typescript"] });
  }
  catch (error) {
    return {
      kind: "parse-error",
      rawSource,
      reason: "parse-error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (isStringLiteralNode(expr)) {
    return {
      kind: "resolved",
      rawSource,
      target: expr.value,
      routeNameKey: null,
      paramKeys: [],
    };
  }

  if (!isObjectExpressionNode(expr)) {
    return {
      kind: "unsupported",
      rawSource,
      reason: "dynamic-expression",
    };
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

  let paramKeys: string[] = [];
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
    paramKeys = Array.from(new Set(keys));
  }

  if (name) {
    const trimmed = name.trim();
    if (!trimmed.length) {
      return {
        kind: "unsupported",
        rawSource,
        reason: "missing-name-or-path",
      };
    }
    return {
      kind: "resolved",
      rawSource,
      target: { name },
      routeNameKey: toPascalCaseRouteKey(trimmed),
      paramKeys,
    };
  }

  if (path) {
    return {
      kind: "resolved",
      rawSource,
      target: { path },
      routeNameKey: null,
      paramKeys,
    };
  }

  return {
    kind: "unsupported",
    rawSource,
    reason: "missing-name-or-path",
  };
}

/**
 * Attempts to extract a *stable* route name key from a `:to` directive.
 *
 * Supported (best-effort):
 * - :to="{ name: 'Tenant Details', params: { ... } }"
 * - :to="someVar" (cannot be resolved statically; returns null)
 */
export function getRouteNameKeyFromToDirective(toDirective: DirectiveNode): string | null {
  const analysis = analyzeToDirectiveTarget(toDirective);
  return analysis.kind === "resolved" ? analysis.routeNameKey : null;
}

/**
 * Given a `:to` directive, try to resolve the target view/page component name.
 *
 * Returns the Vue component identifier (e.g. `TenantDetailsPage`) when available.
 */
export function tryResolveToDirectiveTargetComponentName(toDirective: DirectiveNode): string | null {
  const analysis = analyzeToDirectiveTarget(toDirective);

  // Prefer router.resolve (more accurate; can handle path or name + placeholder params).
  if (analysis.kind === "resolved" && resolveToComponentName) {
    const resolved = resolveToComponentName(materializeResolvedRouteTarget(analysis.target, analysis.paramKeys));
    if (resolved)
      return resolved;
  }

  // Fallback: route name -> component map (best-effort)
  if (analysis.kind !== "resolved" || !analysis.routeNameKey || !routeNameToComponentName)
    return null;

  return routeNameToComponentName.get(analysis.routeNameKey) ?? null;
}
