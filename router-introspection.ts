import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { toPascalCase } from "./utils";
import type { Router, RouteLocationNormalizedLoaded, RouteRecordNormalized } from "vue-router";
import { JSDOM } from "jsdom";
import type { Plugin as VitePlugin } from "vite";

function debugLog(message: string) {
  if (process.env.VUE_TESTID_DEBUG === "1") {
    console.log(`[vue-pom-generator][router-introspection] ${message}`);
  }
}

function createRouterIntrospectionVueStubPlugin(options: { routerEntryAbs: string }): VitePlugin {
  const routerEntryAbs = path.resolve(options.routerEntryAbs);
  return {
    name: "vue-testid-router-introspection-vue-stub",
    enforce: "pre",
    load(id) {
      // Vite passes plugin `load(id)` a *resolved* id. In practice this is usually a normalized absolute
      // filesystem path (posix separators) or a Vite fs-prefixed path like `/@fs/<abs>`, optionally with
      // a query string (e.g. `?v=...`). Virtual ids (starting with `\0`) may also appear.
      //
      // During router introspection we want to:
      // - Allow loading the router entry itself
      // - Stub `.vue` imports with a minimal component object
      // - Reject everything else (especially node_modules)

      // Strip query string (e.g. ?v=... or ?import).
      const queryIndex = id.indexOf("?");
      const cleanId = queryIndex === -1 ? id : id.slice(0, queryIndex);

      // Virtual modules should not be handled here.
      if (cleanId.startsWith("\0"))
        return null;

      // During SSR evaluation Vite may pass internal ids that are not filesystem paths.
      // Let Vite handle those rather than throwing and aborting router introspection.
      if (
        cleanId.startsWith("node:")
        || cleanId.startsWith("virtual:")
        || cleanId.startsWith("vite:")
        || cleanId.startsWith("/@id/")
      ) {
        return null;
      }

      // Handle Vite /@fs/ prefix (absolute filesystem path outside root).
      const fsPath = cleanId.startsWith("/@fs/") ? cleanId.slice("/@fs/".length) : cleanId;

      // Always allow the router entry itself to be loaded by Vite/Node.
      // Note: Vite may normalize paths with posix separators. We always compare resolved absolute paths.
      if (path.isAbsolute(fsPath) && path.resolve(fsPath) === routerEntryAbs)
        return null;

      // If this still isn't a filesystem absolute path, it's not something we should stub.
      // Returning null means "not handled".
      if (!path.isAbsolute(fsPath))
        return null;

      // Disallow anything from node_modules during router introspection.
      // This keeps SSR evaluation from pulling in problematic CJS/Esm interop (e.g. devextreme).
      if (fsPath.includes(`${path.sep}node_modules${path.sep}`) || fsPath.includes("/node_modules/"))
        throw new Error(`[vue-pom-generator][router-introspection] Unsupported node_modules import during router introspection: ${cleanId}`);

      const parsed = path.parse(fsPath);

      // Only `.ts/.tsx` (router code) and `.vue` (stubs) are permitted.
      if (parsed.ext !== ".vue") {
        if (parsed.ext === ".ts" || parsed.ext === ".tsx")
          return null;
        throw new Error(`[vue-pom-generator][router-introspection] Unsupported module during router introspection: ${cleanId}`);
      }

      // Minimal Vue component stub. Preserve __file so downstream can infer a component name.
      const componentName = path.basename(parsed.base, ".vue");
      return `export default { name: ${JSON.stringify(componentName)}, __file: ${JSON.stringify(cleanId)} }`;
    },
  };
}

export interface RouterIntrospectionResult {
  routeNameMap: Map<string, string>;
  routePathMap: Map<string, string>;
  routeMetaEntries: Array<{
    componentName: string;
    pathTemplate: string;
    params: Array<{ name: string; optional: boolean }>;
    query: string[];
  }>;
}

interface HistoryLike {
  pushState: (...args: never[]) => void;
  replaceState: (...args: never[]) => void;
}

interface GlobalDomShim {
  // JSDOM's DOMWindow is not assignable to TS lib.dom Window, so keep this structural.
  window?: object;
  document?: Document;
  location?: object;
  navigator?: object;
  history?: HistoryLike;
  MutationObserver?: object;
  ResizeObserver?: object;
  IntersectionObserver?: object;
  // In browsers these typically return a number; in Node our polyfills return the value from setTimeout.
  requestIdleCallback?: (cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void) => number | ReturnType<typeof setTimeout>;
  requestAnimationFrame?: (cb: (time: number) => void) => number | ReturnType<typeof setTimeout>;
  localStorage?: Storage;
  sessionStorage?: Storage;
  [key: string]:
    | object
    | string
    | number
    | boolean
    | null
    | undefined
    | ((...args: never[]) => object);
}

type DocumentWithQueryCommandSupported = Document & {
  queryCommandSupported?: (commandId: string) => boolean;
};

interface VueComponentLike {
  __file?: string;
  __name?: string;
  name?: string;
}

type RoutePropPrimitive = string | number | boolean | null | undefined;
type RoutePropsFunction = (route: RouteLocationNormalizedLoaded) => Record<string, RoutePropPrimitive> | void;
type RoutePropsValue = boolean | Record<string, RoutePropPrimitive> | RoutePropsFunction;
type RoutePropsContainer = RoutePropsValue | { default?: RoutePropsValue };

const PARAM_TOKEN_PREFIX = "__VUE_TESTID_PARAM__";

function getParamToken(name: string) {
  return `${PARAM_TOKEN_PREFIX}${name}__`;
}

function collectRoutePropKeysFromFunction(propsFn: RoutePropsFunction) {
  const paramKeys = new Set<string>();
  const queryKeys = new Set<string>();

  const paramsProxy = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === "string")
        paramKeys.add(prop);
      return undefined;
    },
  });

  const queryProxy = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === "string")
        queryKeys.add(prop);
      return undefined;
    },
  });

  const routeProxy = new Proxy({ params: paramsProxy, query: queryProxy }, {
    get(target, prop) {
      if (prop in target)
        return target[prop as keyof typeof target];
      return undefined;
    },
  });

  try {
    propsFn(routeProxy as RouteLocationNormalizedLoaded);
  }
  catch {
    // Ignore errors; we only care about which props are accessed.
  }

  return {
    paramKeys: Array.from(paramKeys).sort((a, b) => a.localeCompare(b)),
    queryKeys: Array.from(queryKeys).sort((a, b) => a.localeCompare(b)),
  };
}

function getRoutePropsKeys(record: RouteRecordNormalized) {
  const props = record.props as RoutePropsContainer | undefined;
  if (!props) {
    return { paramKeys: [], queryKeys: [] };
  }

  const normalized = (typeof props === "object" && "default" in props)
    ? (props as { default?: RoutePropsValue }).default
    : props;

  if (typeof normalized === "function")
    return collectRoutePropKeysFromFunction(normalized as RoutePropsFunction);

  if (normalized === true) {
    // props: true -> all route.params, but we don't know keys without parsing the path.
    return { paramKeys: [], queryKeys: [] };
  }

  if (typeof normalized === "object") {
    // Static props object; no route params/query used.
    return { paramKeys: [], queryKeys: [] };
  }

  return { paramKeys: [], queryKeys: [] };
}

function buildRouteTemplate(router: Router, record: RouteRecordNormalized, paramNames: string[]) {
  if (typeof record.name !== "string" || !record.name.length) {
    return record.path;
  }

  const params = Object.fromEntries(paramNames.map((name) => [name, getParamToken(name)]));
  try {
    return router.resolve({ name: record.name, params }).path;
  }
  catch {
    return record.path;
  }
}

function getRouteParamMeta(router: Router, record: RouteRecordNormalized, paramNames: string[]) {
  if (typeof record.name !== "string" || !record.name.length) {
    return paramNames.map((name) => ({ name, optional: false }));
  }

  const paramsWithAll = Object.fromEntries(paramNames.map((name) => [name, getParamToken(name)]));
  return paramNames.map((name) => {
    const params = { ...paramsWithAll } as Record<string, string>;
    delete params[name];
    try {
      router.resolve({ name: record.name as string, params });
      return { name, optional: true };
    }
    catch {
      return { name, optional: false };
    }
  });
}

function getComponentNameFromRouteRecord(record: RouteRecordNormalized): string | null {
  // Vue Router's normalized record has `components` (plural) where `default` is the main view component.
  const comp = record.components?.default as VueComponentLike | undefined;
  if (!comp)
    return null;

  // When compiled by Vite, SFCs usually have an `__file` pointing at the source file.
  if (typeof comp.__file === "string" && comp.__file.length) {
    const base = path.posix.basename(path.posix.normalize(comp.__file));
    if (base.toLowerCase().endsWith(".vue"))
      return base.slice(0, -".vue".length);
  }

  // Fallbacks (less stable / may be minified):
  if (typeof comp.__name === "string" && comp.__name.length)
    return comp.__name;
  if (typeof comp.name === "string" && comp.name.length)
    return comp.name;
  return null;
}

async function ensureDomShim() {
  const domShimHtml = "<!doctype html><html><head></head><body><div id='app'></div></body></html>";
  const domShimUrl = "https://example.test/";

  // NOTE: JSDOM's DOMWindow is not assignable to the TS lib.dom Window, but at runtime it behaves well enough
  // for our use (router creation + route enumeration).
  const g = globalThis as GlobalDomShim;
  if (typeof document !== "undefined" && typeof window !== "undefined")
    return;

  const dom = new JSDOM(domShimHtml, { url: domShimUrl });

  g.window = dom.window;
  g.document = dom.window.document;
  g.location = dom.window.location;
  if (!g.self)
    g.self = dom.window;
  if (!g.navigator)
    g.navigator = dom.window.navigator;
  if (!g.history)
    g.history = { pushState() {}, replaceState() {} };

  if (!g.MutationObserver) {
    g.MutationObserver = class {
      disconnect() {}
      observe() {}
      takeRecords() { return []; }
    };
  }
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      disconnect() {}
      observe() {}
      unobserve() {}
    };
  }
  if (!g.IntersectionObserver) {
    g.IntersectionObserver = class {
      disconnect() {}
      observe() {}
      unobserve() {}
      takeRecords() { return []; }
    };
  }
  if (!g.requestIdleCallback) {
    g.requestIdleCallback = cb => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 1);
  }

  // Some editor / rich text libs probe this legacy API.
  const doc = g.document as DocumentWithQueryCommandSupported | undefined;
  if (doc && typeof doc.queryCommandSupported !== "function") {
    doc.queryCommandSupported = () => false;
  }
  if (!g.localStorage || !g.sessionStorage) {
    const storageFactory = () => {
      const store = new Map<string, string>();
      return {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
      } as Storage;
    };
    if (!g.localStorage)
      g.localStorage = storageFactory();
    if (!g.sessionStorage)
      g.sessionStorage = storageFactory();
  }

  // Copy common DOM constructor globals onto globalThis. Many browser-oriented libs assume these
  // exist as globals (e.g. HTMLAnchorElement, UIEvent) even when running under Node.
  const names = Object.getOwnPropertyNames(dom.window);
  const shouldCopyGlobal = (name: string) => {
    if (name === "Node" || name === "Element" || name === "Document" || name === "Event" || name === "EventTarget")
      return true;
    if (name.endsWith("Event"))
      return true;
    if (name.startsWith("HTML") && name.endsWith("Element"))
      return true;
    if (name.startsWith("SVG") && name.endsWith("Element"))
      return true;
    return false;
  };

  for (const name of names) {
    if (!shouldCopyGlobal(name) || g[name])
      continue;

    const value = Reflect.get(dom.window, name);
    if (value)
      g[name] = value;
  }

  if (!g.requestAnimationFrame)
    g.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 16);
}

/**
 * Loads this repo's `src/router.ts` via Vite's SSR module loader and asks Vue Router
 * for its normalized routes.
 *
 * This replaces the previous regex-based parsing so we can support nested route shapes,
 * redirects, and any non-trivial route record composition without maintaining a parser.
 */
export async function parseRouterFileFromCwd(routerEntryPath: string): Promise<RouterIntrospectionResult> {
  const routerEntry = path.resolve(routerEntryPath);
  if (!fs.existsSync(routerEntry)) {
    throw new Error(`[vue-pom-generator] Router entry not found at ${routerEntry}.`);
  }

  const cwd = path.dirname(routerEntry);

  await ensureDomShim();

  debugLog(`parseRouterFileFromCwd cwd=${cwd}`);

  // Dynamically import Vite to keep this file Node-only and avoid bundling Vite into consumers.
  const vite = await import("vite") as { createServer: typeof import("vite")["createServer"] };

  // IMPORTANT:
  // When vue-pom-generator is included as a plugin inside the frontend Vite config, calling
  // Vite's `createServer()` with the default behavior will read `vite.config.ts` again.
  // Since `vite.config.ts` imports this plugin, that can create a recursive config-load loop.
  //
  // We avoid that by setting `configFile: false` and providing the minimal config we need to
  // SSR-load `src/router.ts` (mainly alias + Vue SFC plugin).
  const server = await vite.createServer({
    root: cwd,
    configFile: false,
    logLevel: "error",
    // This server is created only to SSR-load the router module. Disable HMR/WebSocket
    // to avoid port conflicts in dev/test environments.
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    // IMPORTANT:
    // This internal, short-lived Vite server exists only to `ssrLoadModule()` the router entry.
    // We close it immediately after reading routes.
    //
    // Vite's dependency optimizer (vite:dep-scan / optimizeDeps) runs asynchronously and can
    // still have pending resolve requests when we call `server.close()`, which surfaces as:
    //   "The server is being restarted or closed. Request is outdated [plugin vite:dep-scan]"
    //
    // Disable optimizeDeps entirely for this internal server to avoid that race.
    optimizeDeps: {
      disabled: true,
    },
    resolve: {
      alias: {
        "@": cwd,
      },
    },
    // Important: Do NOT include @vitejs/plugin-vue here.
    // We stub all `.vue` imports ourselves, and including the Vue plugin would attempt to parse
    // those stubbed modules as real SFCs (and fail).
    plugins: [createRouterIntrospectionVueStubPlugin({ routerEntryAbs: routerEntry })],
  });

  try {
    // Use a file URL so we don't depend on platform-specific path separators.
    // Vite can SSR-load file URLs and will treat this as an absolute module id.
    const moduleId = pathToFileURL(routerEntry).href;

    debugLog(`ssrLoadModule(${moduleId}) start`);
    const mod = await server.ssrLoadModule(moduleId) as { default?: () => Router };
    debugLog(`ssrLoadModule(${moduleId}) done; hasDefault=${typeof mod?.default === "function"}`);
    const makeRouter = mod?.default;
    if (typeof makeRouter !== "function") {
      throw new TypeError(`[vue-pom-generator] ${routerEntry} must export a default router factory function (export default makeRouter).`);
    }

    let router: Router;
    try {
      router = makeRouter();
    }
    catch (err) {
      throw new Error(`[vue-pom-generator] makeRouter() invocation failed: ${String(err)}`);
    }
    const routeNameMap = new Map<string, string>();
    const routePathMap = new Map<string, string>();
    const routeMetaEntries: RouterIntrospectionResult["routeMetaEntries"] = [];

    for (const r of router.getRoutes()) {
      const componentName = getComponentNameFromRouteRecord(r);
      if (!componentName)
        continue;

      if (typeof r.path === "string" && r.path.length) {
        routePathMap.set(r.path, componentName);
      }

      if (typeof r.name === "string" && r.name.length) {
        const key = toPascalCase(r.name);
        routeNameMap.set(key, componentName);
      }

      const { paramKeys, queryKeys } = getRoutePropsKeys(r);
      const paramsMeta = getRouteParamMeta(router, r, paramKeys);
      const pathTemplate = buildRouteTemplate(router, r, paramsMeta.map((p) => p.name));
      if (typeof pathTemplate === "string" && pathTemplate.length) {
        routeMetaEntries.push({
          componentName,
          pathTemplate,
          params: paramsMeta,
          query: queryKeys,
        });
      }
    }

    return { routeNameMap, routePathMap, routeMetaEntries };
  }
  finally {
    debugLog("closing internal vite server");
    await server.close();
  }
}
