// Method content generation helpers.
//
// These are shared between transform-time codegen (building dependencies.methodsContent)
// and class-generation tests. This module is intentionally dependency-free with respect to
// generator internals to avoid circular imports between `utils` and `class-generation`.

import {
  createClassGetter,
  createClassMethod,
  renderClassMembers,
  type OptionalKind,
  type ParameterDeclarationStructure,
  type TypeScriptClassMember,
  type WriterFunction,
} from "./typescript-codegen";
import { isParameterizedPomPattern, uniquePomStringPatterns, type PomStringPattern } from "./pom-patterns";

function upperFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function splitTypeAndInitializer(typeExpression: string): { type: string; initializer?: string } {
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

function createParameter(name: string, typeExpression: string): OptionalKind<ParameterDeclarationStructure> {
  const { type, initializer } = splitTypeAndInitializer(typeExpression);
  return {
    name,
    type: type || undefined,
    initializer,
  };
}

function createParameters(params: Record<string, string>): OptionalKind<ParameterDeclarationStructure>[] {
  return Object.entries(params).map(([name, typeExpression]) => createParameter(name, typeExpression));
}

function createInlineParameter(
  name: string,
  options: {
    type?: string;
    initializer?: string;
  } = {},
): OptionalKind<ParameterDeclarationStructure> {
  return {
    name,
    type: options.type,
    initializer: options.initializer,
  };
}

function removeByKeySegment(value: string): string {
  const idx = value.lastIndexOf("ByKey");
  if (idx < 0) {
    return value;
  }
  return value.slice(0, idx) + value.slice(idx + "ByKey".length);
}

function testIdExpression(pattern: PomStringPattern): string {
  return isParameterizedPomPattern(pattern.patternKind)
    ? `\`${pattern.formatted}\``
    : JSON.stringify(pattern.formatted);
}

function ensureSelectorParameters(params: Record<string, string>, selector: PomStringPattern): Record<string, string> {
  if (!isParameterizedPomPattern(selector.patternKind) || selector.templateVariables.length === 0) {
    return params;
  }

  const orderedEntries: [string, string][] = [];
  const seen = new Set<string>();
  for (const variableName of selector.templateVariables) {
    seen.add(variableName);
    orderedEntries.push([variableName, params[variableName] ?? "string"]);
  }
  for (const [name, typeExpression] of Object.entries(params)) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    orderedEntries.push([name, typeExpression]);
  }
  return Object.fromEntries(orderedEntries);
}

function getIndexedSelectorVariable(selector: PomStringPattern): string | null {
  if (!isParameterizedPomPattern(selector.patternKind)) {
    return null;
  }

  if (selector.templateVariables.length !== 1) {
    throw new Error(
      `[vue-pom-generator] Parameterized locator getters require exactly one template variable; `
      + `got ${selector.templateVariables.length} in ${JSON.stringify(selector.formatted)}.`,
    );
  }

  return selector.templateVariables[0];
}

function createAsyncMethod(
  name: string,
  parameters: OptionalKind<ParameterDeclarationStructure>[],
  statements: WriterFunction,
): TypeScriptClassMember {
  return createClassMethod({
    name,
    isAsync: true,
    parameters,
    statements,
  });
}

function generateClickMethod(
  methodName: string,
  selector: PomStringPattern,
  alternateSelectors: PomStringPattern[] | undefined,
  params: Record<string, string>,
): TypeScriptClassMember[] {
  const name = `click${methodName}`;
  const noWaitName = `${name}NoWait`;
  const selectorParams = ensureSelectorParameters(params, selector);
  const hasSelectorVariables = selector.templateVariables.length > 0;
  const baseParameters = createParameters(selectorParams);
  const argsForForward = Object.keys(selectorParams).join(", ");
  const alternates = uniquePomStringPatterns(selector, alternateSelectors).slice(1);
  const primaryTestIdExpr = testIdExpression(selector);

  if (alternates.length > 0) {
    const candidatesExpr = [primaryTestIdExpr, ...alternates.map(id => testIdExpression(id))].join(", ");
    const clickMethod = createAsyncMethod(
      name,
      hasSelectorVariables
        ? [...baseParameters, createInlineParameter("wait", { type: "boolean", initializer: "true" })]
        : [createInlineParameter("wait", { type: "boolean", initializer: "true" })],
      (writer) => {
        writer.writeLine(`const candidates = [${candidatesExpr}] as const;`);
        writer.writeLine("let lastError: unknown;");
        writer.write("for (const testId of candidates) ").block(() => {
          writer.writeLine("const locator = this.locatorByTestId(testId);");
          writer.write("try ").block(() => {
            writer.write("if (await locator.count()) ").block(() => {
              writer.writeLine("await this.clickLocator(locator, \"\", wait);");
              writer.writeLine("return;");
            });
          });
          writer.write("catch (e) ").block(() => {
            writer.writeLine("lastError = e;");
          });
        });
        writer.writeLine(`throw (lastError instanceof Error) ? lastError : new Error("[pom] Failed to click any candidate locator for ${name}.");`);
      },
    );

    const noWaitArgs = argsForForward ? `${argsForForward}, false` : "false";
    const noWaitMethod = createAsyncMethod(
      noWaitName,
      hasSelectorVariables ? baseParameters : [],
      (writer) => {
        writer.writeLine(`await this.${name}(${noWaitArgs});`);
      },
    );

    return [clickMethod, noWaitMethod];
  }

  if (hasSelectorVariables) {
    return [
      createAsyncMethod(name, [...baseParameters, createInlineParameter("wait", { type: "boolean", initializer: "true" })], (writer) => {
        writer.writeLine(`await this.clickByTestId(${primaryTestIdExpr}, "", wait);`);
      }),
      createAsyncMethod(noWaitName, baseParameters, (writer) => {
        writer.writeLine(`await this.${name}(${argsForForward}, false);`);
      }),
    ];
  }

  return [
    createAsyncMethod(name, [createInlineParameter("wait", { type: "boolean", initializer: "true" })], (writer) => {
      writer.writeLine(`await this.clickByTestId(${primaryTestIdExpr}, "", wait);`);
    }),
    createAsyncMethod(noWaitName, [], (writer) => {
      writer.writeLine(`await this.${name}(false);`);
    }),
  ];
}

function generateRadioMethod(
  methodName: string,
  selector: PomStringPattern,
  params: Record<string, string>,
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = ensureSelectorParameters(params, selector);
  const parameters = createParameters(selectorParams);
  const testIdExpr = testIdExpression(selector);

  return [
    createAsyncMethod(name, parameters, (writer) => {
      writer.writeLine(`await this.clickByTestId(${testIdExpr}, annotationText);`);
    }),
  ];
}

function generateSelectMethod(
  methodName: string,
  selector: PomStringPattern,
  params: Record<string, string>,
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = ensureSelectorParameters(params, selector);
  const selectorExpr = `this.selectorForTestId(${testIdExpression(selector)})`;

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`const selector = ${selectorExpr};`);
        writer.writeLine("await this.animateCursorToElement(selector, false, 500, annotationText);");
        writer.writeLine("await this.page.selectOption(selector, value);");
      },
    ),
  ];
}

function generateVSelectMethod(
  methodName: string,
  selector: PomStringPattern,
  params: Record<string, string>,
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = ensureSelectorParameters(params, selector);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`await this.selectVSelectByTestId(${testIdExpression(selector)}, value, timeOut, annotationText);`);
      },
    ),
  ];
}

function generateTypeMethod(
  methodName: string,
  selector: PomStringPattern,
  params: Record<string, string>,
): TypeScriptClassMember[] {
  const name = `type${methodName}`;
  const selectorParams = ensureSelectorParameters(params, selector);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`await this.fillInputByTestId(${testIdExpression(selector)}, text, annotationText);`);
      },
    ),
  ];
}

function isAllDigits(value: string): boolean {
  if (!value)
    return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57)
      return false;
  }
  return true;
}

function generateGetElementByDataTestId(
  methodName: string,
  nativeRole: string,
  selector: PomStringPattern,
  alternateSelectors: PomStringPattern[] | undefined,
  getterNameOverride: string | undefined,
  params: Record<string, string>,
): TypeScriptClassMember[] {
  const roleSuffix = upperFirst(nativeRole || "Element");
  const baseName = upperFirst(methodName);
  const numericSuffix = baseName.startsWith(roleSuffix) ? baseName.slice(roleSuffix.length) : "";
  const hasRoleSuffix = baseName.endsWith(roleSuffix) || (baseName.startsWith(roleSuffix) && isAllDigits(numericSuffix));
  const propertyName = hasRoleSuffix ? `${baseName}` : `${baseName}${roleSuffix}`;
  const selectorParams = ensureSelectorParameters(params, selector);
  const indexedVariable = getIndexedSelectorVariable(selector);

  if (indexedVariable) {
    const keyType = selectorParams[indexedVariable] || "string";
    const keyedPropertyName = getterNameOverride ?? removeByKeySegment(propertyName);
    return [
      createClassGetter({
        name: keyedPropertyName,
        statements: [
          `return this.keyedLocators((${indexedVariable}: ${keyType}) => this.locatorByTestId(${testIdExpression(selector)}));`,
        ],
      }),
    ];
  }

  const finalPropertyName = getterNameOverride ?? propertyName;
  const alternates = uniquePomStringPatterns(selector, alternateSelectors).slice(1);
  if (alternates.length > 0) {
    const all = [selector, ...alternates];
    const locatorExpr = all
      .map(id => `this.locatorByTestId(${testIdExpression(id)})`)
      .reduce((acc, next) => `${acc}.or(${next})`);

    return [
      createClassGetter({
        name: finalPropertyName,
        statements: [`return ${locatorExpr};`],
      }),
    ];
  }

  return [
    createClassGetter({
      name: finalPropertyName,
      statements: [`return this.locatorByTestId(${testIdExpression(selector)});`],
    }),
  ];
}

function generateNavigationMethod(args: {
  targetPageObjectModelClass: string;
  baseMethodName: string;
  selector: PomStringPattern;
  alternateSelectors?: PomStringPattern[];
  params: Record<string, string>;
}): TypeScriptClassMember[] {
  const { targetPageObjectModelClass: target, baseMethodName, selector, alternateSelectors, params } = args;

  const methodName = baseMethodName
    ? `goTo${upperFirst(baseMethodName)}`
    : `goTo${target.endsWith("Page") ? target.slice(0, -"Page".length) : target}`;

  const selectorParams = ensureSelectorParameters(params, selector);
  const parameters = createParameters(selectorParams);
  const alternates = uniquePomStringPatterns(selector, alternateSelectors).slice(1);
  const candidatesExpr = [testIdExpression(selector), ...alternates.map(id => testIdExpression(id))].join(", ");

  if (alternates.length > 0) {
    return [
      createClassMethod({
        name: methodName,
        parameters,
        returnType: `Fluent<${target}>`,
        statements: (writer) => {
          writer.write("return this.fluent(async () => ").block(() => {
            writer.writeLine(`const candidates = [${candidatesExpr}] as const;`);
            writer.writeLine("let lastError: unknown;");
            writer.write("for (const testId of candidates) ").block(() => {
              writer.writeLine("const locator = this.locatorByTestId(testId);");
              writer.write("try ").block(() => {
                writer.write("if (await locator.count()) ").block(() => {
                  writer.writeLine("await this.clickLocator(locator);");
                  writer.writeLine(`return new ${target}(this.page);`);
                });
              });
              writer.write("catch (e) ").block(() => {
                writer.writeLine("lastError = e;");
              });
            });
            writer.writeLine(`throw (lastError instanceof Error) ? lastError : new Error("[pom] Failed to navigate using any candidate locator for ${methodName}.");`);
          });
          writer.writeLine(");");
        },
      }),
    ];
  }

  return [
    createClassMethod({
      name: methodName,
      parameters,
      returnType: `Fluent<${target}>`,
      statements: (writer) => {
        writer.write("return this.fluent(async () => ").block(() => {
          writer.writeLine(`await this.clickByTestId(${testIdExpression(selector)});`);
          writer.writeLine(`return new ${target}(this.page);`);
        });
        writer.writeLine(");");
      },
    }),
  ];
}

export function generateViewObjectModelMembers(
  targetPageObjectModelClass: string | undefined,
  methodName: string,
  nativeRole: string,
  selector: PomStringPattern,
  alternateSelectors: PomStringPattern[] | undefined,
  getterNameOverride: string | undefined,
  params: Record<string, string>,
): TypeScriptClassMember[] {
  const baseMethodName = (nativeRole === "radio")
    ? (methodName || "Radio")
    : methodName;

  const members = generateGetElementByDataTestId(
    baseMethodName,
    nativeRole,
    selector,
    alternateSelectors,
    getterNameOverride,
    params,
  );

  if (targetPageObjectModelClass) {
    return [
      ...members,
      ...generateNavigationMethod({
        targetPageObjectModelClass,
        baseMethodName,
        selector,
        alternateSelectors,
        params,
      }),
    ];
  }

  if (nativeRole === "select") {
    return [...members, ...generateSelectMethod(baseMethodName, selector, params)];
  }
  if (nativeRole === "vselect") {
    return [...members, ...generateVSelectMethod(baseMethodName, selector, params)];
  }
  if (nativeRole === "input") {
    return [...members, ...generateTypeMethod(baseMethodName, selector, params)];
  }
  if (nativeRole === "radio") {
    return [...members, ...generateRadioMethod(baseMethodName || "Radio", selector, params)];
  }

  return [...members, ...generateClickMethod(baseMethodName, selector, alternateSelectors, params)];
}

export function generateViewObjectModelMethodContent(
  targetPageObjectModelClass: string | undefined,
  methodName: string,
  nativeRole: string,
  selector: PomStringPattern,
  alternateSelectors: PomStringPattern[] | undefined,
  getterNameOverride: string | undefined,
  params: Record<string, string>,
) {
  return renderClassMembers(
    generateViewObjectModelMembers(
      targetPageObjectModelClass,
      methodName,
      nativeRole,
      selector,
      alternateSelectors,
      getterNameOverride,
      params,
    ),
  );
}
