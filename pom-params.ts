export interface PomParameterSpec {
  name: string;
  typeExpression: string;
  type: string;
  initializer?: string;
}

export interface PomMethodSignature {
  parameters: PomParameterSpec[];
}

export type PomParameterInput = Record<string, string> | readonly PomParameterSpec[] | undefined;

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

export function createPomParameterSpec(name: string, typeExpression: string): PomParameterSpec {
  const { type, initializer } = splitPomParameterTypeExpression(typeExpression);
  return {
    name,
    typeExpression,
    type,
    initializer,
  };
}

export function normalizePomParameters(params: PomParameterInput): PomParameterSpec[] {
  if (!params) {
    return [];
  }

  if (Array.isArray(params)) {
    return params.map(param => ({ ...param }));
  }

  return Object.entries(params).map(([name, typeExpression]) => createPomParameterSpec(name, typeExpression));
}

export function getPomParameterNames(params: PomParameterInput): string[] {
  return normalizePomParameters(params).map(param => param.name);
}

export function getPomParameter(params: PomParameterInput, name: string): PomParameterSpec | undefined {
  return normalizePomParameters(params).find(param => param.name === name);
}

export function hasPomParameter(params: PomParameterInput, name: string): boolean {
  return !!getPomParameter(params, name);
}

export function formatTypeScriptPomParameters(params: PomParameterInput): string {
  return normalizePomParameters(params)
    .map(param => `${param.name}: ${param.typeExpression}`)
    .join(", ");
}

export function createPomMethodSignature(parameters: PomParameterInput): PomMethodSignature {
  return {
    parameters: normalizePomParameters(parameters),
  };
}

export function pomParameterSpecEquals(left: PomParameterSpec, right: PomParameterSpec): boolean {
  return left.name === right.name
    && left.typeExpression === right.typeExpression
    && left.type === right.type
    && left.initializer === right.initializer;
}

export function pomParameterListEquals(left: PomParameterInput, right: PomParameterInput): boolean {
  const leftParams = normalizePomParameters(left);
  const rightParams = normalizePomParameters(right);
  if (leftParams.length !== rightParams.length) {
    return false;
  }

  return leftParams.every((param, index) => pomParameterSpecEquals(param, rightParams[index]));
}

export function pomMethodSignatureEquals(left: PomMethodSignature, right: PomMethodSignature): boolean {
  return pomParameterListEquals(left.parameters, right.parameters);
}
