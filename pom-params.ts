export interface PomParameterSpec {
  name: string;
  typeExpression: string;
  type: string;
  initializer?: string;
}

export function splitPomParameterTypeExpression(typeExpression: string): { type: string; initializer?: string } {
  const trimmed = typeExpression.trim();
  const initializerIndex = trimmed.lastIndexOf("=");
  if (initializerIndex < 0) {
    return { type: trimmed };
  }

  return {
    type: trimmed.slice(0, initializerIndex).trim(),
    initializer: trimmed.slice(initializerIndex + 1).trim(),
  };
}

export function normalizePomParameters(params: Record<string, string> | undefined): PomParameterSpec[] {
  if (!params) {
    return [];
  }

  return Object.entries(params).map(([name, typeExpression]) => {
    const { type, initializer } = splitPomParameterTypeExpression(typeExpression);
    return {
      name,
      typeExpression,
      type,
      initializer,
    };
  });
}

export function getPomParameterNames(params: Record<string, string> | undefined): string[] {
  return normalizePomParameters(params).map(param => param.name);
}

export function formatTypeScriptPomParameters(params: Record<string, string> | undefined): string {
  return normalizePomParameters(params)
    .map(param => `${param.name}: ${param.typeExpression}`)
    .join(", ");
}
