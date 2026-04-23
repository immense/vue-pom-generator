function splitDiscoverabilityWords(value: string): string[] {
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

function joinDiscoverabilityWords(words: readonly string[]): string {
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
  return joinDiscoverabilityWords(splitDiscoverabilityWords(methodName));
}

export function humanizePomComponentName(componentName: string): string {
  return joinDiscoverabilityWords(splitDiscoverabilityWords(stripComponentKindSuffix(componentName)));
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
  const componentWords = splitDiscoverabilityWords(args.componentName ? stripComponentKindSuffix(args.componentName) : "");
  const roleWord = normalizePomRoleLabel(args.nativeRole).toLowerCase();
  const semanticWords = removeLeadingWords(
    removeTrailingRoleWord(splitDiscoverabilityWords(args.methodName), roleWord),
    componentWords,
  );

  const phrase = joinDiscoverabilityWords([
    ...componentWords,
    ...semanticWords,
    roleWord,
  ]);

  return toSentenceCase(phrase || "Generated element");
}
