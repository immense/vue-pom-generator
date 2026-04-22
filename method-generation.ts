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
import { inferPomPatternKindFromFormattedString, isParameterizedPomPattern, type PomPatternKind } from "./pom-patterns";

function upperFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hasParam(params: Record<string, string>, name: string) {
  return Object.prototype.hasOwnProperty.call(params, name);
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

function uniqueAlternates(primary: string, alternates: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  seen.add(primary);
  for (const a of alternates ?? []) {
    if (!a) {
      continue;
    }
    if (seen.has(a)) {
      continue;
    }
    seen.add(a);
    out.push(a);
  }
  return out;
}

function testIdExpression(formattedDataTestId: string, patternKind?: PomPatternKind): string {
  // Callers without structured metadata (currently alternate selector strings) only use this
  // fallback to decide quote/backtick rendering. API shape comes from selectorPatternKind.
  const needsTemplate = patternKind
    ? isParameterizedPomPattern(patternKind)
    : isParameterizedPomPattern(inferPomPatternKindFromFormattedString(formattedDataTestId));
  return needsTemplate ? `\`${formattedDataTestId}\`` : JSON.stringify(formattedDataTestId);
}

function ensureSelectorParameters(params: Record<string, string>, selectorPatternKind: PomPatternKind): Record<string, string> {
  if (!isParameterizedPomPattern(selectorPatternKind) || hasParam(params, "key")) {
    return params;
  }

  return { key: "string", ...params };
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
  formattedDataTestId: string,
  alternateFormattedDataTestIds: string[] | undefined,
  params: Record<string, string>,
  selectorPatternKind: PomPatternKind,
): TypeScriptClassMember[] {
  const name = `click${methodName}`;
  const noWaitName = `${name}NoWait`;
  const selectorParams = ensureSelectorParameters(params, selectorPatternKind);
  const baseParameters = createParameters(selectorParams);
  const argsForForward = Object.keys(selectorParams).join(", ");
  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);
  const primaryTestIdExpr = testIdExpression(formattedDataTestId, selectorPatternKind);

  if (alternates.length > 0) {
    const candidatesExpr = [primaryTestIdExpr, ...alternates.map(id => testIdExpression(id))].join(", ");
    const clickMethod = createAsyncMethod(
      name,
      hasParam(selectorParams, "key")
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
      hasParam(selectorParams, "key") ? baseParameters : [],
      (writer) => {
        writer.writeLine(`await this.${name}(${noWaitArgs});`);
      },
    );

    return [clickMethod, noWaitMethod];
  }

  if (hasParam(selectorParams, "key")) {
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
  formattedDataTestId: string,
  params: Record<string, string>,
  selectorPatternKind: PomPatternKind,
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = ensureSelectorParameters(params, selectorPatternKind);
  const parameters = createParameters(selectorParams);
  const testIdExpr = testIdExpression(formattedDataTestId, selectorPatternKind);

  return [
    createAsyncMethod(name, parameters, (writer) => {
      writer.writeLine(`await this.clickByTestId(${testIdExpr}, annotationText);`);
    }),
  ];
}

function generateSelectMethod(
  methodName: string,
  formattedDataTestId: string,
  params: Record<string, string>,
  selectorPatternKind: PomPatternKind,
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = ensureSelectorParameters(params, selectorPatternKind);
  const selectorExpr = `this.selectorForTestId(${testIdExpression(formattedDataTestId, selectorPatternKind)})`;

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
  formattedDataTestId: string,
  params: Record<string, string>,
  selectorPatternKind: PomPatternKind,
): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const selectorParams = ensureSelectorParameters(params, selectorPatternKind);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`await this.selectVSelectByTestId(${testIdExpression(formattedDataTestId, selectorPatternKind)}, value, timeOut, annotationText);`);
      },
    ),
  ];
}

function generateTypeMethod(
  methodName: string,
  formattedDataTestId: string,
  params: Record<string, string>,
  selectorPatternKind: PomPatternKind,
): TypeScriptClassMember[] {
  const name = `type${methodName}`;
  const selectorParams = ensureSelectorParameters(params, selectorPatternKind);

  return [
    createAsyncMethod(
      name,
      createParameters(selectorParams),
      (writer) => {
        writer.writeLine(`await this.fillInputByTestId(${testIdExpression(formattedDataTestId, selectorPatternKind)}, text, annotationText);`);
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
  formattedDataTestId: string,
  alternateFormattedDataTestIds: string[] | undefined,
  getterNameOverride: string | undefined,
  params: Record<string, string>,
  selectorPatternKind: PomPatternKind,
): TypeScriptClassMember[] {
  const roleSuffix = upperFirst(nativeRole || "Element");
  const baseName = upperFirst(methodName);
  const numericSuffix = baseName.startsWith(roleSuffix) ? baseName.slice(roleSuffix.length) : "";
  const hasRoleSuffix = baseName.endsWith(roleSuffix) || (baseName.startsWith(roleSuffix) && isAllDigits(numericSuffix));
  const propertyName = hasRoleSuffix ? `${baseName}` : `${baseName}${roleSuffix}`;
  const selectorParams = ensureSelectorParameters(params, selectorPatternKind);
  const needsKey = isParameterizedPomPattern(selectorPatternKind);

  if (needsKey) {
    const keyType = selectorParams.key || "string";
    const keyedPropertyName = getterNameOverride ?? removeByKeySegment(propertyName);
    return [
      createClassGetter({
        name: keyedPropertyName,
        statements: [
          `return this.keyedLocators((key: ${keyType}) => this.locatorByTestId(${testIdExpression(formattedDataTestId, selectorPatternKind)}));`,
        ],
      }),
    ];
  }

  const finalPropertyName = getterNameOverride ?? propertyName;
  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);
  if (alternates.length > 0) {
    const all = [formattedDataTestId, ...alternates];
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
      statements: [`return this.locatorByTestId("${formattedDataTestId}");`],
    }),
  ];
}

function generateNavigationMethod(args: {
  targetPageObjectModelClass: string;
  baseMethodName: string;
  formattedDataTestId: string;
  selectorPatternKind: PomPatternKind;
  alternateFormattedDataTestIds?: string[];
  params: Record<string, string>;
}): TypeScriptClassMember[] {
  const { targetPageObjectModelClass: target, baseMethodName, formattedDataTestId, selectorPatternKind, alternateFormattedDataTestIds, params } = args;

  const methodName = baseMethodName
    ? `goTo${upperFirst(baseMethodName)}`
    : `goTo${target.endsWith("Page") ? target.slice(0, -"Page".length) : target}`;

  const selectorParams = ensureSelectorParameters(params, selectorPatternKind);
  const parameters = createParameters(selectorParams);
  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);
  const candidatesExpr = [testIdExpression(formattedDataTestId, selectorPatternKind), ...alternates.map(id => testIdExpression(id))].join(", ");

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
          writer.writeLine(`await this.clickByTestId(${testIdExpression(formattedDataTestId, selectorPatternKind)});`);
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
  selectorPatternKind: PomPatternKind,
  formattedDataTestId: string,
  alternateFormattedDataTestIds: string[] | undefined,
  getterNameOverride: string | undefined,
  params: Record<string, string>,
): TypeScriptClassMember[] {
  const baseMethodName = (nativeRole === "radio")
    ? (methodName || "Radio")
    : methodName;

  const members = generateGetElementByDataTestId(
    baseMethodName,
    nativeRole,
    formattedDataTestId,
    alternateFormattedDataTestIds,
    getterNameOverride,
    params,
    selectorPatternKind,
  );

  if (targetPageObjectModelClass) {
    return [
      ...members,
      ...generateNavigationMethod({
        targetPageObjectModelClass,
        baseMethodName,
        formattedDataTestId,
        selectorPatternKind,
        alternateFormattedDataTestIds,
        params,
      }),
    ];
  }

  if (nativeRole === "select") {
    return [...members, ...generateSelectMethod(baseMethodName, formattedDataTestId, params, selectorPatternKind)];
  }
  if (nativeRole === "vselect") {
    return [...members, ...generateVSelectMethod(baseMethodName, formattedDataTestId, params, selectorPatternKind)];
  }
  if (nativeRole === "input") {
    return [...members, ...generateTypeMethod(baseMethodName, formattedDataTestId, params, selectorPatternKind)];
  }
  if (nativeRole === "radio") {
    return [...members, ...generateRadioMethod(baseMethodName || "Radio", formattedDataTestId, params, selectorPatternKind)];
  }

  return [...members, ...generateClickMethod(baseMethodName, formattedDataTestId, alternateFormattedDataTestIds, params, selectorPatternKind)];
}

export function generateViewObjectModelMethodContent(
  targetPageObjectModelClass: string | undefined,
  methodName: string,
  nativeRole: string,
  selectorPatternKind: PomPatternKind,
  formattedDataTestId: string,
  alternateFormattedDataTestIds: string[] | undefined,
  getterNameOverride: string | undefined,
  params: Record<string, string>,
) {
  return renderClassMembers(
    generateViewObjectModelMembers(
      targetPageObjectModelClass,
      methodName,
      nativeRole,
      selectorPatternKind,
      formattedDataTestId,
      alternateFormattedDataTestIds,
      getterNameOverride,
      params,
    ),
  );
}
