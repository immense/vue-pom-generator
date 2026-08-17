import { writeFile } from "node:fs/promises";
import type { TestInfo } from "@playwright/test";
import type { BrowserContext, Page } from "playwright";

export const POM_FAILURE_ATTACHMENT_NAME = "vue-pom-generator.failure";
export const POM_FAILURE_SCREENSHOT_ATTACHMENT_NAME = "vue-pom-generator.screenshot";

const DEFAULT_CAPTURE_BUDGET_MS = 5_000;
const MAX_BUFFERED_EVENTS = 100;
const MAX_TEXT_LENGTH = 2_000;
const MAX_HTTP_FAILURES = 20;
const MAX_HTTP_FAILURE_BODY_LENGTH = 8_000;
const HTTP_FAILURE_BODY_SETTLE_BUDGET_MS = 500;
const POM_ACTIVE_ACTION_REGISTRY = Symbol.for("@immense/vue-pom-generator.active-action-registry");

export interface PomManifestParameter {
  name: string;
  typeExpression?: string;
  type?: string;
  initializer?: string;
  hasQuestionToken?: boolean;
  isRestParameter?: boolean;
}

export interface PomManifestMethod {
  name: string;
  kind: "action" | "locator";
  parameters: readonly PomManifestParameter[];
}

export interface PomManifestEntry {
  testId: string;
  selectorPatternKind: "static" | "parameterized";
  generatedMethods: readonly PomManifestMethod[];
  targetPageObjectModelClass?: string;
}

export interface PomManifestComponent {
  componentName: string;
  className: string;
  sourceFile: string;
  kind: "component" | "view";
  entries: readonly PomManifestEntry[];
}

export type PomManifest = Readonly<Record<string, PomManifestComponent>>;

export interface PomActiveAction {
  componentName?: string;
  methodName: string;
  expectedTestIds: readonly string[];
}

export interface PomRenderedElement {
  testId: string;
  tag: string;
  role: string | null;
  name: string | null;
  visible: boolean;
  enabled: boolean;
}

export interface PomMethodAvailability {
  methodName: string;
  kind: "action" | "locator";
  signature: string;
  expectedTestIds: string[];
  state: "present" | "hidden" | "disabled" | "absent";
}

export interface PomComponentAvailability {
  componentName: string;
  className: string;
  sourceFile: string;
  matchedTestIds: number;
  methods: PomMethodAvailability[];
}

export interface PomPageFailureSnapshot {
  url: string;
  title: string | null;
  closed: boolean;
  ariaSnapshot: string | null;
  ariaSnapshotError?: string;
  renderedElements: PomRenderedElement[];
  component: PomComponentAvailability | null;
  routerNavigation?: PomRouterNavigationSnapshot | null;
  screenshotPath?: string;
  captureErrors: string[];
}

export interface PomRouterNavigationSnapshot {
  id: number;
  status: "pending" | "succeeded" | "failed";
  stage: "waiting-for-router-ready" | "pushing-route" | "complete";
  targetName: string;
  error?: string;
}

export interface PomFailureDiagnostics {
  schemaVersion: 1;
  capturedAt: string;
  captureBudgetMs: number;
  activeAction: PomActiveAction | null;
  pages: PomPageFailureSnapshot[];
  console: string[];
  pageErrors: string[];
  networkFailures: string[];
  httpFailures?: PomHttpFailure[];
  pendingRequests?: string[];
  jsonPath: string;
}

export interface PomHttpFailure {
  status: number;
  method: string;
  url: string;
  contentType: string | null;
  body?: string;
  bodyCaptureError?: string;
}

export type PomDiagnosticsTestInfo = Pick<TestInfo, "attach" | "outputPath">;

export interface PomFailureDiagnosticsOptions {
  captureBudgetMs?: number;
  testIdAttribute?: string;
}

export interface PomFailureDiagnosticsCapture {
  capture: () => Promise<PomFailureDiagnostics>;
}

interface EventBuffers {
  console: string[];
  pageErrors: string[];
  networkFailures: string[];
  httpFailures: PomHttpFailure[];
  httpFailureBodyCaptures: Set<Promise<void>>;
  pendingRequests: Map<object, { method: string; resourceType: string; startedAt: number; url: string }>;
}

function pushBounded(buffer: string[], value: string): void {
  buffer.push(value.slice(0, MAX_TEXT_LENGTH));
  if (buffer.length > MAX_BUFFERED_EVENTS) {
    buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
  }
}

function pushHttpFailureBounded(buffer: PomHttpFailure[], value: PomHttpFailure): void {
  buffer.push(value);
  if (buffer.length > MAX_HTTP_FAILURES) {
    buffer.splice(0, buffer.length - MAX_HTTP_FAILURES);
  }
}

function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n… truncated ${value.length - maximum} characters …`;
}

function formatNetworkUrl(value: string): string {
  if (value.length <= 500) return value;

  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}${parsed.search ? "?…" : ""}`;
  }
  catch {
    return `${value.slice(0, 497)}…`;
  }
}

function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\$\\\{[^}]+\\\}/g, ".+")}$`);
}

function matchesTestId(pattern: string, actual: string): boolean {
  return pattern.includes("${") ? patternToRegExp(pattern).test(actual) : pattern === actual;
}

function formatMethodSignature(method: PomManifestMethod): string {
  const parameters = method.parameters.map((parameter) => {
    const rest = parameter.isRestParameter ? "..." : "";
    const optional = parameter.hasQuestionToken ? "?" : "";
    // Normalized manifest parameters retain the original typeExpression for
    // provenance, but it may also contain the initializer (for example
    // `string = ""`). Prefer the split type to avoid printing it twice.
    const type = parameter.type ?? parameter.typeExpression ?? "unknown";
    const initializer = parameter.initializer === undefined ? "" : ` = ${parameter.initializer}`;
    return `${rest}${parameter.name}${optional}: ${type}${initializer}`;
  });
  return `${method.name}(${parameters.join(", ")})`;
}

function availabilityState(elements: readonly PomRenderedElement[]): PomMethodAvailability["state"] {
  if (!elements.length) return "absent";
  if (!elements.some(element => element.visible)) return "hidden";
  if (!elements.some(element => element.visible && element.enabled)) return "disabled";
  return "present";
}

function buildComponentAvailability(
  manifest: PomManifest,
  renderedElements: readonly PomRenderedElement[],
  activeComponentName?: string,
): PomComponentAvailability | null {
  const renderedTestIds = Array.from(new Set(renderedElements.map(element => element.testId)));
  const candidates = Object.values(manifest).map((component) => ({
    component,
    matchedTestIds: renderedTestIds.filter(actual => component.entries.some(entry => matchesTestId(entry.testId, actual))).length,
  }));
  candidates.sort((a, b) => b.matchedTestIds - a.matchedTestIds
    || Number(b.component.kind === "view") - Number(a.component.kind === "view")
    || a.component.componentName.localeCompare(b.component.componentName));

  const activeCandidate = candidates.find(candidate => candidate.component.componentName === activeComponentName);
  const selected = activeCandidate ?? candidates[0];
  if (!selected || (selected.matchedTestIds === 0 && !activeCandidate)) return null;

  const methods = new Map<string, { method: PomManifestMethod; testIds: Set<string> }>();
  for (const entry of selected.component.entries) {
    for (const method of entry.generatedMethods) {
      const key = `${method.kind}:${method.name}`;
      const current = methods.get(key) ?? { method, testIds: new Set<string>() };
      current.testIds.add(entry.testId);
      methods.set(key, current);
    }
  }

  return {
    componentName: selected.component.componentName,
    className: selected.component.className,
    sourceFile: selected.component.sourceFile,
    matchedTestIds: selected.matchedTestIds,
    methods: Array.from(methods.values())
      .map(({ method, testIds }) => {
        const expectedTestIds = Array.from(testIds).sort((a, b) => a.localeCompare(b));
        const matchingElements = renderedElements.filter(element => expectedTestIds.some(pattern => matchesTestId(pattern, element.testId)));
        return {
          methodName: method.name,
          kind: method.kind,
          signature: formatMethodSignature(method),
          expectedTestIds,
          state: availabilityState(matchingElements),
        } satisfies PomMethodAvailability;
      })
      .sort((a, b) => a.methodName.localeCompare(b.methodName)),
  };
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function withinBudget<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const remaining = remainingMilliseconds(deadline);
  if (remaining <= 0) throw new Error("diagnostic capture budget exhausted");

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("diagnostic capture budget exhausted")), remaining);
      }),
    ]);
  }
  finally {
    if (timer) clearTimeout(timer);
  }
}

function installPageListeners(page: Page, buffers: EventBuffers): void {
  page.on("console", message => pushBounded(buffers.console, `[${message.type()}] ${message.text()}`));
  page.on("pageerror", error => pushBounded(buffers.pageErrors, errorMessage(error)));
  page.on("request", (request) => {
    buffers.pendingRequests.set(request, {
      method: request.method(),
      resourceType: request.resourceType(),
      startedAt: Date.now(),
      url: request.url(),
    });
  });
  page.on("requestfinished", request => buffers.pendingRequests.delete(request));
  page.on("requestfailed", (request) => {
    buffers.pendingRequests.delete(request);
    const failure = request.failure()?.errorText ?? "request failed";
    pushBounded(buffers.networkFailures, `${request.method()} ${formatNetworkUrl(request.url())} — ${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      pushBounded(buffers.networkFailures, `${response.status()} ${response.request().method()} ${formatNetworkUrl(response.url())}`);
      const failure: PomHttpFailure = {
        status: response.status(),
        method: response.request().method(),
        url: formatNetworkUrl(response.url()),
        contentType: response.headers()["content-type"] ?? null,
      };
      pushHttpFailureBounded(buffers.httpFailures, failure);

      const capture: Promise<void> = response.text()
        .then((body) => {
          if (body) failure.body = truncateText(body, MAX_HTTP_FAILURE_BODY_LENGTH);
        })
        .catch((error) => {
          failure.bodyCaptureError = errorMessage(error);
        })
        .finally(() => buffers.httpFailureBodyCaptures.delete(capture));
      buffers.httpFailureBodyCaptures.add(capture);
    }
  });
}

async function settleHttpFailureBodies(buffers: EventBuffers, deadline: number): Promise<void> {
  const captures = Array.from(buffers.httpFailureBodyCaptures);
  if (!captures.length) return;

  const waitMs = Math.min(HTTP_FAILURE_BODY_SETTLE_BUDGET_MS, remainingMilliseconds(deadline));
  if (waitMs <= 0) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(captures),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
  }
  finally {
    if (timer) clearTimeout(timer);
  }
}

async function captureRenderedElements(
  page: Page,
  testIdAttribute: string,
): Promise<{ title: string; elements: PomRenderedElement[]; routerNavigation: PomRouterNavigationSnapshot | null }> {
  return page.evaluate(({ attribute, routerGlobalName }) => {
    const elements = Array.from(document.querySelectorAll(`[${CSS.escape(attribute)}]`));
    const isVisibleElement = (candidate: HTMLElement) => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.opacity || "1") > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const rendered = elements.map((element) => {
      const htmlElement = element as HTMLElement;
      const disabled = ("disabled" in htmlElement && Boolean((htmlElement as HTMLButtonElement).disabled))
        || htmlElement.getAttribute("aria-disabled") === "true";
      const text = htmlElement.textContent?.replace(/\s+/g, " ").trim();
      const inputType = htmlElement instanceof HTMLInputElement ? htmlElement.type.toLowerCase() : "";
      const labels = htmlElement instanceof HTMLInputElement ? Array.from(htmlElement.labels ?? []) : [];
      const labelText = labels.length
        ? labels
          .map(label => label.textContent?.replace(/\s+/g, " ").trim())
          .filter((value): value is string => Boolean(value))
          .join(" ")
        : "";
      const visible = isVisibleElement(htmlElement)
        || ((inputType === "checkbox" || inputType === "radio") && labels.some(label => isVisibleElement(label)));
      const role = htmlElement.getAttribute("role")
        ?? (htmlElement.tagName === "BUTTON" ? "button" : null)
        ?? (htmlElement.tagName === "A" && htmlElement.hasAttribute("href") ? "link" : null)
        ?? (inputType === "checkbox" || inputType === "radio" ? inputType : null)
        ?? (htmlElement.tagName === "TEXTAREA" || (htmlElement.tagName === "INPUT" && inputType !== "hidden") ? "textbox" : null)
        ?? (htmlElement.tagName === "SELECT" ? "combobox" : null);
      const name = htmlElement.getAttribute("aria-label")
        ?? htmlElement.getAttribute("title")
        ?? (labelText || null)
        ?? (text ? text.slice(0, 160) : null);
      return {
        testId: htmlElement.getAttribute(attribute) ?? "",
        tag: htmlElement.tagName.toLowerCase(),
        role,
        name,
        visible,
        enabled: !disabled,
      };
    }).filter(element => element.testId.length > 0);

    const routerBridge = Reflect.get(globalThis, routerGlobalName) as
      | { navigation?: PomRouterNavigationSnapshot }
      | undefined;
    const rawNavigation = routerBridge?.navigation;
    const routerNavigation = rawNavigation
      ? {
          id: rawNavigation.id,
          status: rawNavigation.status,
          stage: rawNavigation.stage,
          targetName: rawNavigation.targetName,
          ...(rawNavigation.error ? { error: rawNavigation.error } : {}),
        }
      : null;

    return { title: document.title, elements: rendered, routerNavigation };
  }, { attribute: testIdAttribute, routerGlobalName: "__vuePomGeneratorRouter" });
}

async function capturePage(
  page: Page,
  pageIndex: number,
  manifest: PomManifest,
  testInfo: PomDiagnosticsTestInfo,
  testIdAttribute: string,
  deadline: number,
  activeAction: PomActiveAction | null,
): Promise<PomPageFailureSnapshot> {
  const captureErrors: string[] = [];
  const snapshot: PomPageFailureSnapshot = {
    url: page.url(),
    title: null,
    closed: page.isClosed(),
    ariaSnapshot: null,
    renderedElements: [],
    component: null,
    routerNavigation: null,
    captureErrors,
  };
  if (snapshot.closed) return snapshot;

  try {
    const rendered = await withinBudget(deadline, () => captureRenderedElements(page, testIdAttribute));
    snapshot.title = rendered.title;
    snapshot.renderedElements = rendered.elements;
    snapshot.component = buildComponentAvailability(manifest, rendered.elements, activeAction?.componentName);
    snapshot.routerNavigation = rendered.routerNavigation;
  }
  catch (error) {
    captureErrors.push(`DOM inventory: ${errorMessage(error)}`);
  }

  try {
    snapshot.ariaSnapshot = await withinBudget(deadline, () => page.locator("body").ariaSnapshot({
      timeout: remainingMilliseconds(deadline),
    }));
  }
  catch (error) {
    snapshot.ariaSnapshotError = errorMessage(error);
  }

  if (pageIndex === 0 && remainingMilliseconds(deadline) > 0) {
    const screenshotPath = testInfo.outputPath("vue-pom-generator-failure.png");
    try {
      await withinBudget(deadline, () => page.screenshot({
        path: screenshotPath,
        fullPage: true,
        timeout: remainingMilliseconds(deadline),
      }));
      await testInfo.attach(POM_FAILURE_SCREENSHOT_ATTACHMENT_NAME, { path: screenshotPath, contentType: "image/png" });
      snapshot.screenshotPath = screenshotPath;
    }
    catch (error) {
      captureErrors.push(`Screenshot: ${errorMessage(error)}`);
    }
  }

  return snapshot;
}

export function recordPomAction(page: object, action: PomActiveAction): void {
  const globalRecord = globalThis as typeof globalThis & {
    [POM_ACTIVE_ACTION_REGISTRY]?: WeakMap<object, PomActiveAction>;
  };
  const registry = globalRecord[POM_ACTIVE_ACTION_REGISTRY] ?? new WeakMap<object, PomActiveAction>();
  globalRecord[POM_ACTIVE_ACTION_REGISTRY] = registry;
  registry.set(page, {
    ...action,
    expectedTestIds: [...action.expectedTestIds],
  });
}

export function getActivePomAction(page: object): PomActiveAction | null {
  const globalRecord = globalThis as typeof globalThis & {
    [POM_ACTIVE_ACTION_REGISTRY]?: WeakMap<object, PomActiveAction>;
  };
  return globalRecord[POM_ACTIVE_ACTION_REGISTRY]?.get(page) ?? null;
}

export function installPomFailureDiagnostics(
  page: Page,
  manifest: PomManifest,
  testInfo: PomDiagnosticsTestInfo,
  options: PomFailureDiagnosticsOptions = {},
): PomFailureDiagnosticsCapture {
  const context: BrowserContext = page.context();
  const pages = new Set<Page>();
  const buffers: EventBuffers = {
    console: [],
    pageErrors: [],
    networkFailures: [],
    httpFailures: [],
    httpFailureBodyCaptures: new Set(),
    pendingRequests: new Map(),
  };
  let captured: Promise<PomFailureDiagnostics> | null = null;

  const registerPage = (candidate: Page) => {
    if (pages.has(candidate)) return;
    pages.add(candidate);
    installPageListeners(candidate, buffers);
  };
  for (const existingPage of context.pages()) registerPage(existingPage);
  context.on("page", registerPage);

  return {
    capture() {
      if (captured) return captured;
      captured = (async () => {
        const captureBudgetMs = options.captureBudgetMs ?? DEFAULT_CAPTURE_BUDGET_MS;
        const deadline = Date.now() + captureBudgetMs;
        await settleHttpFailureBodies(buffers, deadline);
        const activeAction = getActivePomAction(page);
        const pageSnapshots: PomPageFailureSnapshot[] = [];
        for (const [index, candidate] of Array.from(pages).entries()) {
          pageSnapshots.push(await capturePage(
            candidate,
            index,
            manifest,
            testInfo,
            options.testIdAttribute ?? "data-testid",
            deadline,
            activeAction,
          ));
        }

        const jsonPath = testInfo.outputPath("vue-pom-generator-failure.json");
        const diagnostics: PomFailureDiagnostics = {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          captureBudgetMs,
          activeAction,
          pages: pageSnapshots,
          console: [...buffers.console],
          pageErrors: [...buffers.pageErrors],
          networkFailures: [...buffers.networkFailures],
          httpFailures: buffers.httpFailures.map(failure => ({ ...failure })),
          pendingRequests: Array.from(buffers.pendingRequests.values())
            .map(request => `${request.method} ${request.resourceType} ${formatNetworkUrl(request.url)} — pending ${Date.now() - request.startedAt}ms`)
            .slice(-MAX_BUFFERED_EVENTS),
          jsonPath,
        };
        await writeFile(jsonPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
        await testInfo.attach(POM_FAILURE_ATTACHMENT_NAME, { path: jsonPath, contentType: "application/json" });
        return diagnostics;
      })();
      return captured;
    },
  };
}
