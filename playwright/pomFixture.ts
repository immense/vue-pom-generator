/**
 * Playwright POM fixture utilities.
 *
 * This file is authored in the injector package and is also copied into the
 * repo's generated Playwright fixture output.
 */

import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

export type PlaywrightAnimationOptions = false | {
  pointer?: {
    durationMilliseconds?: number;
    transitionStyle?: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out";
    clickDelayMilliseconds?: number;
  };
  keyboard?: {
    typeDelayMilliseconds?: number;
  };
};

export interface PlaywrightOptions {
  /**
   * Global animation configuration.
   *
   * - false => skip animations
   * - object => configure pointer + keyboard pacing
   */
  animation: PlaywrightAnimationOptions;
}

type PageObjectConstructor<T> = new (page: Page) => T;

type RouteParamValue = string | number;


const animationGlobalKey = "__VUE_TESTID_PLAYWRIGHT_ANIMATION__";
const routePathsGlobalKey = "__VUE_TESTID_ROUTE_PATHS__";

type RoutePathsByComponent = Record<string, readonly string[]>;

function getRoutePathsByComponent(): RoutePathsByComponent {
  const fromGlobal = Reflect.get(globalThis, routePathsGlobalKey) as RoutePathsByComponent | undefined;
  if (!fromGlobal || typeof fromGlobal !== "object") {
    throw new Error("[pomFixture] Route paths are not available. Import the generated POM index before using pomFixture.");
  }
  return fromGlobal;
}

function fillRouteParams(routePath: string, params: Record<string, RouteParamValue> | undefined): string {
  if (!params)
    return routePath;

  const isIdentChar = (c: string) => {
    const code = c.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    return isUpper || isLower || isDigit || c === "_";
  };

  let out = "";
  const len = routePath.length;
  let i = 0;

  while (i < len) {
    const ch = routePath[i];
    if (ch !== ":") {
      out += ch;
      i++;
      continue;
    }

    let j = i + 1;
    let key = "";
    while (j < len && isIdentChar(routePath[j])) {
      key += routePath[j];
      j++;
    }

    // If we didn't actually parse a key, treat ':' as a literal.
    if (!key) {
      out += ch;
      i++;
      continue;
    }

    const value = params[key];
    if (value === undefined)
      throw new Error(`[pomFixture] Missing route param :${key} for path ${routePath}`);

    out += encodeURIComponent(String(value));
    i = j;
  }

  return out;
}

async function resolveRoutePathForCtor<T>(PageObject: PageObjectConstructor<T>): Promise<string> {
  const componentName = PageObject.name;
  const paths = [...(getRoutePathsByComponent()[componentName] ?? [])];

  if (!paths.length) {
    throw new Error(`[pomFixture] No router path found for component/page-object '${componentName}'.`);
  }

  // Prefer routes with no required params.
  const noParamPaths = paths.filter(p => !p.includes(":"));
  const candidates = noParamPaths.length ? noParamPaths : paths;

  // Prefer the shortest (usually the canonical) path.
  candidates.sort((a: string, b: string) => a.length - b.length || a.localeCompare(b));
  return candidates[0];
}

const test = base.extend<{
  pom: {
    create: <T>(PageObject: PageObjectConstructor<T>) => T;

    /**
     * Open either:
     * - a literal url (url + ctor), or
     * - the canonical router path for a page object (ctor [+ params]).
     */
    open: {
      <T>(url: string, PageObject: PageObjectConstructor<T>): Promise<T>;
      <T>(PageObject: PageObjectConstructor<T>, options?: { params?: Record<string, RouteParamValue> }): Promise<T>;
    };

    /** Navigate to the canonical router path for a page object constructor (no allocation). */
    goto: <T>(PageObject: PageObjectConstructor<T>, options?: { params?: Record<string, RouteParamValue> }) => Promise<void>;
  };
} & PlaywrightOptions>({
  // Allows overriding from playwright.config.ts via `use: { animation: ... }`.
  animation: [{
    pointer: { durationMilliseconds: 250, transitionStyle: "ease-in-out", clickDelayMilliseconds: 0 },
    keyboard: { typeDelayMilliseconds: 100 },
  }, { option: true }],

  pom: async ({ page, animation }, use) => {
    // Make available to POM runtime code without needing to thread options through every constructor.
    Reflect.set(globalThis, animationGlobalKey, animation);

    const create = <T>(PageObject: PageObjectConstructor<T>) => new PageObject(page);

    const goto = async <T>(PageObject: PageObjectConstructor<T>, options?: { params?: Record<string, RouteParamValue> }) => {
      const routePath = await resolveRoutePathForCtor(PageObject);
      const resolvedPath = fillRouteParams(routePath, options?.params);
      await page.goto(resolvedPath);
    };

    async function open<T>(url: string, PageObject: PageObjectConstructor<T>): Promise<T>;
    async function open<T>(PageObject: PageObjectConstructor<T>, options?: { params?: Record<string, RouteParamValue> }): Promise<T>;
    async function open<T>(arg1: string | PageObjectConstructor<T>, arg2?: PageObjectConstructor<T> | { params?: Record<string, RouteParamValue> }): Promise<T> {
      if (typeof arg1 === "string") {
        const url = arg1;
        const PageObject = arg2 as PageObjectConstructor<T> | undefined;
        if (!PageObject)
          throw new Error("[pomFixture] pom.open(url, ctor) requires a constructor");

        await page.goto(url);
        return new PageObject(page);
      }

      const PageObject = arg1;
      const options = arg2 as { params?: Record<string, RouteParamValue> } | undefined;
      await goto(PageObject, options);
      return new PageObject(page);
    }

    await use({ create, open, goto });
  },
});

export { expect, test };
