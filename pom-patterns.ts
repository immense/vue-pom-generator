import { normalizePomParameters, type PomParameterInput, type PomParameterSpec } from "./pom-params";

export type PomPatternKind = "static" | "parameterized";

export function isParameterizedPomPattern(kind: PomPatternKind): boolean {
  return kind === "parameterized";
}

export interface PomStringPattern {
  formatted: string;
  patternKind: PomPatternKind;
  /**
   * Unique `${...}` variable names referenced by `formatted`, in first-occurrence order.
   *
   * Supplied explicitly at construction — never re-derived from `formatted`. The
   * construction site knows which variables it inserted; `formatted` keeps the
   * `${...}` text only for emission.
   */
  templateVariables: string[];
}

export interface PomPatternBinding {
  expression: string;
  setupStatements: string[];
}

/**
 * Construct a `PomStringPattern` from explicit metadata.
 *
 * `templateVariables` is required and is the sole source of truth for which
   * method-parameter slots the pattern exposes. It is never inferred from
   * `formatted` — pass `[]` for static patterns, or the variable names (e.g.
   * `["key"]`, `["value"]`) for parameterized ones.
 */
export function createPomStringPattern(
  formatted: string,
  patternKind: PomPatternKind,
  templateVariables: readonly string[],
): PomStringPattern {
  return {
    formatted,
    patternKind,
    templateVariables: [...templateVariables],
  };
}

function getPomPatternVariables(
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

export function orderPomPatternParameters(
  params: PomParameterInput,
  patterns: readonly PomStringPattern[],
  options: {
    omit?: readonly string[];
  } = {},
): PomParameterSpec[] {
  const currentParams = normalizePomParameters(params);
  const orderedParams: PomParameterSpec[] = [];
  const seen = new Set<string>();
  const missingParams: string[] = [];

  for (const variableName of getPomPatternVariables(patterns, options)) {
    seen.add(variableName);
    const existingParam = currentParams.find(param => param.name === variableName);
    if (!existingParam) {
      missingParams.push(variableName);
      continue;
    }
    orderedParams.push(existingParam);
  }

  if (missingParams.length > 0) {
    const availableParams = currentParams.map(param => JSON.stringify(param.name)).join(", ") || "<none>";
    const patternSummary = patterns.map(pattern => JSON.stringify(pattern.formatted)).join(", ");
    throw new Error(
      `[vue-pom-generator] Missing selector parameter(s) ${missingParams.map(name => JSON.stringify(name)).join(", ")} `
      + `for parameterized pattern(s) ${patternSummary}. `
      + `Available parameters: ${availableParams}.`,
    );
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

/**
 * Render a pattern as a C# interpolated-string expression.
 *
 * For static patterns this is a JSON-quoted literal. For parameterized patterns
 * it converts our `${var}` placeholder format into C# interpolation braces
 * (`{var}`) and wraps the result as a C# interpolated string. This converts
 * placeholder syntax in a generated pattern string, not source code.
 *
 * @example
 * toCSharpPomPatternExpression(createPomStringPattern("submit", "static", [])) // "\"submit\""
 * toCSharpPomPatternExpression(createPomStringPattern("item-${key}", "parameterized", ["key"])) // "$\"item-{key}\""
 */
export function toCSharpPomPatternExpression(pattern: PomStringPattern): string {
  if (!isParameterizedPomPattern(pattern.patternKind)) {
    return JSON.stringify(pattern.formatted);
  }

  // Convert our `${var}` placeholder format into C# interpolated-string `{var}`.
  /* eslint-disable no-restricted-syntax -- converting ${var} placeholders to C# interpolation braces in a generated pattern string, not parsing source code */
  const inner = pattern.formatted.replace(/\$\{/g, "{");
  /* eslint-enable no-restricted-syntax */
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
