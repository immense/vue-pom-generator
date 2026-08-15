export interface PomNavigationTarget {
  name: string;
  params: Record<string, unknown>;
  query?: Record<string, unknown>;
}

export interface PomNavigationRouter {
  // The bridge only stores the router. Generated POMs own the concrete named-route
  // payload, so keep these callable constraints broad enough for Vue Router's overloads.
  push: (...args: never[]) => object | undefined;
  resolve: (...args: never[]) => { href: string };
  isReady: () => Promise<void>;
}

export type PomNavigationStatus = "pending" | "succeeded" | "failed";
export type PomNavigationStage = "waiting-for-router-ready" | "pushing-route" | "complete";

export interface PomNavigationState {
  id: number;
  status: PomNavigationStatus;
  stage: PomNavigationStage;
  targetName: string;
  error?: string;
}

export interface PomNavigationBridge {
  navigation: PomNavigationState | undefined;
  beginNavigation: (target: PomNavigationTarget) => number;
}

/** Global key shared by the runtime bridge and generated `goTo()` methods. */
export const POM_ROUTER_GLOBAL_NAME = "__vuePomGeneratorRouter";

function describeNavigationError<T>(error: T): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  }
  catch {
    return String(error);
  }
}

/**
 * Exposes a live application router to generated POM navigation methods.
 * Call this from the application entry point in environments where Playwright runs.
 */
export function exposeRouterForPomNavigation(router: PomNavigationRouter): void {
  let nextNavigationId = 0;
  const bridge: PomNavigationBridge = {
    navigation: undefined,
    beginNavigation(target) {
      const navigation: PomNavigationState = {
        id: ++nextNavigationId,
        status: "pending",
        stage: "waiting-for-router-ready",
        targetName: target.name,
      };
      bridge.navigation = navigation;

      // Keep the router's promise owned by application code. Returning it through
      // page.evaluate lets the browser collect a still-pending promise before the
      // automation protocol observes its result.
      void (async () => {
        try {
          await router.isReady();
          navigation.stage = "pushing-route";
          await Reflect.apply(router.push, router, [target]);
          navigation.status = "succeeded";
          navigation.stage = "complete";
        }
        catch (error) {
          navigation.status = "failed";
          navigation.stage = "complete";
          navigation.error = describeNavigationError(error);
        }
      })();

      return navigation.id;
    },
  };

  Object.assign(globalThis, { [POM_ROUTER_GLOBAL_NAME]: bridge });
}
