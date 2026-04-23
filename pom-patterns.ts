import { createPomParameterSpec, normalizePomParameters, type PomParameterInput, type PomParameterSpec } from "./pom-params";

export type PomPatternKind = "static" | "parameterized";

export function isParameterizedPomPattern(kind: PomPatternKind): boolean {
  return kind === "parameterized";
}

export interface PomStringPattern {
  formatted: string;
  patternKind: PomPatternKind;
  /** Unique `${...}` variable names referenced by `formatted`, in first-occurrence order. */
  templateVariables: string[];
}

export interface PomPatternBinding {
  expression: string;
  setupStatements: string[];
}

export function inferPomPatternKindFromFormattedString(value: string): PomPatternKind {
  return value.includes("${") ? "parameterized" : "static";
}

function getTemplateVariables(formatted: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = formatted.matchAll(/\$\{(\w+)\}/g);
  for (const match of matches) {
    const variableName = match[1];
    if (seen.has(variableName)) {
      continue;
    }
    seen.add(variableName);
    out.push(variableName);
  }
  return out;
}

export function createPomStringPattern(formatted: string, patternKind: PomPatternKind): PomStringPattern {
  return {
    formatted,
    patternKind,
    templateVariables: getTemplateVariables(formatted),
  };
}

export function inferPomStringPattern(formatted: string): PomStringPattern {
  return createPomStringPattern(formatted, inferPomPatternKindFromFormattedString(formatted));
}

export function getPomPatternVariables(
  patterns: readonly PomStringPattern[],
  options: { omit?: readonly string[] } = {},
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const omitted = new Set(options.omit ?? []);

  for (const pattern of patterns) {
    for (const variableName of pattern.templateVariables) {
      if (omitted.has(variableName) || seen.has(variableName)) {
        continue;
      }
      seen.add(variableName);
      out.push(variableName);
    }
  }

  return out;
}

export function ensurePomPatternParameters(
  params: PomParameterInput,
  patterns: readonly PomStringPattern[],
  options: {
    omit?: readonly string[];
    defaultType?: string;
  } = {},
): PomParameterSpec[] {
  const currentParams = normalizePomParameters(params);
  const defaultType = options.defaultType ?? "string";
  const orderedParams: PomParameterSpec[] = [];
  const seen = new Set<string>();

  for (const variableName of getPomPatternVariables(patterns, options)) {
    seen.add(variableName);
    orderedParams.push(currentParams.find(param => param.name === variableName) ?? createPomParameterSpec(variableName, defaultType));
  }

  for (const param of currentParams) {
    if (seen.has(param.name)) {
      continue;
    }
    seen.add(param.name);
    orderedParams.push(param);
  }

  return orderedParams;
}

export function getIndexedPomPatternVariable(pattern: PomStringPattern): string | null {
  if (!isParameterizedPomPattern(pattern.patternKind)) {
    return null;
  }

  if (pattern.templateVariables.length !== 1) {
    throw new Error(
      `[vue-pom-generator] Parameterized locator getters require exactly one template variable; `
      + `got ${pattern.templateVariables.length} in ${JSON.stringify(pattern.formatted)}.`,
    );
  }

  return pattern.templateVariables[0];
}

export function hasPomPatternVariables(pattern: PomStringPattern): boolean {
  return pattern.templateVariables.length > 0;
}

export function toTypeScriptPomPatternExpression(pattern: PomStringPattern): string {
  return isParameterizedPomPattern(pattern.patternKind)
    ? `\`${pattern.formatted}\``
    : JSON.stringify(pattern.formatted);
}

export function toCSharpPomPatternExpression(pattern: PomStringPattern): string {
  if (!isParameterizedPomPattern(pattern.patternKind)) {
    return JSON.stringify(pattern.formatted);
  }

  // Convert our `${var}` placeholder format into C# interpolated-string `{var}`.
  const inner = pattern.formatted.replace(/\$\{/g, "{");
  // JSON.stringify gives us a normal quoted string literal with escaping that is close
  // enough for the C# interpolated-string wrapper we emit.
  return `$${JSON.stringify(inner)}`;
}

export function bindTypeScriptPomPattern(pattern: PomStringPattern, variableName: string): PomPatternBinding {
  const expression = toTypeScriptPomPatternExpression(pattern);
  if (!isParameterizedPomPattern(pattern.patternKind)) {
    return { expression, setupStatements: [] };
  }

  return {
    expression: variableName,
    setupStatements: [`const ${variableName} = ${expression};`],
  };
}

export function bindCSharpPomPattern(pattern: PomStringPattern, variableName: string): PomPatternBinding {
  const expression = toCSharpPomPatternExpression(pattern);
  if (!isParameterizedPomPattern(pattern.patternKind)) {
    return { expression, setupStatements: [] };
  }

  return {
    expression: variableName,
    setupStatements: [`var ${variableName} = ${expression};`],
  };
}

export function pomStringPatternEquals(left: PomStringPattern, right: PomStringPattern): boolean {
  return left.formatted === right.formatted && left.patternKind === right.patternKind;
}

export function uniquePomStringPatterns(primary: PomStringPattern, alternates?: PomStringPattern[]): PomStringPattern[] {
  const out: PomStringPattern[] = [];
  const seen = new Set<string>();
  const add = (pattern: PomStringPattern) => {
    const key = JSON.stringify(pattern);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(pattern);
  };

  add(primary);
  for (const alternate of alternates ?? []) {
    add(alternate);
  }

  return out;
}
