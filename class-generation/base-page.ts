import type { Locator, Page } from "playwright";
import type { PwLocator, PwPage } from "./playwright-types";

import { TESTID_CLICK_EVENT_NAME } from "../click-instrumentation";
import type { TestIdClickEventDetail } from "../click-instrumentation";
import { Callout } from "./callout";
import type { CalloutRenderer } from "./callout";
import { Pointer, type AfterPointerClick, type AfterPointerClickInfo, type PointerRenderer } from "./pointer";

const POM_ACTIVE_ACTION_REGISTRY = Symbol.for("@immense/vue-pom-generator.active-action-registry");

interface PomActiveActionRecord {
  componentName?: string;
  methodName: string;
  expectedTestIds: readonly string[];
}

function setPomAction(page: object, action: PomActiveActionRecord): void {
  const globalRecord = globalThis as typeof globalThis & {
    [POM_ACTIVE_ACTION_REGISTRY]?: WeakMap<object, PomActiveActionRecord>;
  };
  const registry = globalRecord[POM_ACTIVE_ACTION_REGISTRY] ?? new WeakMap<object, PomActiveActionRecord>();
  globalRecord[POM_ACTIVE_ACTION_REGISTRY] = registry;
  registry.set(page, { ...action, expectedTestIds: [...action.expectedTestIds] });
}

// Click instrumentation is optional for generated POMs.
//
// When enabled, POM click/fill helpers will wait for the app to emit
// `__testid_event__` { testId, phase: "after" } after interacting with an
// element that has a data-testid.
//
// Default: disabled. (Playwright already has robust auto-waiting; requiring a
// custom event makes tests depend on app runtime instrumentation.)
const REQUIRE_CLICK_EVENT = false;

// Keep logging off by default.
const CLICK_EVENT_DEBUG = false;

/**
 * A chainable, thenable wrapper around a page object.
 *
 * This exists to enable fluent syntax for navigation-generated methods, e.g.:
 *   await tenantListPage.goToNewTenant().typeTenantName("Acme")
 *
 * The wrapper is PromiseLike<T>, so `await` returns the underlying page object once
 * the queued navigation/actions complete.
 */
/**
 * Deep fluent wrapper that preserves the original property surface while making
 * all methods chain back to the root fluent type.
 */
type DeepFluent<T, TRoot extends object> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer _R
  ? K extends "getObjectId"
  ? (...args: A) => ValueFluent<Awaited<_R>>
  : K extends "getObjectIdAsInt"
  ? (...args: A) => ValueFluent<Awaited<_R>>
  : (...args: A) => Fluent<TRoot>
  : T[K] extends object
  ? DeepFluent<T[K], TRoot>
  : T[K];
};

type DeepValueFluent<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
  ? (...args: A) => ValueFluent<Awaited<R>>
  : T[K] extends object
  ? DeepValueFluent<T[K]>
  : T[K];
};

export type Fluent<T extends object> = DeepFluent<T, T> & PromiseLike<T>;

export type ValueFluent<T> = DeepValueFluent<T> & PromiseLike<T>;

export interface BasePageOptions {
  /** Locator that scopes every generated selector in this component POM. */
  root?: PwLocator;
  renderers?: {
    callout?: CalloutRenderer;
    pointer?: PointerRenderer;
  };
  testIdAttribute?: string;
}

export class ObjectId {
  private readonly raw: string;

  public constructor(raw: string) {
    if (!raw) {
      throw new Error("ObjectId: raw value is empty");
    }
    this.raw = raw;
  }

  public toString(): string {
    return this.raw;
  }

  public asInt(): number {
    return this.AsInt();
  }

  public AsInt(): number {
    // Only accept base-10 integer strings.
    if (!/^\d+$/.test(this.raw)) {
      throw new Error(`ObjectId.AsInt: '${this.raw}' is not a base-10 integer string`);
    }
    const parsed = Number.parseInt(this.raw, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new TypeError(`ObjectId.AsInt: '${this.raw}' is not a safe integer`);
    }
    return parsed;
  }
}

/**
 * Base Page Object Model class that provides common functionality
 * for all component-specific Page Object Models
 */
export class BasePage {
  protected readonly testIdAttribute: string;

  private readonly callout: Callout;
  private readonly pointer: InstanceType<typeof Pointer>;

  /**
   * The narrowed Playwright page, stored privately. The narrowing (`PwPage` =
   * `BasePagePage`) is what lets the unit-test `FakePage` double satisfy the
   * constructor without stubbing ~250 `Page` members; it never escapes this
   * class. Subclasses (generated and hand-written POMs) reach the page through
   * the widened {@link BasePage.page} getter, which surfaces Playwright's full
   * `Page` so custom POMs can use `getByRole`/`waitForResponse`/`waitForFunction`
   * etc. for JS/DOM elements the generator can't key.
   */
  private readonly _page: PwPage;
  private readonly _root?: PwLocator;

  /**
   * Playwright's full `Page`, exposed to subclasses. This is the single,
   * sanctioned way generated/custom POMs touch the page — there is no separate
   * `rawPage`. The narrowed storage (`_page`) is widened here; the value is a
   * real `Page` at runtime.
   */
  protected get page(): Page {
    return this._page as Page;
  }

  /**
   * @param page - Playwright page object (narrowed `PwPage` so test doubles fit).
   */
  public constructor(page: PwPage, options?: BasePageOptions) {
    this._page = page;
    this._root = options?.root;
    this.testIdAttribute = (options?.testIdAttribute || "data-testid").trim() || "data-testid";

    const pointerRenderer = options?.renderers?.pointer;
    this.callout = new Callout(this._page, {
      extraOverlayIds: pointerRenderer?.overlayIds,
      renderer: options?.renderers?.callout,
    });
    this.pointer = new Pointer(this._page, this.testIdAttribute, this.callout, pointerRenderer);
  }

  public get screencast(): Page["screencast"] {
    return this.page.screencast;
  }

  private async waitForTestIdClickEventAfter(testId: string, options?: { timeoutMs?: number }): Promise<void> {
    if (!REQUIRE_CLICK_EVENT) {
      return;
    }

    const timeoutMs = options?.timeoutMs ?? 2_000;
    const requireEvent = REQUIRE_CLICK_EVENT;

    if (CLICK_EVENT_DEBUG) {
      // This log is on the Node side (Playwright runner).
      console.log(`[testid-click-event] waiting for '${testId}' after (timeout=${timeoutMs}ms, require=${requireEvent})`);
    }

    // If the click triggers navigation, the JS context can be destroyed while waiting.
    // In that scenario, the click already did its job; don't fail the test infra.
    try {
      await this.page.evaluate(
        ({ eventName, expectedTestId, timeoutMs, debug }) => {
          return new Promise<void>((resolve, reject) => {
            const g = globalThis;
            if (!g || typeof g.addEventListener !== "function") {
              reject(new Error(`Click instrumentation not available (no addEventListener) for '${expectedTestId}'`));
              return;
            }

            const cleanup = (timer: ReturnType<typeof setTimeout>, onEvent: (evt: Event) => void) => {
              clearTimeout(timer);
              try {
                g.removeEventListener(eventName, onEvent);
              }
              catch { /* noop */ }
            };

            let finished = false;
            let timer: ReturnType<typeof setTimeout>;
            let onEvent: (evt: Event) => void;

            const finishOk = () => {
              if (finished) return;
              finished = true;
              cleanup(timer, onEvent);
              resolve();
            };

            const finishErr = (err: Error) => {
              if (finished) return;
              finished = true;
              cleanup(timer, onEvent);
              reject(err);
            };

            onEvent = (evt: Event) => {
              const detail = (evt as CustomEvent<TestIdClickEventDetail>).detail;
              if (!detail) return;

              if (debug) {
                console.log(`[testid-click-event][page] saw ${eventName} testId='${detail.testId}' phase='${detail.phase}'`);
              }

              if (detail.testId !== expectedTestId) return;

              if (detail.phase === "error") {
                finishErr(new Error(detail.err || `Click handler failed for ${expectedTestId}`));
                return;
              }

              if (detail.phase === "after") {
                finishOk();
              }
            };

            timer = setTimeout(() => {
              finishErr(new Error(`Timed out waiting for ${eventName} 'after' for '${expectedTestId}' (${timeoutMs}ms)`));
            }, timeoutMs);

            try {
              if (debug) {
                console.log(`[testid-click-event][page] addEventListener(${eventName}) for '${expectedTestId}'`);
              }
              g.addEventListener(eventName, onEvent);
            }
            catch {
              finishErr(new Error(`Click instrumentation not available (addEventListener threw) for '${expectedTestId}'`));
            }
          });
        },
        {
          eventName: TESTID_CLICK_EVENT_NAME,
          expectedTestId: testId,
          timeoutMs,
          debug: CLICK_EVENT_DEBUG,
        },
      );
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Execution context was destroyed") || msg.includes("Target closed")) {
        if (CLICK_EVENT_DEBUG) {
          console.log(`[testid-click-event] context destroyed while waiting for '${testId}' (likely navigation)`);
        }
        return;
      }
      throw e;
    }
  }

  private getAfterPointerClick(wait: boolean = true): AfterPointerClick | undefined {
    if (!REQUIRE_CLICK_EVENT || !wait) return undefined;

    return async ({ testId, instrumented }: AfterPointerClickInfo) => {
      if (!testId || !instrumented) return;
      await this.waitForTestIdClickEventAfter(testId);
    };
  }

  protected selectorForTestId(testId: string): string {
    return `[${this.testIdAttribute}="${testId}"]`;
  }

  protected describeLocator(locator: Locator, description?: string): Locator {
    const normalizedDescription = description?.trim();
    return normalizedDescription ? locator.describe(normalizedDescription) : locator;
  }

  private locatorInScope(selector: string, within?: PwLocator): Locator {
    const root = within ?? this._root;
    return (root ? root.locator(selector) : this._page.locator(selector)) as Locator;
  }

  /** Resolve a generated component-instance marker inside this POM's current scope. */
  protected componentInstanceLocator(instanceId: string, within?: PwLocator): Locator {
    return this.locatorInScope(`[data-pom-instance=${JSON.stringify(instanceId)}]`, within)
      .filter({ visible: true })
      .first();
  }

  protected locatorByTestId(testId: string, description?: string): Locator {
    return this.describeLocator(this.locatorInScope(this.selectorForTestId(testId)), description);
  }

  protected async resolveVisibleTestIdLocator(
    testIds: readonly string[],
    description: string,
    methodName: string,
    componentName?: string,
  ): Promise<Locator> {
    this.recordPomAction(componentName, methodName, testIds);
    const locators = testIds.map(testId => this.locatorByTestId(testId, description));
    if (!locators.length) {
      throw new Error(`[pom] ${methodName} has no candidate test ids.`);
    }

    try {
      await Promise.any(locators.map(locator => locator.waitFor({ state: "visible", timeout: 5_000 })));
    }
    catch (error) {
      throw new Error(
        `[pom] ${methodName} could not find a visible element for any generated test id: ${testIds.join(", ")}`,
        { cause: error },
      );
    }

    for (const locator of locators) {
      if (await locator.isVisible()) return locator;
    }
    return locators[0]!;
  }

  protected recordPomAction(
    componentName: string | undefined,
    methodName: string,
    expectedTestIds: readonly string[],
  ): void {
    setPomAction(this.page, { componentName, methodName, expectedTestIds });
  }

  protected locatorWithinTestIdByLabel(
    rootTestId: string,
    label: string,
    options?: { exact?: boolean; description?: string },
  ): Locator {
    // Custom radio controls commonly render an invisible input beneath its visible
    // associated <label>. getByLabel() correctly resolves the input, but clicking it
    // then fails actionability because the label intercepts pointer events. Generated
    // radio actions are user interactions, so click the visible labelled surface.
    const locator = this.locatorByTestId(rootTestId)
      .filter({ visible: true })
      .first()
      .getByText(label, { exact: options?.exact ?? true });
    return this.describeLocator(locator, options?.description);
  }

  /**
   * Animates the pointer to an element.
   */
  protected async animateCursorToElement(
    target: string | PwLocator,
    executeClick: boolean = true,
    delayMs: number = 1000,
    annotationText: string = "",
    options?: {
      afterClick?: AfterPointerClick;
    },
  ): Promise<void> {
    await this.pointer.animateCursorToElement(target, executeClick, delayMs, annotationText, options);
  }

  public async showCallout(target: string | PwLocator, annotationText: string): Promise<void> {
    await this.callout.showForElement(target, annotationText);
  }

  public async showCalloutByTestId(testId: string, annotationText: string): Promise<void> {
    await this.showCallout(this.selectorForTestId(testId), annotationText);
  }

  public async hideCallout(): Promise<void> {
    await this.callout.hide();
  }

  /**
   * Creates an indexable proxy for keyed elements so generated POMs can expose
   * ergonomic accessors like:
   *   expect(page.SaveButton["MyKey"]).toBeVisible();
   */
  protected keyedLocators<TKey extends string>(getLocator: (key: TKey) => PwLocator): Record<TKey, Locator> {
    const handler: ProxyHandler<object> = {
      get: (_t, prop) => {
        // Avoid confusing Promise-like detection and ignore symbols.
        if (prop === "then" || typeof prop === "symbol") {
          return undefined;
        }
        return getLocator(String(prop) as TKey);
      },
    };

    // `getLocator` returns the narrowed `PwLocator` (so test doubles satisfy it), but each
    // value is a real Playwright `Locator` at runtime. Widen the record's value type so
    // generated keyed accessors can be passed to `expect(...)`.
    return new Proxy({}, handler) as Record<TKey, Locator>;
  }

  public async getObjectId(options?: { timeoutMs?: number }): Promise<ObjectId> {
    const timeoutMs = options?.timeoutMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const url = this.page.url();
      const match = url.match(/\/(\d+)(?:[/?#]|$)/);
      if (match) {
        return new ObjectId(match[1]);
      }

      if (Date.now() >= deadline) {
        throw new Error(`getObjectId: could not find a numeric id in url '${url}' within ${timeoutMs}ms`);
      }

      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
  }

  public async getObjectIdAsInt(options?: { timeoutMs?: number }): Promise<number> {
    const objectId = await this.getObjectId(options);
    return objectId.asInt();
  }

  /**
   * Wraps an async factory for a page object into a chainable Fluent<T>.
   *
   * The returned proxy:
   * - forwards method calls to the resolved object
   * - queues async method calls (Promise-returning) so they execute in order
   * - is PromiseLike, so `await` yields the underlying object
   */
  protected fluent<T extends object>(factory: () => Promise<T>): Fluent<T> {
    // Cache the factory result so we don't repeat navigation/actions.
    const rootPromise = factory();
    const getRoot = () => rootPromise;

    // Queue of side-effects (navigation + actions). Awaiting the fluent proxy awaits this queue.
    let queue: Promise<void> = Promise.resolve();

    let rootProxy: Fluent<T>;

    const VALUE_RETURNING_METHODS = new Set<PropertyKey>([
      "getObjectId",
      "getObjectIdAsInt",
    ]);

    const getCtorName = (obj: object): string => {
      const o = obj as { constructor?: { name?: string } };
      return o.constructor?.name ?? "object";
    };

    const createValueProxy = <V>(getValue: () => Promise<V>): V & PromiseLike<V> => {
      const handler: ProxyHandler<() => void> = {
        get: (_t, prop) => {
          if (prop === "then") {
            return (onFulfilled?: ((value: V) => object) | null, onRejected?: ((reason: object) => object) | null) => {
              return queue.then(() => getValue()).then(onFulfilled as never, onRejected as never);
            };
          }

          return createValueMemberProxy(getValue, prop);
        },
      };

      const target = () => undefined;
      return new Proxy(target, handler) as never as V & PromiseLike<V>;
    };

    function createValueMemberProxy<P>(getParent: () => Promise<P>, member: PropertyKey): P & PromiseLike<P> {
      const handler: ProxyHandler<() => void> = {
        get: (_t, prop) => {
          if (prop === "then") {
            return (onFulfilled?: ((value: object) => object) | null, onRejected?: ((reason: object) => object) | null) => {
              return queue
                .then(async () => {
                  const parent = await getParent();
                  const value = Reflect.get(parent as never as object, member);
                  if (value == null) {
                    throw new Error(`Fluent: '${String(member)}' does not exist on ${getCtorName(parent as never as object)}`);
                  }
                  return value as object;
                })
                .then(onFulfilled as never, onRejected as never);
            };
          }

          return createValueMemberProxy(async () => {
            const parent = await getParent();
            const value = Reflect.get(parent as never as object, member);
            if (value == null) {
              throw new Error(`Fluent: '${String(member)}' does not exist on ${getCtorName(parent as never as object)}`);
            }
            return value as P;
          }, prop);
        },
        apply: (_t, _thisArg, args) => {
          const resultPromise = new Promise((resolve, reject) => {
            queue = queue
              .then(async () => {
                const parent = await getParent();
                const value = Reflect.get(parent as never as object, member);
                if (typeof value !== "function") {
                  throw new TypeError(`Fluent: '${String(member)}' is not a function on ${getCtorName(parent as never as object)}`);
                }
                const fn = value as (...a: object[]) => PromiseLike<object> | object;
                const result = fn.apply(parent, args as object[]);
                const resolved = result instanceof Promise ? await result : result;
                resolve(resolved);
              })
              .catch(reject);
          });

          return createValueProxy(() => resultPromise as Promise<P>);
        },
      };

      const target = () => undefined;
      return new Proxy(target, handler) as never as P & PromiseLike<P>;
    }

    const createMemberProxy = <P extends object>(getParent: () => Promise<P>, member: PropertyKey): Fluent<T> => {
      const handler: ProxyHandler<() => void> = {
        get: (_t, prop) => {
          if (prop === "then") {
            return (onFulfilled?: ((value: object) => object) | null, onRejected?: ((reason: object) => object) | null) => {
              return queue
                .then(async () => {
                  const parent = await getParent();
                  const value = Reflect.get(parent, member);
                  if (value == null) {
                    throw new Error(`Fluent: '${String(member)}' does not exist on ${parent.constructor?.name ?? "object"}`);
                  }
                  return value as object;
                })
                .then(onFulfilled as never, onRejected as never);
            };
          }

          // Chain deeper: resolve this member value, then access its property.
          return createMemberProxy(async () => {
            const parent = await getParent();
            const value = Reflect.get(parent, member);
            if (value == null) {
              throw new Error(`Fluent: '${String(member)}' does not exist on ${parent.constructor?.name ?? "object"}`);
            }
            return value as P;
          }, prop);
        },
        apply: (_t, _thisArg, args) => {
          const resultPromise = new Promise((resolve, reject) => {
            // Call parent[member](...args) with correct `this` binding.
            queue = queue
              .then(async () => {
                const parent = await getParent();
                const value = Reflect.get(parent, member);
                if (typeof value !== "function") {
                  throw new TypeError(`Fluent: '${String(member)}' is not a function on ${parent.constructor?.name ?? "object"}`);
                }
                const fn = value as (...a: object[]) => PromiseLike<object> | object;
                // Preserve `this` so methods can access instance fields (e.g. composed child POMs).
                const result = fn.apply(parent, args as object[]);
                const resolved = result instanceof Promise ? await result : result;
                resolve(resolved);
              })
              .catch(reject);
          });

          if (VALUE_RETURNING_METHODS.has(member)) {
            return createValueProxy(() => resultPromise as Promise<object>);
          }

          // After calling a method, stay on the *root object* so you can chain sibling methods.
          return rootProxy;
        },
      };

      const target = () => undefined;
      return new Proxy(target, handler) as never as Fluent<T>;
    };

    const rootHandler: ProxyHandler<object> = {
      get: (_t, prop) => {
        if (prop === "then") {
          return (onFulfilled?: ((value: T) => object) | null, onRejected?: ((reason: object) => object) | null) => {
            return queue.then(() => getRoot()).then(onFulfilled as never, onRejected as never);
          };
        }
        return createMemberProxy(getRoot, prop);
      },
    };

    const rootTarget = {};
    rootProxy = new Proxy(rootTarget, rootHandler) as Fluent<T>;
    return rootProxy;
  }

  /**
   * Clicks on an element with the specified data-testid
   * @param testId The data-testid of the element to click
   */
  public async clickByTestId(
    testId: string,
    annotationText: string = "",
    wait: boolean = true,
    description?: string,
    action?: { componentName?: string; methodName: string; preferAssociatedLabel?: boolean },
  ): Promise<void> {
    this.recordPomAction(action?.componentName, action?.methodName ?? description ?? "clickByTestId", [testId]);
    const locator = this.locatorByTestId(testId, description).filter({ visible: true }).first();
    let clickTarget = locator;
    let activateWithKeyboard = false;
    if (action?.preferAssociatedLabel) {
      const visibleControl = locator;
      const controlId = await visibleControl.getAttribute("id");
      if (controlId) {
        // Bootstrap custom controls often use an empty label whose painted ::before/::after
        // pseudo-elements intercept the pointer. Playwright's visible filter can exclude that
        // empty label even though its pseudo-element is the actual interaction surface, so first
        // select the associated label by DOM presence and then choose pointer or keyboard activation.
        const associatedLabel = this.locatorInScope(`label[for=${JSON.stringify(controlId)}]`).first();
        if (await associatedLabel.count() > 0) {
          if (await associatedLabel.isVisible()) {
            clickTarget = associatedLabel;
          }
          else {
            // An empty label can have a zero-size element box while its ::before checkbox/radio
            // remains painted over the input. Pointer clicks cannot target either surface without
            // force; Space is the native, actionability-checked keyboard activation for both.
            activateWithKeyboard = true;
          }
        }
      }
      else {
        clickTarget = visibleControl;
      }
    }
    const afterClick = this.getAfterPointerClick(wait);
    if (activateWithKeyboard) {
      await this.pointer.animateCursorToElement(locator, false, 200, annotationText);
      await locator.press("Space");
      if (afterClick) {
        await afterClick({ testId, instrumented: true });
      }
      return;
    }
    await this.pointer.animateCursorToElement(clickTarget, true, 200, annotationText, afterClick ? { afterClick } : undefined);
  }

  public async clickLocator(locator: PwLocator, annotationText: string = "", wait: boolean = true): Promise<void> {
    const afterClick = this.getAfterPointerClick(wait);
    await this.pointer.animateCursorToElement(locator, true, 200, annotationText, afterClick ? { afterClick } : undefined);
  }

  protected async clickWithinTestIdByLabel(
    rootTestId: string,
    label: string,
    annotationText: string = "",
    wait: boolean = true,
    options?: { exact?: boolean; description?: string; componentName?: string; methodName?: string },
  ): Promise<void> {
    this.recordPomAction(options?.componentName, options?.methodName ?? options?.description ?? "clickWithinTestIdByLabel", [rootTestId]);
    const locator = this.locatorWithinTestIdByLabel(rootTestId, label, {
      exact: options?.exact,
      description: options?.description,
    });
    await this.clickLocator(locator, annotationText, wait);
  }

  protected async fillInputByTestId(
    testId: string,
    text: string,
    annotationText: string = "",
    description?: string,
    action?: { componentName?: string; methodName: string },
  ): Promise<void> {
    this.recordPomAction(action?.componentName, action?.methodName ?? description ?? "fillInputByTestId", [testId]);
    const locator = this.locatorByTestId(testId, description).filter({ visible: true }).first();
    const afterClick = this.getAfterPointerClick();
    await this.pointer.animateCursorToElementAndClickAndFill(locator, text, true, 200, annotationText, afterClick ? { afterClick } : undefined);
  }

  /**
   * Interacts with a vue-select control rooted by a data-testid.
   * This is emitted frequently by the generator; keeping it here reduces per-page duplicated code.
   */
  protected async selectVSelectByTestId(
    testId: string,
    value: string,
    annotationText: string = "",
    description?: string,
    action?: { componentName?: string; methodName: string },
  ): Promise<void> {
    this.recordPomAction(action?.componentName, action?.methodName ?? description ?? "selectVSelectByTestId", [testId]);
    const root = this.locatorByTestId(testId, description).filter({ visible: true }).first();
    const input = root.locator("input");

    await this.pointer.animateCursorToElement(input, false, 200, annotationText);
    await input.click();
    await this.pointer.animateCursorToElementAndClickAndFill(input, value, false, 200, annotationText);

    const option = root.locator("ul.vs__dropdown-menu li[role='option']").first();
    await option.waitFor({ state: "visible", timeout: 5_000 });
    const afterClick = this.getAfterPointerClick();
    await this.pointer.animateCursorToElement(option, true, 200, annotationText, afterClick ? { afterClick } : undefined);
  }

  public async fillInputByLocator(locator: PwLocator, text: string, annotationText: string = ""): Promise<void> {
    const afterClick = this.getAfterPointerClick();
    await this.pointer.animateCursorToElementAndClickAndFill(locator, text, true, 200, annotationText, afterClick ? { afterClick } : undefined);
  }

  protected async clickByAriaLabel(ariaLabel: string, annotationText: string = ""): Promise<void> {
    const afterClick = this.getAfterPointerClick();
    await this.pointer.animateCursorToElement(`[aria-label="${ariaLabel}"]`, true, 200, annotationText, afterClick ? { afterClick } : undefined);
  }

  /**
   * Types text into an element with the specified data-testid
   * @param testId The data-testid of the element to type into
   * @param text The text to type
   */
  protected async typeByTestId(testId: string, text: string): Promise<void> {
    await this.fillInputByTestId(testId, text);
  }

  /**
   * Checks if an element with the specified data-testid is visible
   * @param testId The data-testid of the element to check
   * @returns True if the element is visible, false otherwise
   */
  protected async isVisibleByTestId(testId: string): Promise<boolean> {
    return this.locatorByTestId(testId).isVisible();
  }

  /**
   * Gets the text content of an element with the specified data-testid
   * @param testId The data-testid of the element to get text from
   * @returns The text content of the element
   */
  protected async getTextByTestId(testId: string): Promise<string | null> {
    return this.locatorByTestId(testId).textContent();
  }

  /**
   * Waits for an element with the specified data-testid to be visible
   * @param testId The data-testid of the element to wait for
   * @param options Optional timeout and other options
   * @param options.timeout The maximum time to wait for the element to be visible (default is 5000ms)
   * @returns A promise that resolves when the element is visible
   */
  protected async waitForTestId(testId: string, options?: { timeout?: number }): Promise<void> {
    await this.locatorByTestId(testId).waitFor({ state: "visible", timeout: options?.timeout ?? 5_000 });
  }

  /**
   * Hovers over an element with the specified data-testid
   * @param testId The data-testid of the element to hover over
   */
  protected async hoverByTestId(testId: string): Promise<void> {
    const locator = this.locatorByTestId(testId);
    await this.pointer.animateCursorToElement(locator, false, 200, "");
    await locator.hover();
  }

  /**
   * Selects an option from a dropdown with the specified data-testid
   * @param testId The data-testid of the dropdown
   * @param value The value to select
   */
  protected async selectByTestId(testId: string, value: string): Promise<void> {
    await this.locatorByTestId(testId).selectOption(value);
  }
}
