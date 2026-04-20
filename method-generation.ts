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

function testIdExpression(formattedDataTestId: string): string {
  return formattedDataTestId.includes("${") ? `\`${formattedDataTestId}\`` : JSON.stringify(formattedDataTestId);
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
): TypeScriptClassMember[] {
  const name = `click${methodName}`;
  const noWaitName = `${name}NoWait`;
  const baseParameters = createParameters(params);
  const argsForForward = Object.keys(params).join(", ");
  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);

  if (alternates.length > 0) {
    const candidatesExpr = [formattedDataTestId, ...alternates].map(testIdExpression).join(", ");
    const clickMethod = createAsyncMethod(
      name,
      hasParam(params, "key")
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
      hasParam(params, "key")
        ? [...baseParameters, createInlineParameter("annotationText", { type: "string", initializer: "\"\"" })]
        : [createInlineParameter("annotationText", { type: "string", initializer: "\"\"" })],
      (writer) => {
        writer.writeLine(`await this.${name}(${noWaitArgs});`);
      },
    );

    return [clickMethod, noWaitMethod];
  }

  if (hasParam(params, "key")) {
    return [
      createAsyncMethod(
        name,
        [
          ...baseParameters,
          createInlineParameter("wait", { type: "boolean", initializer: "true" }),
          createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
        ],
        (writer) => {
          writer.writeLine(`await this.clickByTestId(\`${formattedDataTestId}\`, annotationText, wait);`);
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
        writer.writeLine(`await this.clickByTestId("${formattedDataTestId}", annotationText, wait);`);
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

function generateRadioMethod(methodName: string, formattedDataTestId: string): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const hasKey = formattedDataTestId.includes("${key}");
  const parameters = hasKey
    ? [
        createInlineParameter("key", { type: "string" }),
        createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
      ]
    : [createInlineParameter("annotationText", { type: "string", initializer: "\"\"" })];
  const testIdExpr = hasKey ? `\`${formattedDataTestId}\`` : `"${formattedDataTestId}"`;

  return [
    createAsyncMethod(name, parameters, (writer) => {
      writer.writeLine(`await this.clickByTestId(${testIdExpr}, annotationText);`);
    }),
  ];
}

function generateSelectMethod(methodName: string, formattedDataTestId: string): TypeScriptClassMember[] {
  const name = `select${methodName}`;
  const needsKey = formattedDataTestId.includes("${key}");
  const selectorExpr = needsKey
    ? `this.selectorForTestId(\`${formattedDataTestId}\`)`
    : `this.selectorForTestId("${formattedDataTestId}")`;

  return [
    createAsyncMethod(
      name,
      [
        createInlineParameter("value", { type: "string" }),
        createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
      ],
      (writer) => {
        writer.writeLine(`const selector = ${selectorExpr};`);
        writer.writeLine("await this.animateCursorToElement(selector, false, 500, annotationText);");
        writer.writeLine("await this.page.selectOption(selector, value);");
      },
    ),
  ];
}

function generateVSelectMethod(methodName: string, formattedDataTestId: string): TypeScriptClassMember[] {
  const name = `select${methodName}`;

  return [
    createAsyncMethod(
      name,
      [
        createInlineParameter("value", { type: "string" }),
        createInlineParameter("timeOut", { type: "number", initializer: "500" }),
        createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
      ],
      (writer) => {
        writer.writeLine(`await this.selectVSelectByTestId("${formattedDataTestId}", value, timeOut, annotationText);`);
      },
    ),
  ];
}

function generateTypeMethod(methodName: string, formattedDataTestId: string): TypeScriptClassMember[] {
  const name = `type${methodName}`;

  return [
    createAsyncMethod(
      name,
      [
        createInlineParameter("text", { type: "string" }),
        createInlineParameter("annotationText", { type: "string", initializer: "\"\"" }),
      ],
      (writer) => {
        writer.writeLine(`await this.fillInputByTestId("${formattedDataTestId}", text, annotationText);`);
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
): TypeScriptClassMember[] {
  const roleSuffix = upperFirst(nativeRole || "Element");
  const baseName = upperFirst(methodName);
  const numericSuffix = baseName.startsWith(roleSuffix) ? baseName.slice(roleSuffix.length) : "";
  const hasRoleSuffix = baseName.endsWith(roleSuffix) || (baseName.startsWith(roleSuffix) && isAllDigits(numericSuffix));
  const propertyName = hasRoleSuffix ? `${baseName}` : `${baseName}${roleSuffix}`;
  const needsKey = hasParam(params, "key") || formattedDataTestId.includes("${key}");

  if (needsKey) {
    const keyType = params.key || "string";
    const keyedPropertyName = getterNameOverride ?? removeByKeySegment(propertyName);
    return [
      createClassGetter({
        name: keyedPropertyName,
        statements: [
          `return this.keyedLocators((key: ${keyType}) => this.locatorByTestId(\`${formattedDataTestId}\`));`,
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
  alternateFormattedDataTestIds?: string[];
  params: Record<string, string>;
}): TypeScriptClassMember[] {
  const { targetPageObjectModelClass: target, baseMethodName, formattedDataTestId, alternateFormattedDataTestIds, params } = args;

  const methodName = baseMethodName
    ? `goTo${upperFirst(baseMethodName)}`
    : `goTo${target.endsWith("Page") ? target.slice(0, -"Page".length) : target}`;

  const parameters = createParameters(params);
  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);
  const candidatesExpr = [formattedDataTestId, ...alternates].map(testIdExpression).join(", ");

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
          writer.writeLine(`await this.clickByTestId(\`${formattedDataTestId}\`);`);
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
  );

  if (targetPageObjectModelClass) {
    return [
      ...members,
      ...generateNavigationMethod({
        targetPageObjectModelClass,
        baseMethodName,
        formattedDataTestId,
        alternateFormattedDataTestIds,
        params,
      }),
    ];
  }

  if (nativeRole === "select") {
    return [...members, ...generateSelectMethod(baseMethodName, formattedDataTestId)];
  }
  if (nativeRole === "vselect") {
    return [...members, ...generateVSelectMethod(baseMethodName, formattedDataTestId)];
  }
  if (nativeRole === "input") {
    return [...members, ...generateTypeMethod(baseMethodName, formattedDataTestId)];
  }
  if (nativeRole === "radio") {
    return [...members, ...generateRadioMethod(baseMethodName || "Radio", formattedDataTestId)];
  }

  return [...members, ...generateClickMethod(baseMethodName, formattedDataTestId, alternateFormattedDataTestIds, params)];
}

export function generateViewObjectModelMethodContent(
  targetPageObjectModelClass: string | undefined,
  methodName: string,
  nativeRole: string,
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
      formattedDataTestId,
      alternateFormattedDataTestIds,
      getterNameOverride,
      params,
    ),
  );
}
