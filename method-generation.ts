// Method content generation helpers.
//
// These are shared between transform-time codegen (building dependencies.methodsContent)
// and class-generation tests. This module is intentionally dependency-free to avoid
// circular imports between `utils` and `class-generation`.

const INDENT = "    ";
const INDENT2 = `${INDENT}${INDENT}`;
const INDENT3 = `${INDENT2}${INDENT}`;

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

function generateClickMethod(methodName: string, formattedDataTestId: string, alternateFormattedDataTestIds: string[] | undefined, params: Record<string, string>) {
  let content: string;
  const name = `click${methodName}`;
  const paramBlock = formatParams(params);
  const paramBlockWithWait = paramBlock ? `${paramBlock}, wait: boolean = true` : "wait: boolean = true";

  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);
  if (alternates.length > 0) {
    const candidatesExpr = [formattedDataTestId, ...alternates].map(testIdExpression).join(", ");
    const waitSignature = hasParam(params, "key") ? paramBlockWithWait : "wait: boolean = true";
    const waitArg = "wait";

    content = `${INDENT}async ${name}(${waitSignature}) {\n`
      + `${INDENT2}const candidates = [${candidatesExpr}] as const;\n`
      + `${INDENT2}let lastError: unknown;\n`
      + `${INDENT2}for (const testId of candidates) {\n`
      + `${INDENT3}const locator = this.locatorByTestId(testId);\n`
      + `${INDENT3}try {\n`
      + `${INDENT3}${INDENT}if (await locator.count()) {\n`
      + `${INDENT3}${INDENT2}await this.clickLocator(locator, "", ${waitArg});\n`
      + `${INDENT3}${INDENT2}return;\n`
      + `${INDENT3}${INDENT}}\n`
      + `${INDENT3}} catch (e) {\n`
      + `${INDENT3}${INDENT}lastError = e;\n`
      + `${INDENT3}}\n`
      + `${INDENT2}}\n`
      + `${INDENT2}throw (lastError instanceof Error) ? lastError : new Error("[pom] Failed to click any candidate locator for ${name}.");\n`
      + `${INDENT}}\n`;
    return content;
  }

  if (hasParam(params, "key")) {
    content = `${INDENT}async ${name}(${paramBlockWithWait}) {\n`
      + `${INDENT2}await this.clickByTestId(\`${formattedDataTestId}\`, "", wait);\n`
      + `${INDENT}}\n`;
  }
  else {
    content = `${INDENT}async ${name}(wait: boolean = true) {\n`
      + `${INDENT2}await this.clickByTestId("${formattedDataTestId}", "", wait);\n`
      + `${INDENT}}\n`;
  }
  return content;
}

function generateRadioMethod(methodName: string, formattedDataTestId: string) {
  const name = `select${methodName}`;
  const hasKey = formattedDataTestId.includes("${key}");
  if (hasKey) {
    return `${INDENT}async ${name}(key: string, annotationText: string = "") {\n`
      + `${INDENT2}await this.clickByTestId(\`${formattedDataTestId}\`, annotationText);\n`
      + `${INDENT}}\n`;
  }
  return `${INDENT}async ${name}(annotationText: string = "") {\n`
    + `${INDENT2}await this.clickByTestId("${formattedDataTestId}", annotationText);\n`
    + `${INDENT}}\n`;
}

function generateSelectMethod(methodName: string, formattedDataTestId: string) {
  const name = `select${methodName}`;
  const needsKey = formattedDataTestId.includes("${key}");
  const selectorExpr = needsKey
    ? `this.selectorForTestId(\`${formattedDataTestId}\`)`
    : `this.selectorForTestId("${formattedDataTestId}")`;

  const content: string = `${INDENT}async ${name}(value: string, annotationText: string = "") {\n`
    + `${INDENT2}const selector = ${selectorExpr};\n`
    + `${INDENT2}await this.animateCursorToElement(selector, false, 500, annotationText);\n`
    + `${INDENT2}await this.page.selectOption(selector, value);\n`
    + `${INDENT}}\n\n`;
  return content;
}

function generateVSelectMethod(methodName: string, formattedDataTestId: string) {
  const name = `select${methodName}`;
  const content = [
    `${INDENT}async ${name}(value: string, timeOut = 500, annotationText: string = "") {\n`,
    `${INDENT2}await this.selectVSelectByTestId("${formattedDataTestId}", value, timeOut, annotationText);\n`,
    `${INDENT}}\n`,
  ].join("");
  return content;
}

function generateTypeMethod(methodName: string, formattedDataTestId: string) {
  const name = `type${methodName}`;
  const content: string = `${INDENT}async ${name}(text: string, annotationText: string = "") {\n`
    + `${INDENT2}await this.fillInputByTestId("${formattedDataTestId}", text, annotationText);\n`
    + `${INDENT}}\n`;
  return content;
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
  const hasRoleSuffix = baseName.endsWith(roleSuffix) || new RegExp(`^${roleSuffix}\\d+$`).test(baseName);
  const propertyName = hasRoleSuffix ? `${baseName}` : `${baseName}${roleSuffix}`;
  const needsKey = hasParam(params, "key") || formattedDataTestId.includes("${key}");

  if (needsKey) {
    const keyType = params.key || "string";
    // For keyed getters, expose an indexable property (Proxy) so callers can do:
    //   expect(pom.SaveButton[myKey]).toBeVisible();
    // When method names include the "ByKey" segment, we remove it in the exposed property
    // name so `FooByKeyButton` becomes `FooButton[key]`.
    const keyedPropertyName = getterNameOverride ?? removeByKeySegment(propertyName);
    return `${INDENT}get ${keyedPropertyName}() {\n`
      + `${INDENT2}return this.keyedLocators((key: ${keyType}) => this.locatorByTestId(\`${formattedDataTestId}\`));\n`
      + `${INDENT}}\n\n`;
  }

  const finalPropertyName = getterNameOverride ?? propertyName;

  const alternates = uniqueAlternates(formattedDataTestId, alternateFormattedDataTestIds);
  if (alternates.length > 0) {
    const all = [formattedDataTestId, ...alternates];
    const locatorExpr = all
      .map((id) => `this.locatorByTestId(${testIdExpression(id)})`)
      .reduce((acc, next) => `${acc}.or(${next})`);

    return `${INDENT}get ${finalPropertyName}() {\n`
      + `${INDENT2}return ${locatorExpr};\n`
      + `${INDENT}}\n\n`;
  }

  return `${INDENT}get ${finalPropertyName}() {\n`
    + `${INDENT2}return this.locatorByTestId("${formattedDataTestId}");\n`
    + `${INDENT}}\n\n`;
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

  if (alternates.length > 0) {
    return `${INDENT}${signature} {\n`
      + `${INDENT2}return this.fluent(async () => {\n`
      + `${INDENT3}const candidates = [${candidatesExpr}] as const;\n`
      + `${INDENT3}let lastError: unknown;\n`
      + `${INDENT3}for (const testId of candidates) {\n`
      + `${INDENT3}${INDENT}const locator = this.locatorByTestId(testId);\n`
      + `${INDENT3}${INDENT}try {\n`
      + `${INDENT3}${INDENT2}if (await locator.count()) {\n`
      + `${INDENT3}${INDENT3}await this.clickLocator(locator);\n`
      + `${INDENT3}${INDENT3}return new ${target}(this.page);\n`
      + `${INDENT3}${INDENT2}}\n`
      + `${INDENT3}${INDENT}} catch (e) {\n`
      + `${INDENT3}${INDENT2}lastError = e;\n`
      + `${INDENT3}${INDENT}}\n`
      + `${INDENT3}}\n`
      + `${INDENT3}throw (lastError instanceof Error) ? lastError : new Error("[pom] Failed to navigate using any candidate locator for ${methodName}.");\n`
      + `${INDENT2}});\n`
      + `${INDENT}}\n`;
  }

  const clickExpr = `\`${formattedDataTestId}\``;
  return `${INDENT}${signature} {\n`
    + `${INDENT2}return this.fluent(async () => {\n`
    + `${INDENT3}await this.clickByTestId(${clickExpr});\n`
    + `${INDENT3}return new ${target}(this.page);\n`
    + `${INDENT2}});\n`
    + `${INDENT}}\n`;
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
