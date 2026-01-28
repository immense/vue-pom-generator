import type { Locator as PwLocator, Page as PwPage } from "@playwright/test";
import { TESTID_CLICK_EVENT_NAME, TESTID_CLICK_EVENT_STRICT_FLAG } from "../click-instrumentation";
import type { TestIdClickEventDetail } from "../click-instrumentation";
import { Pointer } from "./Pointer";
import type { AfterPointerClickInfo } from "./Pointer";

// Click instrumentation is a core contract for generated POMs.
const REQUIRE_CLICK_EVENT = true;

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

  private readonly pointer: InstanceType<typeof Pointer>;

  /**
   * @param {Page} page - Playwright page object
   */
  constructor(protected page: PwPage, options?: { testIdAttribute?: string }) {
    this.testIdAttribute = (options?.testIdAttribute || "data-testid").trim() || "data-testid";

    this.pointer = new Pointer(this.page, this.testIdAttribute);
  }

  private async waitForTestIdClickEventAfter(testId: string, options?: { timeoutMs?: number }): Promise<void> {
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
        ({ eventName, strictFlagName, expectedTestId, timeoutMs, requireEvent, debug }) => {
          return new Promise<void>((resolve, reject) => {
            const g = globalThis;
            if (!g || typeof g.addEventListener !== "function") {
              reject(new Error(`Click instrumentation not available (no addEventListener) for '${expectedTestId}'`));
              return;
            }

            // Mark strict mode in the page so the injected click wrapper can
            // fail fast (no fallback) when instrumentation is expected.
            if (requireEvent) {
              try {
                type GlobalWithFlag = typeof globalThis & { [k: string]: boolean | undefined };
                (g as GlobalWithFlag)[strictFlagName] = true;
              }
              catch { /* noop */ }
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
          strictFlagName: TESTID_CLICK_EVENT_STRICT_FLAG,
          expectedTestId: testId,
          timeoutMs,
          requireEvent,
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

  protected selectorForTestId(testId: string): string {
    return `[${this.testIdAttribute}="${testId}"]`;
  }

  protected locatorByTestId(testId: string): PwLocator {
    return this.page.locator(this.selectorForTestId(testId));
  }

  /**
   * Creates an indexable proxy for keyed elements so generated POMs can expose
   * ergonomic accessors like:
   *   expect(page.SaveButton["MyKey"]).toBeVisible();
   */
  protected keyedLocators<TKey extends string>(getLocator: (key: TKey) => PwLocator): Record<TKey, PwLocator> {
    const handler: ProxyHandler<object> = {
      get: (_t, prop) => {
        // Avoid confusing Promise-like detection and ignore symbols.
        if (prop === "then" || typeof prop === "symbol") {
          return undefined;
        }
        return getLocator(String(prop) as TKey);
      },
    };

    return new Proxy({}, handler) as Record<TKey, PwLocator>;
  }

  public async getObjectId(options?: { timeoutMs?: number }): Promise<ObjectId> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
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
  public async clickByTestId(testId: string, annotationText: string = "", wait: boolean = true): Promise<void> {
    await this.pointer.animateCursorToElement(this.selectorForTestId(testId), true, 200, annotationText, {
      afterClick: async ({ testId: clickedTestId, instrumented }: AfterPointerClickInfo) => {
        if (!wait) return;
        if (!clickedTestId || !instrumented) return;
        await this.waitForTestIdClickEventAfter(clickedTestId);
      },
    });
  }

  public async clickLocator(locator: PwLocator, annotationText: string = "", wait: boolean = true): Promise<void> {
    await this.pointer.animateCursorToElement(locator, true, 200, annotationText, {
      afterClick: async ({ testId: clickedTestId, instrumented }: AfterPointerClickInfo) => {
        if (!wait) return;
        if (!clickedTestId || !instrumented) return;
        await this.waitForTestIdClickEventAfter(clickedTestId);
      },
    });
  }

  protected async fillInputByTestId(testId: string, text: string, annotationText: string = ""): Promise<void> {
    await this.pointer.animateCursorToElementAndClickAndFill(this.selectorForTestId(testId), text, true, 200, annotationText, {
      afterClick: async ({ testId: clickedTestId, instrumented }: AfterPointerClickInfo) => {
        if (!clickedTestId || !instrumented) return;
        await this.waitForTestIdClickEventAfter(clickedTestId);
      },
    });
  }

  /**
   * Interacts with a vue-select control rooted by a data-testid.
   * This is emitted frequently by the generator; keeping it here reduces per-page duplicated code.
   */
  protected async selectVSelectByTestId(testId: string, value: string, timeOut: number = 500, annotationText: string = ""): Promise<void> {
    const root = this.locatorByTestId(testId);
    const input = root.locator("input");

    await this.pointer.animateCursorToElement(input, false, 200, annotationText);
    await input.click({ force: true });
    await this.pointer.animateCursorToElementAndClickAndFill(input, value, false, 200, annotationText);
    await this.page.waitForTimeout(timeOut);

    const option = root.locator("ul.vs__dropdown-menu li[role='option']").first();
    if (await option.count()) {
      await this.pointer.animateCursorToElement(option, true, 200, annotationText, {
        afterClick: async ({ testId: clickedTestId, instrumented }: AfterPointerClickInfo) => {
          if (!clickedTestId || !instrumented) return;
          await this.waitForTestIdClickEventAfter(clickedTestId);
        },
      });
    }
  }

  public async fillInputByLocator(locator: PwLocator, text: string, annotationText: string = ""): Promise<void> {
    await this.pointer.animateCursorToElementAndClickAndFill(locator, text, true, 200, annotationText, {
      afterClick: async ({ testId: clickedTestId, instrumented }: AfterPointerClickInfo) => {
        if (!clickedTestId || !instrumented) return;
        await this.waitForTestIdClickEventAfter(clickedTestId);
      },
    });
  }

  protected async clickByAriaLabel(ariaLabel: string, annotationText: string = ""): Promise<void> {
    await this.pointer.animateCursorToElement(`[aria-label="${ariaLabel}"]`, true, 200, annotationText, {
      afterClick: async ({ testId: clickedTestId, instrumented }: AfterPointerClickInfo) => {
        if (!clickedTestId || !instrumented) return;
        await this.waitForTestIdClickEventAfter(clickedTestId);
      },
    });
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
    return await this.page.isVisible(this.selectorForTestId(testId));
  }

  /**
   * Gets the text content of an element with the specified data-testid
   * @param testId The data-testid of the element to get text from
   * @returns The text content of the element
   */
  protected async getTextByTestId(testId: string): Promise<string | null> {
    return await this.page.textContent(this.selectorForTestId(testId));
  }

  /**
   * Waits for an element with the specified data-testid to be visible
   * @param testId The data-testid of the element to wait for
   * @param options Optional timeout and other options
   * @param options.timeout The maximum time to wait for the element to be visible (default is 3000ms)
   * @returns A promise that resolves when the element is visible
   */
  protected async waitForTestId(testId: string, options?: { timeout?: number }): Promise<void> {
    await this.page.waitForSelector(this.selectorForTestId(testId), options);
  }

  /**
   * Hovers over an element with the specified data-testid
   * @param testId The data-testid of the element to hover over
   */
  protected async hoverByTestId(testId: string): Promise<void> {
    const selector = this.selectorForTestId(testId);
    await this.pointer.animateCursorToElement(selector, false, 200, "");
    await this.page.hover(selector);
  }

  /**
   * Selects an option from a dropdown with the specified data-testid
   * @param testId The data-testid of the dropdown
   * @param value The value to select
   */
  protected async selectByTestId(testId: string, value: string): Promise<void> {
    await this.page.selectOption(this.selectorForTestId(testId), value);
  }
}

