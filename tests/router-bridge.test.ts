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

  it("tracks successful navigation without returning the router promise", async () => {
    let resolvePush!: () => void;
    const pushPromise = new Promise<void>((resolve) => {
      resolvePush = resolve;
    });
    const router: PomNavigationRouter = {
      push: () => pushPromise,
      resolve: () => ({ href: "/persons/1" }),
      isReady: async () => {},
    };

    exposeRouterForPomNavigation(router);

    const bridge = Reflect.get(globalThis, POM_ROUTER_GLOBAL_NAME);
    const navigationId = bridge.beginNavigation({ name: "persons", params: { id: 1 } });

    expect(navigationId).toBe(1);
    expect(bridge.navigation).toMatchObject({
      id: 1,
      status: "pending",
      stage: "waiting-for-router-ready",
      targetName: "persons",
    });

    resolvePush();
    await pushPromise;
    await Promise.resolve();

    expect(bridge.navigation).toMatchObject({
      id: 1,
      status: "succeeded",
      stage: "complete",
      targetName: "persons",
    });
  });

  it("identifies a navigation blocked on initial router readiness", async () => {
    const routerReady = new Promise<void>(() => {});
    const router: PomNavigationRouter = {
      push: () => Promise.resolve(),
      resolve: () => ({ href: "/records" }),
      isReady: () => routerReady,
    };

    exposeRouterForPomNavigation(router);

    const bridge = Reflect.get(globalThis, POM_ROUTER_GLOBAL_NAME);
    bridge.beginNavigation({ name: "records", params: {} });
    await Promise.resolve();

    expect(bridge.navigation).toEqual({
      id: 1,
      status: "pending",
      stage: "waiting-for-router-ready",
      targetName: "records",
    });
  });

  it("serializes rejected router navigation for generated POMs", async () => {
    const router: PomNavigationRouter = {
      push: () => Promise.reject(new Error("guard rejected navigation")),
      resolve: () => ({ href: "/persons/1" }),
      isReady: async () => {},
    };

    exposeRouterForPomNavigation(router);

    const bridge = Reflect.get(globalThis, POM_ROUTER_GLOBAL_NAME);
    bridge.beginNavigation({ name: "persons", params: { id: 1 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.navigation.status).toBe("failed");
    expect(bridge.navigation.stage).toBe("complete");
    expect(bridge.navigation.error).toContain("guard rejected navigation");
  });
});
