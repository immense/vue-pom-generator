export interface PomNavigationTarget {
  name: string;
  params: Record<string, unknown>;
}

export interface PomNavigationRouter {
  // The bridge only stores the router. Generated POMs own the concrete named-route
  // payload, so keep these callable constraints broad enough for Vue Router's overloads.
  push: (...args: never[]) => object | undefined;
  resolve: (...args: never[]) => { href: string };
}

/** Global key shared by the runtime bridge and generated `goTo()` methods. */
export const POM_ROUTER_GLOBAL_NAME = "__vuePomGeneratorRouter";

/**
 * Exposes a live application router to generated POM navigation methods.
 * Call this from the application entry point in environments where Playwright runs.
 */
export function exposeRouterForPomNavigation(router: PomNavigationRouter): void {
  Object.assign(globalThis, { [POM_ROUTER_GLOBAL_NAME]: router });
}
