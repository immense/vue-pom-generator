export type WebMcpSelectorPatternKind = "static" | "parameterized";
export type WebMcpRuntimeParamRole = "input" | "select" | "vselect" | "checkbox" | "radio";

export interface WebMcpManifestParameter {
  name: string;
  role: WebMcpRuntimeParamRole | string;
  testId: string;
  selectorPatternKind: WebMcpSelectorPatternKind;
  selectorTemplateVariables: string[];
  toolParamDescription: string;
  generatedPropertyName: string | null;
}

export interface WebMcpManifestAction {
  name: string;
  testId: string;
  description: string;
  selectorPatternKind: WebMcpSelectorPatternKind;
  selectorTemplateVariables: string[];
  targetPageObjectModelClass?: string;
}

export interface WebMcpManifestTool {
  toolName: string;
  toolDescription: string;
  toolAutoSubmit: boolean;
  params: WebMcpManifestParameter[];
  actions: WebMcpManifestAction[];
}

export interface WebMcpManifestComponent {
  componentName: string;
  className: string;
  sourceFile: string;
  kind: "component" | "view";
  tools: WebMcpManifestTool[];
}

export type WebMcpManifest = Record<string, WebMcpManifestComponent>;

export interface WebMcpJsonSchemaProperty {
  type: "string" | "boolean";
  description?: string;
  enum?: string[];
}

export interface WebMcpJsonSchemaObject {
  type: "object";
  properties: Record<string, WebMcpJsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

export interface WebMcpToolResponse {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

export interface WebMcpModelContextLike {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema?: WebMcpJsonSchemaObject;
    execute(args: Record<string, unknown>): Promise<WebMcpToolResponse> | WebMcpToolResponse;
  }): unknown;
  unregisterTool(name: string): void;
}

export interface RegisterWebMcpManifestToolsOptions {
  manifest: WebMcpManifest;
  modelContext?: WebMcpModelContextLike;
  root?: Document | DocumentFragment | Element;
  testIdAttribute?: string;
  actionParameterName?: string;
}

export interface RegisteredWebMcpToolsHandle {
  toolNames: string[];
  unregister(): void;
}

const DEFAULT_TEST_ID_ATTRIBUTE = "data-testid";
const DEFAULT_ACTION_PARAMETER_NAME = "submitAction";
const SELECTOR_VARIABLE_DESCRIPTION = "Variable used to resolve parameterized generated selectors.";

function isElementNode(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function isHtmlElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
}

function isHtmlInputElement(value: unknown): value is HTMLInputElement {
  return typeof HTMLInputElement !== "undefined" && value instanceof HTMLInputElement;
}

function isHtmlTextAreaElement(value: unknown): value is HTMLTextAreaElement {
  return typeof HTMLTextAreaElement !== "undefined" && value instanceof HTMLTextAreaElement;
}

function isHtmlSelectElement(value: unknown): value is HTMLSelectElement {
  return typeof HTMLSelectElement !== "undefined" && value instanceof HTMLSelectElement;
}

function getNormalizedTestIdAttribute(value: string | undefined): string {
  return (value ?? DEFAULT_TEST_ID_ATTRIBUTE).trim() || DEFAULT_TEST_ID_ATTRIBUTE;
}

function getRootDocument(root?: Document | DocumentFragment | Element): Document {
  if (root && "ownerDocument" in root && root.ownerDocument) {
    return root.ownerDocument;
  }

  if (typeof document !== "undefined") {
    return document;
  }

  throw new Error("[vue-pom-generator] WebMCP runtime bridge requires a browser document.");
}

function getSearchRoot(root?: Document | DocumentFragment | Element): Document | DocumentFragment | Element {
  return root ?? getRootDocument();
}

function getMatchingElements(
  root: Document | DocumentFragment | Element,
  attributeName: string,
  testId: string,
): Element[] {
  const matches: Element[] = [];

  if (isElementNode(root) && root.getAttribute(attributeName) === testId) {
    matches.push(root);
  }

  for (const candidate of Array.from(root.querySelectorAll("*"))) {
    if (candidate.getAttribute(attributeName) === testId) {
      matches.push(candidate);
    }
  }

  return matches;
}

function getUniqueElementByTestId(args: {
  root: Document | DocumentFragment | Element;
  testIdAttribute: string;
  testId: string;
  toolName: string;
}): Element {
  const matches = getMatchingElements(args.root, args.testIdAttribute, args.testId);
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0) {
    throw new Error(
      `[vue-pom-generator] WebMCP tool ${JSON.stringify(args.toolName)} could not find `
      + `an element with ${JSON.stringify(args.testIdAttribute)}=${JSON.stringify(args.testId)}.`
    );
  }

  throw new Error(
    `[vue-pom-generator] WebMCP tool ${JSON.stringify(args.toolName)} found ${matches.length} matching elements `
    + `for ${JSON.stringify(args.testIdAttribute)}=${JSON.stringify(args.testId)}. `
    + "Scope the bridge with a narrower root before registering tools."
  );
}

function findFirstDescendant(element: Element, selector: string): Element | null {
  return typeof element.querySelector === "function" ? element.querySelector(selector) : null;
}

function resolveTextEntryControl(element: Element): Element | null {
  if (isHtmlInputElement(element) && element.type !== "checkbox" && element.type !== "radio") {
    return element;
  }

  if (isHtmlTextAreaElement(element)) {
    return element;
  }

  if (isHtmlElement(element) && element.isContentEditable) {
    return element;
  }

  return findFirstDescendant(
    element,
    "input:not([type='checkbox']):not([type='radio']), textarea, [contenteditable='true']",
  );
}

function resolveNativeSelectControl(element: Element): HTMLSelectElement | null {
  if (isHtmlSelectElement(element)) {
    return element;
  }

  const descendant = findFirstDescendant(element, "select");
  return isHtmlSelectElement(descendant) ? descendant : null;
}

function resolveCheckableControl(element: Element, type: "checkbox" | "radio"): HTMLInputElement | null {
  if (isHtmlInputElement(element) && element.type === type) {
    return element;
  }

  const descendant = findFirstDescendant(element, `input[type='${type}']`);
  return isHtmlInputElement(descendant) ? descendant : null;
}

function resolveClickableElement(element: Element): HTMLElement | null {
  if (isHtmlElement(element) && typeof element.click === "function") {
    return element;
  }

  const descendant = findFirstDescendant(
    element,
    "button, [role='button'], [role='combobox'], a, input[type='button'], input[type='submit'], input[type='reset']",
  );
  return isHtmlElement(descendant) ? descendant : null;
}

function dispatchBubbledEvent(target: EventTarget, type: string): void {
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

function setTextControlValue(element: Element, value: unknown, toolName: string, paramName: string): void {
  const target = resolveTextEntryControl(element);
  if (!target) {
    throw new Error(
      `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} could not find a text-like control `
      + `for parameter ${JSON.stringify(paramName)}.`
    );
  }

  const nextValue = value === null || value === undefined ? "" : String(value);
  if (isHtmlInputElement(target) || isHtmlTextAreaElement(target)) {
    target.focus();
    target.value = nextValue;
    dispatchBubbledEvent(target, "input");
    dispatchBubbledEvent(target, "change");
    return;
  }

  if (isHtmlElement(target) && target.isContentEditable) {
    target.focus();
    target.textContent = nextValue;
    dispatchBubbledEvent(target, "input");
    dispatchBubbledEvent(target, "change");
    return;
  }

  throw new Error(
    `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} could not write parameter `
    + `${JSON.stringify(paramName)} to the resolved element.`
  );
}

function setNativeSelectValue(select: HTMLSelectElement, value: unknown, toolName: string, paramName: string): void {
  const desired = String(value ?? "");
  const option = Array.from(select.options).find(currentOption => {
    return currentOption.value === desired || currentOption.text.trim() === desired;
  });

  if (!option) {
    throw new Error(
      `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} could not find option `
      + `${JSON.stringify(desired)} for parameter ${JSON.stringify(paramName)}.`
    );
  }

  select.focus();
  select.value = option.value;
  option.selected = true;
  dispatchBubbledEvent(select, "input");
  dispatchBubbledEvent(select, "change");
}

function setCheckboxValue(element: Element, value: unknown, toolName: string, paramName: string): void {
  const desired = Boolean(value);
  const target = resolveCheckableControl(element, "checkbox");
  if (target) {
    if (target.checked !== desired) {
      target.click();
    }
    return;
  }

  const clickable = resolveClickableElement(element);
  if (!clickable) {
    throw new Error(
      `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} could not find a checkbox-like control `
      + `for parameter ${JSON.stringify(paramName)}.`
    );
  }

  const current = clickable.getAttribute("aria-checked");
  if (current === String(desired)) {
    return;
  }
  clickable.click();
}

function setRadioValue(element: Element, value: unknown, toolName: string, paramName: string): void {
  if (!Boolean(value)) {
    return;
  }

  const target = resolveCheckableControl(element, "radio");
  if (target) {
    if (!target.checked) {
      target.click();
    }
    return;
  }

  const clickable = resolveClickableElement(element);
  if (!clickable) {
    throw new Error(
      `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} could not find a radio-like control `
      + `for parameter ${JSON.stringify(paramName)}.`
    );
  }

  clickable.click();
}

function findOptionCandidate(rootDocument: Document, desired: string): HTMLElement | null {
  const options = Array.from(rootDocument.querySelectorAll("[role='option'], option"));
  for (const option of options) {
    if (!isHtmlElement(option)) {
      continue;
    }

    const value = option.getAttribute("value") || option.getAttribute("data-value") || option.textContent?.trim() || "";
    if (value === desired || option.textContent?.trim() === desired) {
      return option;
    }
  }

  return null;
}

async function waitForOptionCandidate(rootDocument: Document, desired: string): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const option = findOptionCandidate(rootDocument, desired);
    if (option) {
      return option;
    }

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return null;
}

async function setVSelectValue(
  element: Element,
  value: unknown,
  rootDocument: Document,
  toolName: string,
  paramName: string,
): Promise<void> {
  const nativeSelect = resolveNativeSelectControl(element);
  if (nativeSelect) {
    setNativeSelectValue(nativeSelect, value, toolName, paramName);
    return;
  }

  const textControl = resolveTextEntryControl(element);
  if (textControl) {
    setTextControlValue(textControl, value, toolName, paramName);
    return;
  }

  // Best-effort wrapper fallback: open a combobox/button trigger, then choose an option by text/value.
  const trigger = resolveClickableElement(element);
  if (!trigger) {
    throw new Error(
      `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} could not find a select-like control `
      + `for parameter ${JSON.stringify(paramName)}.`
    );
  }

  trigger.click();
  const option = await waitForOptionCandidate(rootDocument, String(value ?? ""));
  if (!option) {
    throw new Error(
      `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} could not find an option matching `
      + `${JSON.stringify(String(value ?? ""))} for parameter ${JSON.stringify(paramName)}.`
    );
  }

  option.click();
}

function clickElement(element: Element, toolName: string, actionName: string): void {
  const target = resolveClickableElement(element);
  if (!target) {
    throw new Error(
      `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} could not find a clickable element `
      + `for action ${JSON.stringify(actionName)}.`
    );
  }

  target.click();
}

function resolvePatternTestId(
  pattern: string,
  selectorTemplateVariables: readonly string[],
  args: Record<string, unknown>,
  toolName: string,
  targetLabel: string,
): string {
  if (!selectorTemplateVariables.length) {
    return pattern;
  }

  return pattern.replace(/\$\{(\w+)\}/g, (_match, variableName: string) => {
    const value = args[variableName];
    if (value === undefined || value === null) {
      throw new Error(
        `[vue-pom-generator] WebMCP tool ${JSON.stringify(toolName)} requires argument `
        + `${JSON.stringify(variableName)} to resolve ${targetLabel}.`
      );
    }

    return String(value);
  });
}

function getToolSelectorVariables(tool: WebMcpManifestTool): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    out.push(value);
  };

  for (const param of tool.params) {
    for (const variableName of param.selectorTemplateVariables) {
      add(variableName);
    }
  }

  for (const action of tool.actions) {
    for (const variableName of action.selectorTemplateVariables) {
      add(variableName);
    }
  }

  return out;
}

function getToolDescription(tool: WebMcpManifestTool, actionParameterName: string): string {
  if (!tool.actions.length) {
    return tool.toolDescription;
  }

  if (tool.toolAutoSubmit && tool.actions.length === 1) {
    return `${tool.toolDescription} Calling this tool clicks ${tool.actions[0].name}.`;
  }

  const actionList = tool.actions.map(action => action.name).join(", ");
  return `${tool.toolDescription} Use ${actionParameterName} to choose one of: ${actionList}.`;
}

function getToolInputSchema(tool: WebMcpManifestTool, actionParameterName: string): WebMcpJsonSchemaObject {
  const properties: Record<string, WebMcpJsonSchemaProperty> = {};

  for (const param of tool.params) {
    properties[param.name] = {
      type: param.role === "checkbox" || param.role === "radio" ? "boolean" : "string",
      description: param.toolParamDescription,
    };
  }

  for (const selectorVariable of getToolSelectorVariables(tool)) {
    if (properties[selectorVariable]) {
      continue;
    }

    properties[selectorVariable] = {
      type: "string",
      description: SELECTOR_VARIABLE_DESCRIPTION,
    };
  }

  if (tool.actions.length > 0 && !tool.toolAutoSubmit) {
    properties[actionParameterName] = {
      type: "string",
      description: "Optional generated action to click after applying parameters.",
      enum: tool.actions.map(action => action.name),
    };
  }

  return {
    type: "object",
    properties,
    required: [],
    additionalProperties: false,
  };
}

function resolveModelContext(modelContext?: WebMcpModelContextLike): WebMcpModelContextLike {
  if (modelContext) {
    return modelContext;
  }

  const navigatorValue = (typeof navigator !== "undefined"
    ? (navigator as Navigator & { modelContext?: WebMcpModelContextLike }).modelContext
    : undefined);
  if (navigatorValue) {
    return navigatorValue;
  }

  throw new Error(
    "[vue-pom-generator] WebMCP runtime bridge requires navigator.modelContext. "
    + "Install a WebMCP runtime such as @mcp-b/global, or pass modelContext explicitly."
  );
}

function getAllManifestTools(manifest: WebMcpManifest): Array<{ component: WebMcpManifestComponent; tool: WebMcpManifestTool }> {
  const out: Array<{ component: WebMcpManifestComponent; tool: WebMcpManifestTool }> = [];
  for (const component of Object.values(manifest)) {
    for (const tool of component.tools) {
      out.push({ component, tool });
    }
  }
  return out;
}

function validateManifestToolNames(tools: Array<{ component: WebMcpManifestComponent; tool: WebMcpManifestTool }>): void {
  const toolOwners = new Map<string, string>();
  for (const { component, tool } of tools) {
    const existingOwner = toolOwners.get(tool.toolName);
    if (existingOwner) {
      throw new Error(
        `[vue-pom-generator] WebMCP runtime bridge found duplicate tool name ${JSON.stringify(tool.toolName)} `
        + `for ${existingOwner} and ${component.componentName}.`
      );
    }

    toolOwners.set(tool.toolName, component.componentName);
  }
}

function validateActionParameterName(tool: WebMcpManifestTool, actionParameterName: string): void {
  const paramNames = new Set<string>();
  for (const param of tool.params) {
    if (paramNames.has(param.name)) {
      throw new Error(
        `[vue-pom-generator] WebMCP runtime bridge found duplicate parameter name `
        + `${JSON.stringify(param.name)} for tool ${JSON.stringify(tool.toolName)}.`
      );
    }
    paramNames.add(param.name);
  }

  if (!tool.actions.length || tool.toolAutoSubmit) {
    return;
  }

  const collision = tool.params.some(param => param.name === actionParameterName)
    || getToolSelectorVariables(tool).includes(actionParameterName);
  if (collision) {
    throw new Error(
      `[vue-pom-generator] WebMCP runtime bridge cannot use action parameter name `
      + `${JSON.stringify(actionParameterName)} for tool ${JSON.stringify(tool.toolName)} because it collides with existing tool arguments.`
    );
  }
}

function getSelectedAction(
  tool: WebMcpManifestTool,
  args: Record<string, unknown>,
  actionParameterName: string,
): WebMcpManifestAction | null {
  if (!tool.actions.length) {
    return null;
  }

  const rawAction = args[actionParameterName];
  if (rawAction === undefined || rawAction === null || rawAction === "") {
    if (tool.toolAutoSubmit && tool.actions.length === 1) {
      return tool.actions[0];
    }
    return null;
  }

  if (typeof rawAction !== "string") {
    throw new Error(
      `[vue-pom-generator] WebMCP runtime bridge expected ${JSON.stringify(actionParameterName)} `
      + `to be a string action name for tool ${JSON.stringify(tool.toolName)}.`
    );
  }

  const action = tool.actions.find(candidate => candidate.name === rawAction);
  if (action) {
    return action;
  }

  throw new Error(
    `[vue-pom-generator] WebMCP runtime bridge could not find action ${JSON.stringify(rawAction)} `
    + `for tool ${JSON.stringify(tool.toolName)}. Available actions: ${tool.actions.map(candidate => JSON.stringify(candidate.name)).join(", ")}.`
  );
}

async function applyToolParameter(args: {
  tool: WebMcpManifestTool;
  param: WebMcpManifestParameter;
  toolArgs: Record<string, unknown>;
  value: unknown;
  root: Document | DocumentFragment | Element;
  rootDocument: Document;
  testIdAttribute: string;
}): Promise<void> {
  const resolvedTestId = resolvePatternTestId(
    args.param.testId,
    args.param.selectorTemplateVariables,
    args.toolArgs,
    args.tool.toolName,
    `parameter ${JSON.stringify(args.param.name)}`,
  );

  const element = getUniqueElementByTestId({
    root: args.root,
    testIdAttribute: args.testIdAttribute,
    testId: resolvedTestId,
    toolName: args.tool.toolName,
  });

  switch (args.param.role) {
    case "checkbox":
      setCheckboxValue(element, args.value, args.tool.toolName, args.param.name);
      return;
    case "radio":
      setRadioValue(element, args.value, args.tool.toolName, args.param.name);
      return;
    case "select": {
      const select = resolveNativeSelectControl(element);
      if (!select) {
        throw new Error(
          `[vue-pom-generator] WebMCP tool ${JSON.stringify(args.tool.toolName)} could not find a native select `
          + `for parameter ${JSON.stringify(args.param.name)}.`
        );
      }
      setNativeSelectValue(select, args.value, args.tool.toolName, args.param.name);
      return;
    }
    case "vselect":
      await setVSelectValue(element, args.value, args.rootDocument, args.tool.toolName, args.param.name);
      return;
    case "input":
    default:
      setTextControlValue(element, args.value, args.tool.toolName, args.param.name);
  }
}

export function registerWebMcpManifestTools(options: RegisterWebMcpManifestToolsOptions): RegisteredWebMcpToolsHandle {
  const modelContext = resolveModelContext(options.modelContext);
  const root = getSearchRoot(options.root);
  const rootDocument = getRootDocument(root);
  const testIdAttribute = getNormalizedTestIdAttribute(options.testIdAttribute);
  const actionParameterName = (options.actionParameterName ?? DEFAULT_ACTION_PARAMETER_NAME).trim() || DEFAULT_ACTION_PARAMETER_NAME;
  const allTools = getAllManifestTools(options.manifest);

  validateManifestToolNames(allTools);
  for (const { tool } of allTools) {
    validateActionParameterName(tool, actionParameterName);
  }

  const registeredToolNames: string[] = [];

  try {
    for (const { component, tool } of allTools) {
      modelContext.registerTool({
        name: tool.toolName,
        description: getToolDescription(tool, actionParameterName),
        inputSchema: getToolInputSchema(tool, actionParameterName),
        async execute(toolArgs: Record<string, unknown>) {
          const appliedParameters: string[] = [];
          const selectorVariablesUsed = getToolSelectorVariables(tool).filter((variableName) => {
            return Object.prototype.hasOwnProperty.call(toolArgs, variableName) && toolArgs[variableName] !== undefined;
          });

          for (const param of tool.params) {
            if (!Object.prototype.hasOwnProperty.call(toolArgs, param.name) || toolArgs[param.name] === undefined) {
              continue;
            }

            await applyToolParameter({
              tool,
              param,
              toolArgs,
              value: toolArgs[param.name],
              root,
              rootDocument,
              testIdAttribute,
            });
            appliedParameters.push(param.name);
          }

          const selectedAction = getSelectedAction(tool, toolArgs, actionParameterName);
          if (selectedAction) {
            const resolvedTestId = resolvePatternTestId(
              selectedAction.testId,
              selectedAction.selectorTemplateVariables,
              toolArgs,
              tool.toolName,
              `action ${JSON.stringify(selectedAction.name)}`,
            );
            const actionElement = getUniqueElementByTestId({
              root,
              testIdAttribute,
              testId: resolvedTestId,
              toolName: tool.toolName,
            });
            clickElement(actionElement, tool.toolName, selectedAction.name);
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                component: component.componentName,
                tool: tool.toolName,
                appliedParameters,
                selectorVariablesUsed,
                action: selectedAction?.name ?? null,
                ...(selectedAction?.targetPageObjectModelClass
                  ? { targetPageObjectModelClass: selectedAction.targetPageObjectModelClass }
                  : {}),
              }),
            }],
          };
        },
      });

      registeredToolNames.push(tool.toolName);
    }
  }
  catch (error) {
    for (const toolName of registeredToolNames) {
      modelContext.unregisterTool(toolName);
    }
    throw error;
  }

  let disposed = false;
  return {
    toolNames: [...registeredToolNames],
    unregister() {
      if (disposed) {
        return;
      }

      disposed = true;
      const errors: Error[] = [];
      for (const toolName of [...registeredToolNames].reverse()) {
        try {
          modelContext.unregisterTool(toolName);
        }
        catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }

      if (errors.length > 0) {
        throw errors[0];
      }
    },
  };
}
