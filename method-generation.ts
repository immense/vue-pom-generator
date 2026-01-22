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

function generateClickMethod(methodName: string, formattedDataTestId: string, params: Record<string, string>) {
  let content: string;
  const name = `click${methodName}`;
  const paramBlock = formatParams(params);
  const paramBlockWithWait = paramBlock ? `${paramBlock}, wait: boolean = true` : "wait: boolean = true";

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

function generateGetElementByDataTestId(methodName: string, nativeRole: string, formattedDataTestId: string, params: Record<string, string>) {
  // Avoid duplicate getters when the same base name exists for different roles.
  // Example: "PackageHash" can exist as both "-input" and "-button".
  const roleSuffix = upperFirst(nativeRole || "Element");
  const baseName = upperFirst(methodName);
  const name = baseName.endsWith(roleSuffix)
    ? `get${baseName}`
    : `get${baseName}${roleSuffix}`;
  const needsKey = hasParam(params, "key") || formattedDataTestId.includes("${key}");

  if (needsKey) {
    const keyType = params.key || "string";
    return `${INDENT}${name}(key: ${keyType}) {\n`
      + `${INDENT2}return this.locatorByTestId(\`${formattedDataTestId}\`);\n`
      + `${INDENT}}\n\n`;
  }

  return `${INDENT}${name}() {\n`
    + `${INDENT2}return this.locatorByTestId("${formattedDataTestId}");\n`
    + `${INDENT}}\n\n`;
}

function generateNavigationMethod(args: {
  targetPageObjectModelClass: string;
  /** Method name derived from data-testid parts (already PascalCase). */
  baseMethodName: string;
  /** data-testid string (may include `${key}` placeholder). */
  formattedDataTestId: string;
  /** Method param name->type dictionary (e.g. { key: "string" }). */
  params: Record<string, string>;
}) {
  const { targetPageObjectModelClass: target, baseMethodName, formattedDataTestId, params } = args;

  // IMPORTANT:
  // Navigation method names must be derived from the element's semantic name (data-testid parts)
  // rather than only from the target page class. Multiple elements often navigate to the same
  // target (e.g. NewBranding + EditBranding -> BrandingDetailsPage). If we name methods by
  // target only, we emit duplicate implementations and vue-tsc fails.
  const methodName = baseMethodName
    ? `goTo${upperFirst(baseMethodName)}`
    : `goTo${target.endsWith("Page") ? target.slice(0, -"Page".length) : target}`;

  const signature = `public ${methodName}(${formatParams(params)}): Fluent<${target}>`;
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
  params: Record<string, string>,
) {
  const baseMethodName = (nativeRole === "radio")
    ? (methodName || "Radio")
    : methodName;

  const getElementMethod = generateGetElementByDataTestId(baseMethodName, nativeRole, formattedDataTestId, params);

  if (targetPageObjectModelClass) {
    return getElementMethod + generateNavigationMethod({
      targetPageObjectModelClass,
      baseMethodName,
      formattedDataTestId,
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

  return getElementMethod + generateClickMethod(baseMethodName, formattedDataTestId, params);
}
