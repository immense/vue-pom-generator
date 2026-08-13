import { afterEach, describe, expect, it } from "vitest";

import {
  exposeRouterForPomNavigation,
  POM_ROUTER_GLOBAL_NAME,
  type PomNavigationRouter,
} from "../router-bridge";

describe("router bridge", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, POM_ROUTER_GLOBAL_NAME);
  });

  it("exposes the live router under the key used by generated POMs", () => {
    const router: PomNavigationRouter = {
      push: () => undefined,
      resolve: () => ({ href: "/persons/1" }),
    };

    exposeRouterForPomNavigation(router);

    expect(Reflect.get(globalThis, POM_ROUTER_GLOBAL_NAME)).toBe(router);
  });
});
