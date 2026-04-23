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
import {
  getPomParameter,
  getPomParameterNames,
  toTypeScriptPomParameterStructures,
  type PomParameterSpec,
} from "./pom-params";
import {
  getIndexedPomPatternVariable,
  hasPomPatternVariables,
  orderPomPatternParameters,
  toTypeScriptPomPatternExpression,
  uniquePomStringPatterns,
  type PomStringPattern,
} from "./pom-patterns";

function upperFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function createParameters(params: readonly PomParameterSpec[]): OptionalKind<ParameterDeclarationStructure>[] {
  return toTypeScriptPomParameterStructures(params);
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
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `click${methodName}`;
  const noWaitName = `${name}NoWait`;
  const selectorParams = orderPomPatternParameters(parameters, [selector]);
  const hasSelectorVariables = hasPomPatternVariables(selector);
  const baseParameters = createParameters(selectorParams);
  const argsForForward = getPomParameterNames(selectorParams).join(", ");
  const alternates = uniquePomStringPatterns(selector, alternateSelectors).slice(1);
  const primaryTestIdExpr = toTypeScriptPomPatternExpression(selector);

  if (alternates.length > 0) {
    const candidatesExpr = [primaryTestIdExpr, ...alternates.map(id => toTypeScriptPomPatternExpression(id))].join(", ");
    const clickMethod = createAsyncMethod(
      name,
      hasSelectorVariables
        ? [
            ...baseParameters,
            createInlineParameter("wait", { type: "boolean", initializer: "true" }),
            createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
          ]
        : [
            createInlineParameter("wait", { type: "boolean", initializer: "true" }),
            createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
          ],
      (writer) => {
        writer.writeLine(`const candidates = [${candidatesExpr}] as const;`);
        writer.writeLine("let lastError: unknown;");
        writer.write("for (const testId of candidates) ").block(() => {
          writer.writeLine("const locator = this.locatorByTestId(testId);");
          writer.write("try ").block(() => {
            writer.write("if (await locator.count()) ").block(() => {
              writer.writeLine("await this.clickLocator(locator, annotationText, wait);");
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

    const noWaitArgs = argsForForward ? `${argsForForward}, false, annotationText` : "false, annotationText";
    const noWaitMethod = createAsyncMethod(
      noWaitName,
      hasSelectorVariables
        ? [...baseParameters, createInlineParameter("annotationText", { type: "string", initializer: "\"\"" })]
        : [createInlineParameter("annotationText", { type: "string", initializer: "\"\"" })],
      (writer) => {
        writer.writeLine(`await this.${name}(${noWaitArgs});`);
      },
    );

    return [clickMethod, noWaitMethod];
  }

  if (hasSelectorVariables) {
    return [
      createAsyncMethod(
        name,
        [
          ...baseParameters,
          createInlineParameter("wait", { type: "boolean", initializer: "true" }),
          createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
        ],
        (writer) => {
          writer.writeLine(`await this.clickByTestId(${primaryTestIdExpr}, annotationText, wait);`);
        },
      ),
      createAsyncMethod(
        noWaitName,
        [...baseParameters, createInlineParameter("annotationText", { type: "string", initializer: "\"\"" })],
        (writer) => {
          writer.writeLine(`await this.${name}(${argsForForward}, false, annotationText);`);
        },
      ),
    ];
  }

  return [
    createAsyncMethod(
      name,
      [
        createInlineParameter("wait", { type: "boolean", initializer: "true" }),
        createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
      ],
      (writer) => {
        writer.writeLine(`await this.clickByTestId(${primaryTestIdExpr}, annotationText, wait);`);
      },
    ),
    createAsyncMethod(
      noWaitName,
      [createInlineParameter("annotationText", { type: "string", initializer: "\"\"" })],
      (writer) => {
        writer.writeLine(`await this.${name}(false, annotationText);`);
      },
    ),
  ];
}

function generateRadioMethod(
  methodName: string,
  selector: PomStringPattern,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = orderPomPatternParameters(parameters, [selector]);
  const methodParameters = createParameters(selectorParams);
  const testIdExpr = toTypeScriptPomPatternExpression(selector);

  return [
    createAsyncMethod(name, methodParameters, (writer) => {
      writer.writeLine(`await this.clickByTestId(${testIdExpr}, annotationText);`);
    }),
  ];
}

function generateSelectMethod(
  methodName: string,
  selector: PomStringPattern,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = orderPomPatternParameters(parameters, [selector]);
  const selectorExpr = `this.selectorForTestId(${toTypeScriptPomPatternExpression(selector)})`;

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
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = orderPomPatternParameters(parameters, [selector]);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`await this.selectVSelectByTestId(${toTypeScriptPomPatternExpression(selector)}, value, timeOut, annotationText);`);
      },
    ),
  ];
}

function generateTypeMethod(
  methodName: string,
  selector: PomStringPattern,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `type${methodName}`;
  const selectorParams = orderPomPatternParameters(parameters, [selector]);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`await this.fillInputByTestId(${toTypeScriptPomPatternExpression(selector)}, text, annotationText);`);
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
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const roleSuffix = upperFirst(nativeRole || "Element");
  const baseName = upperFirst(methodName);
  const numericSuffix = baseName.startsWith(roleSuffix) ? baseName.slice(roleSuffix.length) : "";
  const hasRoleSuffix = baseName.endsWith(roleSuffix) || (baseName.startsWith(roleSuffix) && isAllDigits(numericSuffix));
  const propertyName = hasRoleSuffix ? `${baseName}` : `${baseName}${roleSuffix}`;
  const selectorParams = orderPomPatternParameters(parameters, [selector]);
  const indexedVariable = getIndexedPomPatternVariable(selector);

  if (indexedVariable) {
    const keyType = getPomParameter(selectorParams, indexedVariable)?.typeExpression || "string";
    const keyedPropertyName = getterNameOverride ?? removeByKeySegment(propertyName);
    return [
      createClassGetter({
        name: keyedPropertyName,
        statements: [
          `return this.keyedLocators((${indexedVariable}: ${keyType}) => this.locatorByTestId(${toTypeScriptPomPatternExpression(selector)}));`,
        ],
      }),
    ];
  }

  const finalPropertyName = getterNameOverride ?? propertyName;
  const alternates = uniquePomStringPatterns(selector, alternateSelectors).slice(1);
  if (alternates.length > 0) {
    const all = [selector, ...alternates];
    const locatorExpr = all
      .map(id => `this.locatorByTestId(${toTypeScriptPomPatternExpression(id)})`)
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
      statements: [`return this.locatorByTestId(${toTypeScriptPomPatternExpression(selector)});`],
    }),
  ];
}

function generateNavigationMethod(args: {
  targetPageObjectModelClass: string;
  baseMethodName: string;
  selector: PomStringPattern;
  alternateSelectors?: PomStringPattern[];
  parameters: PomParameterSpec[];
}): TypeScriptClassMember[] {
  const { targetPageObjectModelClass: target, baseMethodName, selector, alternateSelectors, parameters } = args;

  const methodName = baseMethodName
    ? `goTo${upperFirst(baseMethodName)}`
    : `goTo${target.endsWith("Page") ? target.slice(0, -"Page".length) : target}`;

  const selectorParams = orderPomPatternParameters(parameters, [selector]);
  const methodParameters = createParameters(selectorParams);
  const alternates = uniquePomStringPatterns(selector, alternateSelectors).slice(1);
  const candidatesExpr = [toTypeScriptPomPatternExpression(selector), ...alternates.map(id => toTypeScriptPomPatternExpression(id))].join(", ");

  if (alternates.length > 0) {
    return [
        createClassMethod({
          name: methodName,
          parameters: methodParameters,
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
      parameters: methodParameters,
      returnType: `Fluent<${target}>`,
      statements: (writer) => {
        writer.write("return this.fluent(async () => ").block(() => {
          writer.writeLine(`await this.clickByTestId(${toTypeScriptPomPatternExpression(selector)});`);
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
  parameters: PomParameterSpec[],
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
    parameters,
  );

  if (targetPageObjectModelClass) {
    return [
      ...members,
      ...generateNavigationMethod({
        targetPageObjectModelClass,
        baseMethodName,
        selector,
        alternateSelectors,
        parameters,
      }),
    ];
  }

  if (nativeRole === "select") {
    return [...members, ...generateSelectMethod(baseMethodName, selector, parameters)];
  }
  if (nativeRole === "vselect") {
    return [...members, ...generateVSelectMethod(baseMethodName, selector, parameters)];
  }
  if (nativeRole === "input") {
    return [...members, ...generateTypeMethod(baseMethodName, selector, parameters)];
  }
  if (nativeRole === "radio") {
    return [...members, ...generateRadioMethod(baseMethodName || "Radio", selector, parameters)];
  }

  return [...members, ...generateClickMethod(baseMethodName, selector, alternateSelectors, parameters)];
}

export function generateViewObjectModelMethodContent(
  targetPageObjectModelClass: string | undefined,
  methodName: string,
  nativeRole: string,
  selector: PomStringPattern,
  alternateSelectors: PomStringPattern[] | undefined,
  getterNameOverride: string | undefined,
  parameters: PomParameterSpec[],
) {
  return renderClassMembers(
    generateViewObjectModelMembers(
      targetPageObjectModelClass,
      methodName,
      nativeRole,
      selector,
      alternateSelectors,
      getterNameOverride,
      parameters,
    ),
  );
}
