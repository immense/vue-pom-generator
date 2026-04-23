import type { OptionalKind, ParameterDeclarationStructure } from "./typescript-codegen";

export interface PomParameterSpec {
  name: string;
  typeExpression?: string;
  type?: string;
  initializer?: string;
  hasQuestionToken?: boolean;
  isRestParameter?: boolean;
}

export interface PomMethodSignature {
  parameters: PomParameterSpec[];
}

export type PomLegacyParameterRecord = Record<string, string>;
export type PomParameterInput = readonly PomParameterSpec[] | undefined;
export type PomParameterSource = PomLegacyParameterRecord | PomParameterInput;

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

export function createPomParameterSpec(
  name: string,
  typeExpression?: string,
  options: {
    initializer?: string;
    hasQuestionToken?: boolean;
    isRestParameter?: boolean;
  } = {},
): PomParameterSpec {
  const normalizedTypeExpression = typeExpression?.trim();
  const { type, initializer } = normalizedTypeExpression
    ? splitPomParameterTypeExpression(normalizedTypeExpression)
    : { type: undefined, initializer: undefined };
  return {
    name,
    typeExpression: normalizedTypeExpression,
    type,
    initializer: options.initializer ?? initializer,
    hasQuestionToken: options.hasQuestionToken,
    isRestParameter: options.isRestParameter,
  };
}

export function normalizePomParameters(params: PomParameterSource): PomParameterSpec[] {
  if (!params) {
    return [];
  }

  if (Array.isArray(params)) {
    return params.map(param => createPomParameterSpec(param.name, param.typeExpression ?? param.type, {
      initializer: param.initializer,
      hasQuestionToken: param.hasQuestionToken,
      isRestParameter: param.isRestParameter,
    }));
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

export function setPomParameter(
  params: PomParameterInput,
  name: string,
  typeExpression?: string,
  options: {
    initializer?: string;
    hasQuestionToken?: boolean;
    isRestParameter?: boolean;
  } = {},
): PomParameterSpec[] {
  const nextParam = createPomParameterSpec(name, typeExpression, options);
  const normalizedParams = normalizePomParameters(params);
  const existingIndex = normalizedParams.findIndex(param => param.name === name);
  if (existingIndex < 0) {
    return [...normalizedParams, nextParam];
  }

  const nextParams = normalizedParams.slice();
  nextParams[existingIndex] = nextParam;
  return nextParams;
}

export function removePomParameter(params: PomParameterInput, name: string): PomParameterSpec[] {
  return normalizePomParameters(params).filter(param => param.name !== name);
}

export function toTypeScriptPomParameterStructures(params: PomParameterInput): OptionalKind<ParameterDeclarationStructure>[] {
  return normalizePomParameters(params).map(param => ({
    name: param.name,
    type: param.type || undefined,
    initializer: param.initializer,
    hasQuestionToken: param.hasQuestionToken,
    isRestParameter: param.isRestParameter,
  }));
}

export function getPomParameterArgumentNames(params: PomParameterInput): string[] {
  return normalizePomParameters(params).map(param => param.isRestParameter ? `...${param.name}` : param.name);
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
    && left.initializer === right.initializer
    && left.hasQuestionToken === right.hasQuestionToken
    && left.isRestParameter === right.isRestParameter;
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
