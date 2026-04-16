import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Plugin as VitePlugin } from "vite";
import type { RouteLocationNormalizedLoaded, Router, RouteRecordNormalized } from "vue-router";
import { resolveComponentNameFromPath } from "./plugin/path-utils";
import { isAsciiDigitCode, isAsciiLetterCode, toPascalCase } from "./utils";

// Router introspection spins up a short-lived Vite SSR server and installs a global DOM shim.
// When called concurrently (e.g. multiple Vitest files running in parallel), those operations can
// interfere with each other and lead to hangs/timeouts. Serialize calls within a single process.
let routerIntrospectionQueue: Promise<void> = Promise.resolve();

async function runRouterIntrospectionExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prev = routerIntrospectionQueue.catch(() => undefined);
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  routerIntrospectionQueue = prev.then(() => next);

  await prev;
  try {
    return await fn();
  }
  finally {
    release();
  }
}

function debugLog(message: string) {
  if (process.env.VUE_TESTID_DEBUG === "1") {
    console.log(`[vue-pom-generator][router-introspection] ${message}`);
  }
}

export interface RouterIntrospectionOptions {
  /**
   * Optional module-source -> shim definition map used only while SSR-loading the router entry.
   * This allows consumers to stub browser-only or heavy modules during route enumeration.
   */
  moduleShims?: Record<string, RouterModuleShimDefinition>;
  /**
   * Optional naming configuration used to translate routed Vue file paths into the same
   * canonical component names that the generator uses for emitted POM classes.
   */
  componentNaming?: {
    projectRoot: string;
    viewsDirAbs: string;
    sourceDirs: string[];
    extraRoots?: string[];
  };
}

type RouterModuleShimPrimitive = string | number | boolean | null | undefined;
export type RouterModuleShimFunction = (...args: Array<object | RouterModuleShimPrimitive>) => object | RouterModuleShimPrimitive;
export type RouterModuleShimDefinition = string[] | Record<string, RouterModuleShimFunction>;

type RouterModuleShimExports = Record<string, RouterModuleShimFunction>;

interface GlobalRouterModuleShimRegistry {
  __VUE_TESTID_ROUTER_INTROSPECTION_SHIMS__?: Record<string, RouterModuleShimExports>;
}

function isIdentifierStartCode(code: number) {
  return code === 95 || code === 36 || isAsciiLetterCode(code);
}

function isIdentifierPartCode(code: number) {
  return isIdentifierStartCode(code) || isAsciiDigitCode(code);
}

function isValidJsIdentifier(name: string) {
  if (!name.length)
    return false;
  const first = name.charCodeAt(0);
  if (!isIdentifierStartCode(first))
    return false;
  for (let i = 1; i < name.length; i++) {
    if (!isIdentifierPartCode(name.charCodeAt(i)))
      return false;
  }
  return true;
}

function assertValidNamedExportName(exportName: string, moduleSource: string) {
  if (exportName === "default")
    return;
  if (!isValidJsIdentifier(exportName)) {
    throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}] contains invalid export name ${JSON.stringify(exportName)}.`);
  }
}

function createNoopShimFunction(): RouterModuleShimFunction {
  type NoopShimCallable = RouterModuleShimFunction & { [key: string]: NoopShimCallable };
  let value!: NoopShimCallable;
  const base = (() => value) as NoopShimCallable;
  value = new Proxy(base, {
    apply() {
      return value;
    },
    get() {
      return value;
    },
  });
  return value;
}

function normalizeRouterIntrospectionModuleShims(moduleShims: RouterIntrospectionOptions["moduleShims"]) {
  if (!moduleShims)
    return {};

  if (typeof moduleShims !== "object" || Array.isArray(moduleShims)) {
    throw new TypeError("[vue-pom-generator] router moduleShims must be an object map of module source -> shim definition.");
  }

  const normalized: Record<string, RouterModuleShimExports> = {};
  for (const [moduleSource, shimDefinition] of Object.entries(moduleShims)) {
    if (!moduleSource.trim()) {
      throw new TypeError("[vue-pom-generator] router moduleShims contains an empty module source key.");
    }

    if (Array.isArray(shimDefinition)) {
      if (!shimDefinition.length) {
        throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}] must contain at least one export name.`);
      }
      const exports: RouterModuleShimExports = {};
      for (const exportName of shimDefinition) {
        if (!exportName.trim()) {
          throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}] contains an empty export name.`);
        }
        if (exportName === "*") {
          throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}] does not support '*' export wildcard.`);
        }
        assertValidNamedExportName(exportName, moduleSource);
        exports[exportName] = createNoopShimFunction();
      }
      normalized[moduleSource] = exports;
      continue;
    }

    if (!shimDefinition || typeof shimDefinition !== "object") {
      throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}] must be a string[] or export->function map.`);
    }

    const entries = Object.entries(shimDefinition);
    if (!entries.length) {
      throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}] must contain at least one export.`);
    }

    const exports: RouterModuleShimExports = {};
    for (const [exportName, shimValue] of entries) {
      if (!exportName.trim()) {
        throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}] contains an empty export name.`);
      }
      if (exportName === "*") {
        throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}] does not support '*' export wildcard.`);
      }
      assertValidNamedExportName(exportName, moduleSource);
      if (typeof shimValue !== "function") {
        throw new TypeError(`[vue-pom-generator] router moduleShims[${JSON.stringify(moduleSource)}][${JSON.stringify(exportName)}] must be a function.`);
      }
      exports[exportName] = shimValue;
    }

    normalized[moduleSource] = exports;
  }
  return normalized;
}

function normalizeModuleResolutionKey(value: string) {
  let normalized = "";
  for (const character of value) {
    normalized += character === "\\" ? "/" : character;
  }
  return path.posix.normalize(normalized);
}

function createRouterIntrospectionVueStubPlugin(options: { routerEntryAbs: string; moduleShims?: Record<string, RouterModuleShimExports> }): VitePlugin {
  const routerEntryAbs = path.resolve(options.routerEntryAbs);
  const normalizedRouterEntryAbs = normalizeModuleResolutionKey(routerEntryAbs);
  const projectRoot = path.dirname(routerEntryAbs);
  const shimVirtualIdPrefix = "\0vue-testid-router-introspection-shim:";
  const shimVirtualIdsBySource = new Map<string, string>();
  const shimExportsByVirtualId = new Map<string, RouterModuleShimExports>();
  const addShimMatcher = (source: string, virtualId: string) => {
		shimVirtualIdsBySource.set(normalizeModuleResolutionKey(source), virtualId);
  };

  for (const [moduleSource, shimExports] of Object.entries(options.moduleShims ?? {})) {
    const virtualId = `${shimVirtualIdPrefix}${encodeURIComponent(moduleSource)}`;
    addShimMatcher(moduleSource, virtualId);
    if (moduleSource.startsWith("@/")) {
      const withoutAlias = moduleSource.slice(2);
      const absoluteNoExt = path.resolve(projectRoot, withoutAlias);
      addShimMatcher(absoluteNoExt, virtualId);
      addShimMatcher(`${absoluteNoExt}.ts`, virtualId);
      addShimMatcher(`${absoluteNoExt}.tsx`, virtualId);
      addShimMatcher(`${absoluteNoExt}.js`, virtualId);
      addShimMatcher(`${absoluteNoExt}.mjs`, virtualId);
      addShimMatcher(`${absoluteNoExt}.cjs`, virtualId);
    }
    shimExportsByVirtualId.set(virtualId, shimExports);
  }

  return {
    name: "vue-testid-router-introspection-vue-stub",
    enforce: "pre",
    resolveId(source) {
      const virtualId = shimVirtualIdsBySource.get(normalizeModuleResolutionKey(source));
      if (virtualId)
        return virtualId;
      return null;
    },
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

      const shimExports = shimExportsByVirtualId.get(cleanId);
      if (shimExports) {
        const globalRegistry = globalThis as GlobalRouterModuleShimRegistry;
        if (!globalRegistry.__VUE_TESTID_ROUTER_INTROSPECTION_SHIMS__)
          globalRegistry.__VUE_TESTID_ROUTER_INTROSPECTION_SHIMS__ = {};
        globalRegistry.__VUE_TESTID_ROUTER_INTROSPECTION_SHIMS__[cleanId] = shimExports;

        const sortedExportNames = Object.keys(shimExports).sort((a, b) => a.localeCompare(b));
        const lines = [
          `const __shim = globalThis.__VUE_TESTID_ROUTER_INTROSPECTION_SHIMS__[${JSON.stringify(cleanId)}];`,
        ];
        for (const exportName of sortedExportNames) {
          if (exportName === "default")
            continue;
          lines.push(`export const ${exportName} = __shim[${JSON.stringify(exportName)}];`);
        }
        if (sortedExportNames.includes("default"))
          lines.push(`export default __shim[${JSON.stringify("default")}];`);
        return lines.join("\n");
      }

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
      const normalizedFsPath = path.isAbsolute(fsPath) ? normalizeModuleResolutionKey(path.resolve(fsPath)) : normalizeModuleResolutionKey(fsPath);

      // Always allow the router entry itself to be loaded by Vite/Node.
      // Note: Vite may normalize paths with posix separators. We always compare resolved absolute paths.
      if (path.isAbsolute(fsPath) && normalizedFsPath === normalizedRouterEntryAbs)
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

interface RouteComponentInfo {
  componentName: string | null;
  filePath: string | null;
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

function normalizeRouteComponentFilePath(
  filePath: string,
  options: {
    rootDir?: string;
  } = {},
): string | null {
  const queryIndex = filePath.indexOf("?");
  const cleanPath = queryIndex === -1 ? filePath : filePath.slice(0, queryIndex);
  if (cleanPath.startsWith("/@fs/")) {
    return path.normalize(cleanPath.slice("/@fs/".length));
  }

  if (path.isAbsolute(cleanPath)) {
    if (fs.existsSync(cleanPath) || !options.rootDir)
      return path.normalize(cleanPath);
    return path.normalize(path.resolve(options.rootDir, `.${cleanPath}`));
  }

  if (!options.rootDir)
    return null;
  return path.normalize(path.resolve(options.rootDir, cleanPath));
}

function getComponentInfoFromVueComponent(
  comp: VueComponentLike | undefined,
  options: { allowFunctionNameFallback?: boolean; rootDir?: string } = {},
): RouteComponentInfo {
  if (!comp) {
    return {
      componentName: null,
      filePath: null,
    };
  }

  let componentName: string | null = null;
  let filePath: string | null = null;

  // Vue Router's normalized record has `components` (plural) where `default` is the main view component.
  // When compiled by Vite, SFCs usually have an `__file` pointing at the source file.
  if (typeof comp.__file === "string" && comp.__file.length) {
    filePath = normalizeRouteComponentFilePath(comp.__file, { rootDir: options.rootDir });
    const base = path.posix.basename(path.posix.normalize(comp.__file));
    if (base.toLowerCase().endsWith(".vue"))
      componentName = base.slice(0, -".vue".length);
  }

  // Fallbacks (less stable / may be minified):
  if (!componentName && typeof comp.__name === "string" && comp.__name.length)
    componentName = comp.__name;
  if (
    !componentName
    && options.allowFunctionNameFallback !== false
    && typeof comp.name === "string"
    && comp.name.length
  ) {
    componentName = comp.name;
  }

  return {
    componentName,
    filePath,
  };
}

async function getComponentInfoFromRouteRecord(
  record: RouteRecordNormalized,
  options: {
    rootDir?: string;
  } = {},
): Promise<RouteComponentInfo> {
  const comp = record.components?.default as VueComponentLike | (() => Promise<unknown>) | undefined;
  if (!comp) {
    return {
      componentName: null,
      filePath: null,
    };
  }

  if (typeof comp !== "function") {
    return getComponentInfoFromVueComponent(comp as VueComponentLike, options);
  }

  const directInfo = getComponentInfoFromVueComponent(comp as VueComponentLike, {
    allowFunctionNameFallback: false,
    rootDir: options.rootDir,
  });
  if (directInfo.componentName || directInfo.filePath)
    return directInfo;

  try {
    const loaded = await comp();
    const resolved = (loaded && typeof loaded === "object" && "default" in loaded)
      ? (loaded as { default?: VueComponentLike }).default
      : (loaded as VueComponentLike | undefined);
    const loadedInfo = getComponentInfoFromVueComponent(resolved, options);
    if (loadedInfo.componentName || loadedInfo.filePath)
      return loadedInfo;
  }
  catch {
    // Fall back to the function object's own metadata below.
  }

  return getComponentInfoFromVueComponent(comp as VueComponentLike, options);
}

function resolveIntrospectedComponentName(
  componentInfo: RouteComponentInfo,
  componentNaming?: RouterIntrospectionOptions["componentNaming"],
): string | null {
  if (componentInfo.filePath && componentNaming) {
    return resolveComponentNameFromPath({
      filename: componentInfo.filePath,
      projectRoot: componentNaming.projectRoot,
      viewsDirAbs: componentNaming.viewsDirAbs,
      sourceDirs: componentNaming.sourceDirs,
      extraRoots: componentNaming.extraRoots,
    });
  }

  return componentInfo.componentName;
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
    g.history = { pushState() { }, replaceState() { } };

  if (!g.MutationObserver) {
    g.MutationObserver = class {
      disconnect() { }
      observe() { }
      takeRecords() { return []; }
    };
  }
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      disconnect() { }
      observe() { }
      unobserve() { }
    };
  }
  if (!g.IntersectionObserver) {
    g.IntersectionObserver = class {
      disconnect() { }
      observe() { }
      unobserve() { }
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

interface NuxtPageSegmentResolution {
  pathPart: string;
  params: Array<{ name: string; optional: boolean }>;
}

function unwrapNuxtPageSegment(segment: string, prefix: string, suffix: string): string | null {
  if (!segment.startsWith(prefix) || !segment.endsWith(suffix))
    return null;

  const value = segment.slice(prefix.length, segment.length - suffix.length);
  return value.length > 0 ? value : null;
}

function resolveNuxtPageSegment(segment: string): NuxtPageSegmentResolution {
  if (segment === "index") {
    return { pathPart: "", params: [] };
  }

  const optionalParamName = unwrapNuxtPageSegment(segment, "[[", "]]");
  if (optionalParamName) {
    return {
      pathPart: `:${optionalParamName}?`,
      params: [{ name: optionalParamName, optional: true }],
    };
  }

  const catchAllParamName = unwrapNuxtPageSegment(segment, "[...", "]");
  if (catchAllParamName) {
    return {
      pathPart: `:${catchAllParamName}(.*)*`,
      params: [{ name: catchAllParamName, optional: false }],
    };
  }

  const requiredParamName = unwrapNuxtPageSegment(segment, "[", "]");
  if (requiredParamName) {
    return {
      pathPart: `:${requiredParamName}`,
      params: [{ name: requiredParamName, optional: false }],
    };
  }

  return { pathPart: segment, params: [] };
}

function toPathSegments(value: string): string[] {
  const segments: string[] = [];
  let current = path.normalize(value);

  while (current && current !== "." && current !== path.sep) {
    const parsed = path.parse(current);
    if (!parsed.base || parsed.base === ".")
      break;
    segments.unshift(parsed.base);
    if (!parsed.dir || parsed.dir === "." || parsed.dir === current)
      break;
    current = parsed.dir;
  }

  return segments;
}

export async function introspectNuxtPages(
  projectRoot: string,
  options: { pageDirs?: string[] } = {},
): Promise<RouterIntrospectionResult> {
  const possiblePageDirs = options.pageDirs?.length
    ? options.pageDirs
    : ["app/pages", "pages"].map(dir => path.resolve(projectRoot, dir));
  const pageDirs = possiblePageDirs
    .map(dir => path.resolve(projectRoot, dir))
    .filter((dir) => {
      try {
        return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
      }
      catch {
        return false;
      }
    });

  if (!pageDirs.length) {
    debugLog(`[router-introspection][nuxt] Could not find pages directory in ${projectRoot}`);
    return { routeNameMap: new Map(), routePathMap: new Map(), routeMetaEntries: [] };
  }

  const routePathMap = new Map<string, string>();
  const routeMetaEntries: RouterIntrospectionResult["routeMetaEntries"] = [];

  const walk = (pagesDir: string, dir: string) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(pagesDir, fullPath);
        continue;
      }

      if (!file.endsWith(".vue"))
        continue;

      const componentName = resolveComponentNameFromPath({
        filename: fullPath,
        projectRoot,
        viewsDirAbs: pagesDir,
        sourceDirs: [pagesDir],
        extraRoots: [process.cwd()],
      });

      const relativePath = path.relative(pagesDir, fullPath);
      const parsed = path.parse(relativePath);
      const routeSegments = toPathSegments(path.join(parsed.dir, parsed.name));

      const params: Array<{ name: string; optional: boolean }> = [];
      const pathParts = routeSegments.flatMap((segment) => {
        const resolution = resolveNuxtPageSegment(segment);
        params.push(...resolution.params);
        return resolution.pathPart ? [resolution.pathPart] : [];
      });
      const pathTemplate = pathParts.length ? `/${pathParts.join("/")}` : "/";

      routePathMap.set(pathTemplate, componentName);
      routeMetaEntries.push({
        componentName,
        pathTemplate,
        params,
        query: [],
      });
    }
  };

  for (const pageDir of pageDirs) {
    walk(pageDir, pageDir);
  }

  return {
    routeNameMap: new Map(),
    routePathMap,
    routeMetaEntries,
  };
}

/**
 * Loads this repo's `src/router.ts` via Vite's SSR module loader and asks Vue Router
 * for its normalized routes.
 *
 * This replaces the previous regex-based parsing so we can support nested route shapes,
 * redirects, and any non-trivial route record composition without maintaining a parser.
 */
export async function parseRouterFileFromCwd(
  routerEntryPath: string,
  options: RouterIntrospectionOptions = {},
): Promise<RouterIntrospectionResult> {
  return await runRouterIntrospectionExclusive(async () => {
    const routerEntry = path.resolve(routerEntryPath);
    if (!fs.existsSync(routerEntry)) {
      throw new Error(`[vue-pom-generator] Router entry not found at ${routerEntry}.`);
    }

    const cwd = path.dirname(routerEntry);
    const moduleShims = normalizeRouterIntrospectionModuleShims(options.moduleShims);

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
      server: { middlewareMode: true, hmr: false, ws: false },
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
      plugins: [createRouterIntrospectionVueStubPlugin({ routerEntryAbs: routerEntry, moduleShims })],
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
        const componentInfo = await getComponentInfoFromRouteRecord(r, { rootDir: cwd });
        const componentName = resolveIntrospectedComponentName(componentInfo, options.componentNaming);
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
  });
}
