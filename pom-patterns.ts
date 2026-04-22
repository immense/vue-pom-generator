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
