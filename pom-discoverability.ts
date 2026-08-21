// Humanization helpers for POM method/component names. These operate on already-generated
// identifier strings (camelCase splitting, separator normalization) — not on source code —
// so regex is the appropriate tool here rather than AST-based parsing.
/* eslint-disable no-restricted-syntax */

/**
 * Split an already-generated POM identifier into its constituent words for
 * humanization, returned lowercased. Operates on generated identifier
 * strings, not source code.
 *
 * @example
 * splitWords("clickUserCardByKey") // ["click", "user", "card"]
 * splitWords("MyComponent.vue") // ["my", "component", "vue"]
 * splitWords("") // []
 */
function splitWords(value: string): string[] {
  const normalized = value
    .replace(/ByKey/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\s+/)
    .map(word => word.toLowerCase())
    .filter(Boolean);
}

/**
 * Join humanized words back into a single trimmed phrase with collapsed
 * whitespace. The inverse of {@link splitWords} for display.
 * Operates on generated identifier strings, not source code.
 *
 * @example
 * joinWords(["user", "card"]) // "user card"
 * joinWords(["  click ", "", "submit"]) // "click submit"
 */
function joinWords(words: readonly string[]): string {
  return words.join(" ").replace(/\s+/g, " ").trim();
}

function toSentenceCase(value: string): string {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

function stripComponentKindSuffix(componentName: string): string {
  for (const suffix of ["Page", "Component", "Layout"]) {
    if (componentName.endsWith(suffix) && componentName.length > suffix.length) {
      return componentName.slice(0, -suffix.length);
    }
  }

  return componentName;
}

function removeLeadingWords(words: readonly string[], prefixWords: readonly string[]): string[] {
  if (!prefixWords.length || words.length < prefixWords.length) {
    return [...words];
  }

  for (let i = 0; i < prefixWords.length; i++) {
    if (words[i] !== prefixWords[i]) {
      return [...words];
    }
  }

  return words.slice(prefixWords.length);
}

function removeTrailingRoleWord(words: readonly string[], roleWord: string): string[] {
  if (!words.length || words[words.length - 1] !== roleWord) {
    return [...words];
  }

  return words.slice(0, -1);
}

export function humanizePomMethodName(methodName: string): string {
  return joinWords(splitWords(methodName));
}

export function stripPomActionPrefix(actionName: string): string {
  for (const prefix of ["click", "select", "type", "goTo"]) {
    if (actionName.startsWith(prefix) && actionName.length > prefix.length) {
      return actionName.slice(prefix.length);
    }
  }

  return actionName;
}

export function normalizePomRoleLabel(nativeRole: string): string {
  if (nativeRole === "vselect") {
    return "select";
  }

  return nativeRole || "element";
}

export function buildPomLocatorDescription(args: {
  componentName?: string;
  methodName: string;
  nativeRole: string;
}): string {
  const componentWords = splitWords(args.componentName ? stripComponentKindSuffix(args.componentName) : "");
  const roleWord = normalizePomRoleLabel(args.nativeRole).toLowerCase();
  const semanticWords = removeLeadingWords(
    removeTrailingRoleWord(splitWords(args.methodName), roleWord),
    componentWords,
  );

  const phrase = joinWords([
    ...componentWords,
    ...semanticWords,
    roleWord,
  ]);

  return toSentenceCase(phrase || "Generated element");
}

/* eslint-enable no-restricted-syntax */
