import type { Locator as PwLocator, Page as PwPage } from "@playwright/test";
import { TESTID_CLICK_EVENT_NAME, TESTID_CLICK_EVENT_STRICT_FLAG } from "../click-instrumentation";
import type { TestIdClickEventDetail } from "../click-instrumentation";

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

const cursorImageId = "mouse_follower";
const cursorAnnotationId = "cursor-annotation";

type PlaywrightAnimationOptions = false | {
  pointer?: {
    durationMilliseconds?: number;
    transitionStyle?: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out";
    clickDelayMilliseconds?: number;
  };
  keyboard?: {
    typeDelayMilliseconds?: number;
  };
};

const animationGlobalKey = "__VUE_TESTID_PLAYWRIGHT_ANIMATION__";

function getAnimationOptions(): PlaywrightAnimationOptions {
  const fromFixture = Reflect.get(globalThis, animationGlobalKey);
  if (fromFixture === false || typeof fromFixture === "object")
    return fromFixture as PlaywrightAnimationOptions;

  // If this code is used outside our standard fixtures, fall back to defaults.
  return {
    pointer: {
      durationMilliseconds: 250,
      transitionStyle: "ease-in-out",
      clickDelayMilliseconds: 0,
    },
    keyboard: {
      typeDelayMilliseconds: 100,
    },
  };
}

function getPointerMoveDurationMs(animation: PlaywrightAnimationOptions): number {
  if (animation === false) return 0;
  const ms = animation.pointer?.durationMilliseconds;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : 250;
}

function getPointerTransitionStyle(animation: PlaywrightAnimationOptions): string {
  if (animation === false) return "linear";
  const style = animation.pointer?.transitionStyle;
  return typeof style === "string" && style.trim() ? style.trim() : "ease-in-out";
}

function getPointerClickDelayMs(animation: PlaywrightAnimationOptions): number {
  if (animation === false) return 0;
  const ms = animation.pointer?.clickDelayMilliseconds;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

function getKeyboardTypeDelayMs(animation: PlaywrightAnimationOptions): number {
  if (animation === false) return 0;
  const ms = animation.keyboard?.typeDelayMilliseconds;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : 100;
}

class BrowserCursorCoordinates {
  private static _X: number = 0;
  private static _Y: number = 0;

  static get X(): number {
    return BrowserCursorCoordinates._X;
  }

  static get Y(): number {
    return BrowserCursorCoordinates._Y;
  }

  static set X(X: number) {
    BrowserCursorCoordinates._X = X;
  }

  static set Y(Y: number) {
    BrowserCursorCoordinates._Y = Y;
  }

  // Resets the cached cursor coordinates.
  static reset(): void {
    BrowserCursorCoordinates._X = 0;
    BrowserCursorCoordinates._Y = 0;
  }
}

/**
 * Base Page Object Model class that provides common functionality
 * for all component-specific Page Object Models
 */
export class BasePage {
  protected readonly testIdAttribute: string;

  // Cache whether we've attempted to initialize the in-page cursor for this
  // page instance. The initializer is idempotent and will recreate the cursor
  // if it was removed by navigation/reload.
  private cursorInitAttempted = false;

  /**
   * @param {Page} page - Playwright page object
   */
  constructor(protected page: PwPage, options?: { testIdAttribute?: string }) {
    this.testIdAttribute = (options?.testIdAttribute || "data-testid").trim() || "data-testid";

    // Navigation/reload can wipe the cursor DOM node. Reset our cache so the
    // next action re-initializes the cursor and resets cached coordinates.
    this.page.on("framenavigated", (frame) => {
      try {
        if (frame === this.page.mainFrame()) {
          this.cursorInitAttempted = false;
        }
      }
      catch {
        // Ignore; page may already be closing.
      }
    });
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
              } catch { /* noop */ }
            }

            const cleanup = (timer: ReturnType<typeof setTimeout>, onEvent: (evt: Event) => void) => {
              clearTimeout(timer);
              try {
                g.removeEventListener(eventName, onEvent);
              } catch { /* noop */ }
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
            } catch {
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

  private getPointerMoveDurationMs(): number {
    return getPointerMoveDurationMs(getAnimationOptions());
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

  protected async animateCursorToElement(
    selector: string | PwLocator,
    executeClick = true,
    delay: number = 100,
    annotationText?: string,
    waitForInstrumentationEvent: boolean = true,
  ): Promise<PwLocator> {
    await this.enableCursor();

    // Interpret the public "delay" argument as a multiplier of our configured move duration.
    // Keeping a "delay" parameter in the API lets existing generated methods control pacing
    // (200 vs 100) while the config controls the base speed.
    const baseDurationMs = this.getPointerMoveDurationMs();
    const delayMultiplier = delay <= 0 ? 0 : delay / 100;
    const configuredDurationMs = Math.round(baseDurationMs * delayMultiplier);
    const transitionStyle = getPointerTransitionStyle(getAnimationOptions());
    const element = typeof selector === "string" ? this.page.locator(selector) : selector;
    if (!element) {
      throw new Error(`Element with selector "${selector}" not found`);
    }
    const startX = BrowserCursorCoordinates.X;
    const startY = BrowserCursorCoordinates.Y;

    // Do scroll + geometry + annotation + cursor animation (and optional click
    // pulse) in a single browser-context evaluation. Movement completion is
    // detected via transitionend inside the page.
    const { endX, endY, distance, durationMs, testId, instrumented } = await element.evaluate(
      async (el, args) => {
        const {
          cursorImageId,
          annotationId,
          annotationText,
          startX,
          startY,
          durationMs,
          transitionStyle,
          pulseOnArrival,
          testIdAttribute,
        } = args;

        // Scroll the element into view before measuring.
        try {
          (el as HTMLElement).scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
        }
        catch {
          try {
            (el as HTMLElement).scrollIntoView();
          }
          catch { /* noop */ }
        }

        // Compute target coordinates relative to the viewport.
        const rect = (el as Element).getBoundingClientRect();
        const endX = rect.left + rect.width / 2;
        const endY = rect.top + rect.height / 2;
        const dx = endX - startX;
        const dy = endY - startY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        const moveDurationMs = durationMs > 0 && distance > 0 ? durationMs : 0;

        if (annotationText) {
          const prev = document.getElementById(annotationId);
          if (prev) prev.remove();

          const annotation = document.createElement("div");
          annotation.id = annotationId;
          annotation.style.cssText = `
            position: fixed;
            background-color: red;
            color: white;
            padding: 5px;
            border-radius: 3px;
            font-size: 14px;
            pointer-events: none;
            z-index: 99999999999;
            left: ${endX + 20}px;
            top: ${endY - 30}px;
          `;
          annotation.textContent = annotationText;
          document.body.appendChild(annotation);

          // Auto-remove to avoid extra round-trips and to remain navigation-safe.
          const cleanupAfterMs = Math.max(500, (moveDurationMs * 2) + 750);
          setTimeout(() => {
            try { annotation.remove(); } catch { /* noop */ }
          }, cleanupAfterMs);
        }

        const cursorImage = document.getElementById(cursorImageId) as HTMLElement | null;
        if (cursorImage) {
          // Ensure we start from the cached coordinates before animating.
          cursorImage.style.transition = "";
          cursorImage.style.willChange = "left, top, transform";
          cursorImage.style.left = `${startX}px`;
          cursorImage.style.top = `${startY}px`;
          void cursorImage.offsetWidth;

          if (moveDurationMs > 0 && distance > 0) {
            cursorImage.style.transition = `left ${moveDurationMs}ms ${transitionStyle}, top ${moveDurationMs}ms ${transitionStyle}`;
          }
          cursorImage.style.left = `${endX}px`;
          cursorImage.style.top = `${endY}px`;

          // Wait for movement completion without a Playwright-side timeout.
          if (moveDurationMs > 0 && distance > 0) {
            await new Promise<void>((resolve) => {
              let done = false;
              let onEnd: ((evt: TransitionEvent) => void) | null = null;
              const finish = () => {
                if (done) return;
                done = true;
                if (onEnd) {
                  cursorImage.removeEventListener("transitionend", onEnd);
                }
                resolve();
              };

              onEnd = (evt: TransitionEvent) => {
                if (evt.target !== cursorImage) return;
                if (evt.propertyName !== "left" && evt.propertyName !== "top") return;
                finish();
              };

              cursorImage.addEventListener("transitionend", onEnd);
              // Fallback in case transitionend doesn't fire.
              setTimeout(finish, moveDurationMs + 100);
            });
          }

          if (pulseOnArrival) {
            // Pulse the cursor in-page for visual feedback.
            cursorImage.style.transition = "transform 120ms";
            cursorImage.style.transform = "scale(0.5)";
            setTimeout(() => {
              cursorImage.style.transform = "scale(1)";
            }, 100);
          }
        }

        const testId = (el as HTMLElement | null)?.getAttribute?.(testIdAttribute) ?? null;
        const instrumented = ((el as HTMLElement | null)?.getAttribute?.("data-click-instrumented") ?? "") === "1";

        return { endX, endY, distance, durationMs: moveDurationMs, testId, instrumented };
      },
      {
        cursorImageId,
        annotationId: cursorAnnotationId,
        annotationText: annotationText ?? "",
        startX,
        startY,
        durationMs: configuredDurationMs,
        transitionStyle,
        pulseOnArrival: executeClick,
        testIdAttribute: this.testIdAttribute,
      },
    );

    console.warn(`Target coordinates: (${endX}, ${endY})`);
    if (durationMs === 0) {
      console.warn("Skipping animation (delay=0)");
    }
    else if (distance === 0) {
      console.warn("Cursor already at target (distance=0); skipping animation");
    }
    else {
      console.warn(`Animating cursor with CSS transition (duration=${durationMs}ms, distance=${distance}px)`);
    }

    BrowserCursorCoordinates.X = endX;
    BrowserCursorCoordinates.Y = endY;

    if (executeClick) {
      const clickDelayMs = getPointerClickDelayMs(getAnimationOptions());
      const waitAfter = (waitForInstrumentationEvent && testId && instrumented)
        ? this.waitForTestIdClickEventAfter(testId)
        : null;

      console.warn(`Clicking ${typeof selector === "object" && "role" in selector ? `getByRole('${selector.role}', { name: ${typeof selector === "string" ? `'${selector}'` : selector} })` : selector}`);
      await element.click({ timeout: 1000, force: true, delay: clickDelayMs });

      if (waitAfter) {
        await waitAfter;
      }
    }
    else {
      console.warn(`NOT clicking ${selector} (executeClick=false)`);
      // No additional Playwright-side wait; the cursor animation already waited in-page.
    }

    return element;
  }

  protected async animateCursorToElementAndClickAndFill(selector: string | PwLocator, textContent: string, executeClick = true, delay: number = 100, annotationText?: string) {
    const animation = getAnimationOptions();
    const element = await this.animateCursorToElement(selector, executeClick, delay, annotationText);
    await element.clear();
    await this.page.keyboard.type(textContent, { delay: getKeyboardTypeDelayMs(animation) });
    // // Use fill() to ensure frameworks receive the right input events.
    // await element.fill(textContent);
  }

  /**
   * Moves the animated cursor to an element and (optionally) clicks it.
   *
   * This is referenced by generated POM classes.
   */
  protected async animateCursorToElementAndClick(selector: string | PwLocator, executeClick = true, delay: number = 100, annotationText: string = ""): Promise<PwLocator> {
    return await this.animateCursorToElement(selector, executeClick, delay, annotationText);
  }

  private async enableCursor() {
    // Avoid re-running cursor initialization on every action. This flag is reset
    // on navigation/reload.
    if (this.cursorInitAttempted) {
      return;
    }

    const created = await this.page.evaluate((cursorImageId) => {
      const existing = document.getElementById(cursorImageId);
      if (existing) {
        return false;
      }

      const seleniumFollowerImg = document.createElement("img");
      seleniumFollowerImg.setAttribute("src", "data:image/png;base64,"
      + "iVBORw0KGgoAAAANSUhEUgAAABQAAAAeCAQAAACGG/bgAAAAAmJLR0QA/4ePzL8AAAAJcEhZcwAA"
      + "HsYAAB7GAZEt8iwAAAAHdElNRQfgAwgMIwdxU/i7AAABZklEQVQ4y43TsU4UURSH8W+XmYwkS2I0"
      + "9CRKpKGhsvIJjG9giQmliHFZlkUIGnEF7KTiCagpsYHWhoTQaiUUxLixYZb5KAAZZhbunu7O/PKf"
      + "e+fcA+/pqwb4DuximEqXhT4iI8dMpBWEsWsuGYdpZFttiLSSgTvhZ1W/SvfO1CvYdV1kPghV68a3"
      + "0zzUWZH5pBqEui7dnqlFmLoq0gxC1XfGZdoLal2kea8ahLoqKXNAJQBT2yJzwUTVt0bS6ANqy1ga"
      + "VCEq/oVTtjji4hQVhhnlYBH4WIJV9vlkXLm+10R8oJb79Jl1j9UdazJRGpkrmNkSF9SOz2T71s7M"
      + "SIfD2lmmfjGSRz3hK8l4w1P+bah/HJLN0sys2JSMZQB+jKo6KSc8vLlLn5ikzF4268Wg2+pPOWW6"
      + "ONcpr3PrXy9VfS473M/D7H+TLmrqsXtOGctvxvMv2oVNP+Av0uHbzbxyJaywyUjx8TlnPY2YxqkD"
      + "dAAAAABJRU5ErkJggg==");
      seleniumFollowerImg.setAttribute("id", cursorImageId);
      seleniumFollowerImg.setAttribute("style", "position: absolute; z-index: 99999999999; pointer-events: none; left:0; top:0");
      document.body.appendChild(seleniumFollowerImg);
      return true;
    }, cursorImageId);

    this.cursorInitAttempted = true;
    if (created) {
      BrowserCursorCoordinates.reset();
    }
  }

  /**
   * Clicks on an element with the specified data-testid
   * @param testId The data-testid of the element to click
   */
  protected async clickByTestId(testId: string, annotationText: string = "", wait: boolean = true): Promise<void> {
    await this.animateCursorToElement(this.selectorForTestId(testId), true, 200, annotationText, wait);
  }

  public async clickLocator(locator: PwLocator, annotationText: string = "", wait: boolean = true): Promise<void> {
    await this.animateCursorToElement(locator, true, 200, annotationText, wait);
  }

  /**
   * Clicks a locator but does NOT wait for the click-instrumentation event.
   *
   * Use this when the underlying click handler intentionally stays pending while a modal is open
   * (e.g., it awaits user confirmation). Waiting for the "after" phase in that situation can
   * deadlock the test.
   */
  public async clickLocatorNoWait(locator: PwLocator, annotationText: string = ""): Promise<void> {
    await this.clickLocator(locator, annotationText, false);
  }

  protected async fillInputByTestId(testId: string, text: string, annotationText: string = ""): Promise<void> {
    await this.animateCursorToElementAndClickAndFill(this.selectorForTestId(testId), text, true, 200, annotationText);
  }

  /**
   * Moves the animated cursor to an element without clicking.
   * Useful for hover interactions and for ensuring the cursor animation is consistently used.
   */
  protected async moveCursorTo(selector: string | PwLocator, delay: number = 200, annotationText: string = ""): Promise<PwLocator> {
    return await this.animateCursorToElement(selector, false, delay, annotationText);
  }

  /**
   * Interacts with a vue-select control rooted by a data-testid.
   * This is emitted frequently by the generator; keeping it here reduces per-page duplicated code.
   */
  protected async selectVSelectByTestId(testId: string, value: string, timeOut: number = 500, annotationText: string = ""): Promise<void> {
    const root = this.locatorByTestId(testId);
    const input = root.locator("input");

    await this.moveCursorTo(input, 200, annotationText);
    await input.click({ force: true });
    await this.animateCursorToElementAndClickAndFill(input, value, false, 200, annotationText);
    await this.page.waitForTimeout(timeOut);

    const option = root.locator("ul.vs__dropdown-menu li[role='option']").first();
    if (await option.count()) {
      await this.animateCursorToElement(option, true, 200, annotationText);
    }
  }

  public async fillInputByLocator(locator: PwLocator, text: string, annotationText: string = ""): Promise<void> {
    await this.animateCursorToElementAndClickAndFill(locator, text, true, 200, annotationText);
  }

  protected async clickByAriaLabel(ariaLabel: string, annotationText: string = ""): Promise<void> {
    await this.animateCursorToElement(`[aria-label="${ariaLabel}"]`, true, 200, annotationText);
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
    await this.moveCursorTo(selector);
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

