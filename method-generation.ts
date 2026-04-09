// Method content generation helpers.
//
// These are shared between transform-time codegen (building dependencies.methodsContent)
// and class-generation tests. This module is intentionally dependency-free with respect to
// generator internals to avoid circular imports between `utils` and `class-generation`.

import { renderTypeScript, type TypeScriptWriter } from "./typescript-codegen";

function upperFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hasParam(params: Record<string, string>, name: string) {
  return Object.prototype.hasOwnProperty.call(params, name);
}

function formatParams(params: Record<string, string>) {
  const entries = Object.entries(params);
  if (!entries.length) {
    return "";
  }
  return entries.map(([n, t]) => `${n}: ${t}`).join(", ");
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

function renderClassMembers(write: (writer: TypeScriptWriter) => void): string {
  const content = renderTypeScript((writer) => {
    writer.indent(() => {
      write(writer);
    });
  });
  return content.endsWith("\n") ? content : `${content}\n`;
}

function writeMemberBlock(writer: TypeScriptWriter, signature: string, body: (writer: TypeScriptWriter) => void): void {
  writer.write(`${signature} `).block(() => {
    body(writer);
  });
}

function generateClickMethod(methodName: string, formattedDataTestId: string, alternateFormattedDataTestIds: string[] | undefined, params: Record<string, string>) {
  const name = `click${methodName}`;
  const noWaitName = `${name}NoWait`;
  const paramBlock = formatParams(params);
  const paramBlockWithWait = paramBlock ? `${paramBlock}, wait: boolean = true` : "wait: boolean = true";
  const argsForForward = Object.keys(params).join(", ");
  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);

  return renderClassMembers((writer) => {
    if (alternates.length > 0) {
      const candidatesExpr = [formattedDataTestId, ...alternates].map(testIdExpression).join(", ");
      const waitSignature = hasParam(params, "key") ? paramBlockWithWait : "wait: boolean = true";
      const waitArg = "wait";

      writeMemberBlock(writer, `async ${name}(${waitSignature})`, (writer) => {
        writer.writeLine(`const candidates = [${candidatesExpr}] as const;`);
        writer.writeLine("let lastError: unknown;");
        writer.writeLine("for (const testId of candidates) {");
        writer.indent(() => {
          writer.writeLine("const locator = this.locatorByTestId(testId);");
          writer.writeLine("try {");
          writer.indent(() => {
            writer.writeLine("if (await locator.count()) {");
            writer.indent(() => {
              writer.writeLine(`await this.clickLocator(locator, "", ${waitArg});`);
              writer.writeLine("return;");
            });
            writer.writeLine("}");
          });
          writer.writeLine("} catch (e) {");
          writer.indent(() => {
            writer.writeLine("lastError = e;");
          });
          writer.writeLine("}");
        });
        writer.writeLine("}");
        writer.writeLine(`throw (lastError instanceof Error) ? lastError : new Error("[pom] Failed to click any candidate locator for ${name}.");`);
      });

      writer.blankLine();

      const noWaitSignature = hasParam(params, "key") ? `async ${noWaitName}(${paramBlock})` : `async ${noWaitName}()`;
      const noWaitArgs = argsForForward ? `${argsForForward}, false` : "false";
      writeMemberBlock(writer, noWaitSignature, (writer) => {
        writer.writeLine(`await this.${name}(${noWaitArgs});`);
      });
      return;
    }

    if (hasParam(params, "key")) {
      writeMemberBlock(writer, `async ${name}(${paramBlockWithWait})`, (writer) => {
        writer.writeLine(`await this.clickByTestId(\`${formattedDataTestId}\`, "", wait);`);
      });

      writer.blankLine();

      writeMemberBlock(writer, `async ${noWaitName}(${paramBlock})`, (writer) => {
        writer.writeLine(`await this.${name}(${argsForForward}, false);`);
      });
      return;
    }

    writeMemberBlock(writer, `async ${name}(wait: boolean = true)`, (writer) => {
      writer.writeLine(`await this.clickByTestId("${formattedDataTestId}", "", wait);`);
    });

    writer.blankLine();

    writeMemberBlock(writer, `async ${noWaitName}()`, (writer) => {
      writer.writeLine(`await this.${name}(false);`);
    });
  });
}

function generateRadioMethod(methodName: string, formattedDataTestId: string) {
  const name = `select${methodName}`;
  const hasKey = formattedDataTestId.includes("${key}");

  return renderClassMembers((writer) => {
    const signature = hasKey
      ? `async ${name}(key: string, annotationText: string = "")`
      : `async ${name}(annotationText: string = "")`;
    const testIdExpr = hasKey ? `\`${formattedDataTestId}\`` : `"${formattedDataTestId}"`;
    writeMemberBlock(writer, signature, (writer) => {
      writer.writeLine(`await this.clickByTestId(${testIdExpr}, annotationText);`);
    });
  });
}

function generateSelectMethod(methodName: string, formattedDataTestId: string) {
  const name = `select${methodName}`;
  const needsKey = formattedDataTestId.includes("${key}");
  const selectorExpr = needsKey
    ? `this.selectorForTestId(\`${formattedDataTestId}\`)`
    : `this.selectorForTestId("${formattedDataTestId}")`;

  return renderClassMembers((writer) => {
    writeMemberBlock(writer, `async ${name}(value: string, annotationText: string = "")`, (writer) => {
      writer.writeLine(`const selector = ${selectorExpr};`);
      writer.writeLine("await this.animateCursorToElement(selector, false, 500, annotationText);");
      writer.writeLine("await this.page.selectOption(selector, value);");
    });
  });
}

function generateVSelectMethod(methodName: string, formattedDataTestId: string) {
  const name = `select${methodName}`;
  return renderClassMembers((writer) => {
    writeMemberBlock(writer, `async ${name}(value: string, timeOut = 500, annotationText: string = "")`, (writer) => {
      writer.writeLine(`await this.selectVSelectByTestId("${formattedDataTestId}", value, timeOut, annotationText);`);
    });
  });
}

function generateTypeMethod(methodName: string, formattedDataTestId: string) {
  const name = `type${methodName}`;
  return renderClassMembers((writer) => {
    writeMemberBlock(writer, `async ${name}(text: string, annotationText: string = "")`, (writer) => {
      writer.writeLine(`await this.fillInputByTestId("${formattedDataTestId}", text, annotationText);`);
    });
  });
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
) {
  // Avoid duplicate accessors when the same base name exists for different roles.
  // Example: "PackageHash" can exist as both "-input" and "-button".
  const roleSuffix = upperFirst(nativeRole || "Element");
  const baseName = upperFirst(methodName);
  const numericSuffix = baseName.startsWith(roleSuffix) ? baseName.slice(roleSuffix.length) : "";
  const hasRoleSuffix = baseName.endsWith(roleSuffix) || (baseName.startsWith(roleSuffix) && isAllDigits(numericSuffix));
  const propertyName = hasRoleSuffix ? `${baseName}` : `${baseName}${roleSuffix}`;
  const needsKey = hasParam(params, "key") || formattedDataTestId.includes("${key}");

  return renderClassMembers((writer) => {
    if (needsKey) {
      const keyType = params.key || "string";
      // For keyed getters, expose an indexable property (Proxy) so callers can do:
      //   expect(pom.SaveButton[myKey]).toBeVisible();
      // When method names include the "ByKey" segment, we remove it in the exposed property
      // name so `FooByKeyButton` becomes `FooButton[key]`.
      const keyedPropertyName = getterNameOverride ?? removeByKeySegment(propertyName);
      writeMemberBlock(writer, `get ${keyedPropertyName}()`, (writer) => {
        writer.writeLine(`return this.keyedLocators((key: ${keyType}) => this.locatorByTestId(\`${formattedDataTestId}\`));`);
      });
      return;
    }

    const finalPropertyName = getterNameOverride ?? propertyName;
    const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);
    if (alternates.length > 0) {
      const all = [formattedDataTestId, ...alternates];
      const locatorExpr = all
        .map((id) => `this.locatorByTestId(${testIdExpression(id)})`)
        .reduce((acc, next) => `${acc}.or(${next})`);

      writeMemberBlock(writer, `get ${finalPropertyName}()`, (writer) => {
        writer.writeLine(`return ${locatorExpr};`);
      });
      return;
    }

    writeMemberBlock(writer, `get ${finalPropertyName}()`, (writer) => {
      writer.writeLine(`return this.locatorByTestId("${formattedDataTestId}");`);
    });
  });
}

function generateNavigationMethod(args: {
  targetPageObjectModelClass: string;
  /** Method name derived from data-testid parts (already PascalCase). */
  baseMethodName: string;
  /** data-testid string (may include `${key}` placeholder). */
  formattedDataTestId: string;
  /** Alternative data-testid strings that represent the same navigation action. */
  alternateFormattedDataTestIds?: string[];
  /** Method param name->type dictionary (e.g. { key: "string" }). */
  params: Record<string, string>;
}) {
  const { targetPageObjectModelClass: target, baseMethodName, formattedDataTestId, alternateFormattedDataTestIds, params } = args;

  // IMPORTANT:
  // Navigation method names must be derived from the element's semantic name (data-testid parts)
  // rather than only from the target page class. Multiple elements often navigate to the same
  // target (e.g. NewBranding + EditBranding -> BrandingDetailsPage). If we name methods by
  // target only, we emit duplicate implementations and vue-tsc fails.
  const methodName = baseMethodName
    ? `goTo${upperFirst(baseMethodName)}`
    : `goTo${target.endsWith("Page") ? target.slice(0, -"Page".length) : target}`;

  const signature = `public ${methodName}(${formatParams(params)}): Fluent<${target}>`;
  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);
  const candidatesExpr = [formattedDataTestId, ...alternates].map(testIdExpression).join(", ");

  return renderClassMembers((writer) => {
    if (alternates.length > 0) {
      writeMemberBlock(writer, signature, (writer) => {
        writer.writeLine("return this.fluent(async () => {");
        writer.indent(() => {
          writer.writeLine(`const candidates = [${candidatesExpr}] as const;`);
          writer.writeLine("let lastError: unknown;");
          writer.writeLine("for (const testId of candidates) {");
          writer.indent(() => {
            writer.writeLine("const locator = this.locatorByTestId(testId);");
            writer.writeLine("try {");
            writer.indent(() => {
              writer.writeLine("if (await locator.count()) {");
              writer.indent(() => {
                writer.writeLine("await this.clickLocator(locator);");
                writer.writeLine(`return new ${target}(this.page);`);
              });
              writer.writeLine("}");
            });
            writer.writeLine("} catch (e) {");
            writer.indent(() => {
              writer.writeLine("lastError = e;");
            });
            writer.writeLine("}");
          });
          writer.writeLine("}");
          writer.writeLine(`throw (lastError instanceof Error) ? lastError : new Error("[pom] Failed to navigate using any candidate locator for ${methodName}.");`);
        });
        writer.writeLine("});");
      });
      return;
    }

    const clickExpr = `\`${formattedDataTestId}\``;
    writeMemberBlock(writer, signature, (writer) => {
      writer.writeLine("return this.fluent(async () => {");
      writer.indent(() => {
        writer.writeLine(`await this.clickByTestId(${clickExpr});`);
        writer.writeLine(`return new ${target}(this.page);`);
      });
      writer.writeLine("});");
    });
  });
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
  const baseMethodName = (nativeRole === "radio")
    ? (methodName || "Radio")
    : methodName;

  const getElementMethod = generateGetElementByDataTestId(baseMethodName, nativeRole, formattedDataTestId, alternateFormattedDataTestIds, getterNameOverride, params);

  if (targetPageObjectModelClass) {
    return getElementMethod + generateNavigationMethod({
      targetPageObjectModelClass,
      baseMethodName,
      formattedDataTestId,
      alternateFormattedDataTestIds,
      params,
    });
  }

  if (nativeRole === "select") {
    return getElementMethod + generateSelectMethod(baseMethodName, formattedDataTestId);
  }
  if (nativeRole === "vselect") {
    return getElementMethod + generateVSelectMethod(baseMethodName, formattedDataTestId);
  }
  if (nativeRole === "input") {
    return getElementMethod + generateTypeMethod(baseMethodName, formattedDataTestId);
  }
  if (nativeRole === "radio") {
    return getElementMethod + generateRadioMethod(baseMethodName || "Radio", formattedDataTestId);
  }

  return getElementMethod + generateClickMethod(baseMethodName, formattedDataTestId, alternateFormattedDataTestIds, params);
}
