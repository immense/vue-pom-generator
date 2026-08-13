export interface PomNavigationTarget {
  name: string;
  params: Record<string, unknown>;
}

export interface PomNavigationRouter {
  push: (to: PomNavigationTarget) => unknown | Promise<unknown>;
  resolve: (to: PomNavigationTarget) => { href: string };
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
