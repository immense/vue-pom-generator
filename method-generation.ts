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
import { buildPomLocatorDescription } from "./pom-discoverability";

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
  componentName: string | undefined,
  methodName: string,
  selector: PomStringPattern,
  alternateSelectors: PomStringPattern[] | undefined,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `click${methodName}`;
  const noWaitName = `${name}NoWait`;
  const locatorDescription = JSON.stringify(buildPomLocatorDescription({
    componentName,
    methodName,
    nativeRole: "button",
  }));
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
            writer.writeLine(`const locator = this.locatorByTestId(testId, ${locatorDescription});`);
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
          writer.writeLine(`await this.clickByTestId(${primaryTestIdExpr}, annotationText, wait, ${locatorDescription});`);
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
        writer.writeLine(`await this.clickByTestId(${primaryTestIdExpr}, annotationText, wait, ${locatorDescription});`);
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
  componentName: string | undefined,
  methodName: string,
  selector: PomStringPattern,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const locatorDescription = JSON.stringify(buildPomLocatorDescription({
    componentName,
    methodName,
    nativeRole: "radio",
  }));
  const selectorParams = orderPomPatternParameters(parameters, [selector]);
  const methodParameters = createParameters(selectorParams);
  const testIdExpr = toTypeScriptPomPatternExpression(selector);

  return [
    createAsyncMethod(name, methodParameters, (writer) => {
      writer.writeLine(`await this.clickByTestId(${testIdExpr}, annotationText, true, ${locatorDescription});`);
    }),
  ];
}

function generateSelectMethod(
  componentName: string | undefined,
  methodName: string,
  selector: PomStringPattern,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const locatorDescription = JSON.stringify(buildPomLocatorDescription({
    componentName,
    methodName,
    nativeRole: "select",
  }));
  const selectorParams = orderPomPatternParameters(parameters, [selector]);
  const testIdExpr = toTypeScriptPomPatternExpression(selector);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`const testId = ${testIdExpr};`);
        writer.writeLine(`const locator = this.locatorByTestId(testId, ${locatorDescription});`);
        writer.writeLine("await this.animateCursorToElement(locator, false, 500, annotationText);");
        writer.writeLine("await locator.selectOption(value);");
      },
    ),
  ];
}

function generateVSelectMethod(
  componentName: string | undefined,
  methodName: string,
  selector: PomStringPattern,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const locatorDescription = JSON.stringify(buildPomLocatorDescription({
    componentName,
    methodName,
    nativeRole: "vselect",
  }));
  const selectorParams = orderPomPatternParameters(parameters, [selector]);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`await this.selectVSelectByTestId(${toTypeScriptPomPatternExpression(selector)}, value, timeOut, annotationText, ${locatorDescription});`);
      },
    ),
  ];
}

function generateTypeMethod(
  componentName: string | undefined,
  methodName: string,
  selector: PomStringPattern,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const name = `type${methodName}`;
  const locatorDescription = JSON.stringify(buildPomLocatorDescription({
    componentName,
    methodName,
    nativeRole: "input",
  }));
  const selectorParams = orderPomPatternParameters(parameters, [selector]);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`await this.fillInputByTestId(${toTypeScriptPomPatternExpression(selector)}, text, annotationText, ${locatorDescription});`);
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
  componentName: string | undefined,
  methodName: string,
  nativeRole: string,
  selector: PomStringPattern,
  alternateSelectors: PomStringPattern[] | undefined,
  getterNameOverride: string | undefined,
  parameters: PomParameterSpec[],
): TypeScriptClassMember[] {
  const locatorDescription = JSON.stringify(buildPomLocatorDescription({
    componentName,
    methodName,
    nativeRole,
  }));
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
          `return this.keyedLocators((${indexedVariable}: ${keyType}) => this.locatorByTestId(${toTypeScriptPomPatternExpression(selector)}, ${locatorDescription}));`,
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
        statements: [`return this.describeLocator(${locatorExpr}, ${locatorDescription});`],
      }),
    ];
  }

  return [
    createClassGetter({
      name: finalPropertyName,
      statements: [`return this.locatorByTestId(${toTypeScriptPomPatternExpression(selector)}, ${locatorDescription});`],
    }),
  ];
}

function generateNavigationMethod(args: {
  componentName?: string;
  targetPageObjectModelClass: string;
  baseMethodName: string;
  selector: PomStringPattern;
  alternateSelectors?: PomStringPattern[];
  parameters: PomParameterSpec[];
}): TypeScriptClassMember[] {
  const { componentName, targetPageObjectModelClass: target, baseMethodName, selector, alternateSelectors, parameters } = args;

  const methodName = baseMethodName
    ? `goTo${upperFirst(baseMethodName)}`
    : `goTo${target.endsWith("Page") ? target.slice(0, -"Page".length) : target}`;
  const locatorDescription = JSON.stringify(buildPomLocatorDescription({
    componentName,
    methodName: baseMethodName,
    nativeRole: "button",
  }));

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
              writer.writeLine(`const locator = this.locatorByTestId(testId, ${locatorDescription});`);
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
          writer.writeLine(`const locator = this.locatorByTestId(${toTypeScriptPomPatternExpression(selector)}, ${locatorDescription});`);
          writer.writeLine("await this.clickLocator(locator);");
          writer.writeLine(`return new ${target}(this.page);`);
        });
        writer.writeLine(");");
      },
    }),
  ];
}

export function generateViewObjectModelMembers(
  componentName: string | undefined,
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
    componentName,
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
        componentName,
        targetPageObjectModelClass,
        baseMethodName,
        selector,
        alternateSelectors,
        parameters,
      }),
    ];
  }

  if (nativeRole === "select") {
    return [...members, ...generateSelectMethod(componentName, baseMethodName, selector, parameters)];
  }
  if (nativeRole === "vselect") {
    return [...members, ...generateVSelectMethod(componentName, baseMethodName, selector, parameters)];
  }
  if (nativeRole === "input") {
    return [...members, ...generateTypeMethod(componentName, baseMethodName, selector, parameters)];
  }
  if (nativeRole === "radio") {
    return [...members, ...generateRadioMethod(componentName, baseMethodName || "Radio", selector, parameters)];
  }

  return [...members, ...generateClickMethod(componentName, baseMethodName, selector, alternateSelectors, parameters)];
}

export function generateViewObjectModelMethodContent(
  componentName: string | undefined,
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
      componentName,
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
