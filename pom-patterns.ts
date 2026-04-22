export type PomPatternKind = "static" | "parameterized";

export function isParameterizedPomPattern(kind: PomPatternKind): boolean {
  return kind === "parameterized";
}

export function inferPomPatternKindFromFormattedString(value: string): PomPatternKind {
  return value.includes("${") ? "parameterized" : "static";
}
