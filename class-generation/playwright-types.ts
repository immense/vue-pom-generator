import type { Keyboard, Locator, Response, Screencast } from "playwright";


/**
 * Narrow subset of the Playwright {@link Locator} surface that the generated
 * POM runtime (`base-page.ts`, `callout.ts`, `pointer.ts`) and generated page
 * object accessors actually use.
 *
 * Locators flow through many chained calls and the full `Locator` interface has
 * ~70 members — too many to stub in tests. Declaring the dependency as this
 * narrow structural interface lets test doubles satisfy it with a handful of
 * real methods, while a real Playwright `Locator` still satisfies it
 * structurally (it has every member here). Member signatures mirror Playwright's
 * own so call sites and downstream consumers keep working.
 *
 * @see BasePagePage for the narrowed page dependency.
 */
export interface BasePageLocator {
  first(): BasePageLocator;
  last(): BasePageLocator;
  nth(index: number): BasePageLocator;
  locator(
    selector: string,
    options?: { has?: BasePageLocator; hasNot?: BasePageLocator; hasNotText?: string | RegExp; hasText?: string | RegExp },
  ): BasePageLocator;
  describe(description: string): BasePageLocator;
  filter(options?: { has?: BasePageLocator; hasNot?: BasePageLocator; hasNotText?: string | RegExp; hasText?: string | RegExp; visible?: boolean }): BasePageLocator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): BasePageLocator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): BasePageLocator;
  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): BasePageLocator;
  getByAltText(text: string | RegExp, options?: { exact?: boolean }): BasePageLocator;
  getByTitle(text: string | RegExp, options?: { exact?: boolean }): BasePageLocator;
  getByTestId(testId: string | RegExp): BasePageLocator;
  getByRole(
    role: string,
    options?: {
      checked?: boolean;
      description?: string | RegExp;
      disabled?: boolean;
      exact?: boolean;
      expanded?: boolean;
      includeHidden?: boolean;
      level?: number;
      name?: string | RegExp;
      pressed?: boolean;
      selected?: boolean;
    },
  ): BasePageLocator;
  count(): Promise<number>;
  click(options?: { button?: "left" | "right" | "middle"; clickCount?: number; delay?: number; force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number }; timeout?: number; trial?: boolean }): Promise<void>;
  clear(options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number }): Promise<void>;
  fill(value: string, options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number }): Promise<void>;
  hover(options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number }; timeout?: number; trial?: boolean }): Promise<void>;
  press(key: string, options?: { delay?: number; noWaitAfter?: boolean; timeout?: number }): Promise<void>;
  check(options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number; trial?: boolean }): Promise<void>;
  uncheck(options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number; trial?: boolean }): Promise<void>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }): Promise<void>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  isHidden(options?: { timeout?: number }): Promise<boolean>;
  isEnabled(options?: { timeout?: number }): Promise<boolean>;
  isDisabled(options?: { timeout?: number }): Promise<boolean>;
  textContent(options?: { timeout?: number }): Promise<string | null>;
  innerText(options?: { timeout?: number }): Promise<string>;
  innerHTML(options?: { timeout?: number }): Promise<string>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
  boundingBox(options?: { timeout?: number }): Promise<{ x: number; y: number; width: number; height: number } | null>;
  selectOption(
    values: null | string | ReadonlyArray<string> | { value?: string; label?: string; index?: number } | ReadonlyArray<{ value?: string; label?: string; index?: number }>,
    options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number },
  ): Promise<string[]>;
  type(text: string, options?: { delay?: number; noWaitAfter?: boolean; timeout?: number }): Promise<void>;
  evaluate<R>(pageFunction: (element: { tagName: string; isContentEditable?: boolean }) => R | Promise<R>): Promise<R>;
}

/**
 * Narrow subset of the Playwright {@link Page} surface that the generated POM
 * runtime depends on.
 *
 * The full `Page` interface has ~250 members — stubbing them all in tests is
 * large and brittle. This interface declares only the members the runtime and
 * generated page objects use, so test doubles need only a handful of real
 * methods. A real Playwright `Page` still satisfies it structurally.
 *
 * `keyboard` and `screencast` keep their full Playwright types (`Keyboard`,
 * `Screencast`) because those sub-objects are small and exposed verbatim to
 * consumers (e.g. for video recording).
 */
export interface BasePagePage {
  url(): string;
  goto(url: string, options?: { referer?: string; timeout?: number; waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }): Promise<Response | null>;
  locator(selector: string, options?: { has?: BasePageLocator; hasNot?: BasePageLocator; hasNotText?: string | RegExp; hasText?: string | RegExp }): BasePageLocator;
  isVisible(selector: string, options?: { strict?: boolean; timeout?: number }): Promise<boolean>;
  textContent(selector: string, options?: { strict?: boolean; timeout?: number }): Promise<string | null>;
  waitForSelector(selector: string, options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number; strict?: boolean }): Promise<unknown>;
  hover(selector: string, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number }; strict?: boolean; timeout?: number; trial?: boolean }): Promise<void>;
  selectOption(
    selector: string,
    values: null | string | ReadonlyArray<string> | { value?: string; label?: string; index?: number } | ReadonlyArray<{ value?: string; label?: string; index?: number }>,
    options?: { force?: boolean; noWaitAfter?: boolean; strict?: boolean; timeout?: number },
  ): Promise<string[]>;
  waitForTimeout(timeout: number): Promise<void>;
  evaluate<R, Arg = never>(pageFunction: string | ((arg: Arg) => R | Promise<R>), arg?: Arg): Promise<R>;
  readonly keyboard: Keyboard;
  readonly screencast: Screencast;
}

/**
 * Page dependency type used by the generated POM runtime. Narrowed from
 * Playwright's full `Page` to {@link BasePagePage} so test doubles can satisfy
 * it without stubbing hundreds of members. A real `Page` is still assignable.
 */
export type PwPage = BasePagePage;

/**
 * Locator type used by the generated POM runtime. Narrowed from Playwright's
 * full `Locator` to {@link BasePageLocator} so test doubles can satisfy it
 * without stubbing ~70 members. A real `Locator` is still assignable.
 *
 * Note: this narrowed type is used for the runtime's *internal* parameters
 * (what doubles must satisfy). The locator-*returning* accessors
 * (`locatorByTestId`, `keyedLocators`, …) widen back to Playwright's full
 * `Locator` at the boundary so generated accessors can be passed straight to
 * `expect(...)` (`expect(page.SaveButton).toBeVisible()`) — Playwright's
 * `LocatorAssertions` matchers are keyed on `Locator`.
 */
export type PwLocator = BasePageLocator;

export type { Keyboard, Screencast };

export type PwSelectOption = string | { value?: string; label?: string; index?: number };
