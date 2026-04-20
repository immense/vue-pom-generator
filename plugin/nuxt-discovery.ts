import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromModule = createRequire(import.meta.url);

function resolveNuxtKitEntry(cwd: string): string {
  const attemptResolvers = [
    createRequire(path.resolve(cwd, "package.json")),
    requireFromModule,
  ];
  let lastError: Error | undefined;

  for (const resolver of attemptResolvers) {
    try {
      return resolver.resolve("@nuxt/kit");
    }
    catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Unknown module resolution error");
}

interface NuxtComponentDirLike {
  path?: string;
}

interface NuxtComponentsCollectionLike {
  dirs?: NuxtComponentsInputLike;
}

type NuxtComponentsInputLike =
  | boolean
  | string
  | NuxtComponentDirLike
  | NuxtComponentsCollectionLike
  | NuxtComponentsInputLike[]
  | undefined;

interface NuxtDirConfigLike {
  pages?: string;
  layouts?: string;
}

interface NuxtLayerConfigLike {
  rootDir?: string;
  srcDir?: string;
  dir?: NuxtDirConfigLike;
  components?: NuxtComponentsInputLike;
  alias?: Record<string, string>;
}

interface NuxtLayerLike {
  cwd?: string;
  config?: NuxtLayerConfigLike;
}

interface LoadedNuxtOptionsLike extends NuxtLayerConfigLike {
  _layers?: NuxtLayerLike[];
}

interface NuxtPathContext {
  rootDir: string;
  srcDir: string;
  alias?: Record<string, string>;
}

interface NuxtLike {
  options: LoadedNuxtOptionsLike;
}

interface NuxtLayerDirectoriesLike {
  root: string;
  app: string;
  appPages: string;
  appLayouts: string;
}

type GetLayerDirectoriesLike = (nuxt: NuxtLike) => NuxtLayerDirectoriesLike[];

export interface NuxtResolvedDiscovery {
  rootDir: string;
  srcDir: string;
  pageDirs: string[];
  layoutDirs: string[];
  componentDirs: string[];
  wrapperSearchRoots: string[];
}

function toUniqueResolvedPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map(value => path.resolve(value))));
}

function resolveNuxtAlias(value: string, context: NuxtPathContext): string {
  const aliases: Array<[string, string]> = [
    ["~~", context.rootDir],
    ["@@", context.rootDir],
    ["~/", `${context.srcDir}${path.sep}`],
    ["@/", `${context.srcDir}${path.sep}`],
    ["~", context.srcDir],
    ["@", context.srcDir],
  ];

  for (const [alias, replacement] of Object.entries(context.alias ?? {})) {
    aliases.push([alias, replacement]);
  }

  aliases.sort((a, b) => b[0].length - a[0].length);

  for (const [alias, replacement] of aliases) {
    if (value === alias)
      return replacement;
    if (value.startsWith(`${alias}/`) || value.startsWith(`${alias}${path.sep}`)) {
      const suffix = value.slice(alias.length + 1);
      return path.resolve(replacement, suffix);
    }
  }

  return value;
}

function resolveNuxtPath(value: string, baseDir: string, context: NuxtPathContext): string {
  const resolvedAlias = resolveNuxtAlias(value, context);
  return path.isAbsolute(resolvedAlias)
    ? path.resolve(resolvedAlias)
    : path.resolve(baseDir, resolvedAlias);
}

function normalizeNuxtComponentDirs(
  value: NuxtComponentsInputLike,
  baseDir: string,
  context: NuxtPathContext,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(entry => normalizeNuxtComponentDirs(entry, baseDir, context));
  }

  if (value === false) {
    return [];
  }

  if (value === true || value === undefined) {
    return [
      path.resolve(baseDir, "components/islands"),
      path.resolve(baseDir, "components/global"),
      path.resolve(baseDir, "components"),
    ];
  }

  if (typeof value === "string") {
    return [resolveNuxtPath(value, baseDir, context)];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (typeof value === "object" && value && "path" in value && typeof value.path === "string") {
    return [resolveNuxtPath(value.path, baseDir, context)];
  }

  if (typeof value !== "object" || !value || !("dirs" in value)) {
    return [];
  }

  return normalizeNuxtComponentDirs(value.dirs, baseDir, context);
}

export function resolveNuxtProjectDiscovery(
  nuxtOptions: LoadedNuxtOptionsLike,
  getLayerDirectories: GetLayerDirectoriesLike,
  cwd: string = process.cwd(),
): NuxtResolvedDiscovery {
  const rootDir = path.resolve(nuxtOptions.rootDir ?? cwd);
  const srcDir = path.resolve(nuxtOptions.srcDir ?? rootDir);
  const fallbackLayer: NuxtLayerLike = {
    cwd: rootDir,
    config: {
      rootDir,
      srcDir,
      dir: nuxtOptions.dir,
      components: nuxtOptions.components,
      alias: nuxtOptions.alias,
    },
  };
  const layers = nuxtOptions._layers?.length ? nuxtOptions._layers : [fallbackLayer];
  const normalizedNuxtOptions: LoadedNuxtOptionsLike = {
    ...nuxtOptions,
    _layers: layers,
  };
  const layerDirectories = getLayerDirectories({ options: normalizedNuxtOptions });

  const pageDirs = layerDirectories.map(layer => layer.appPages);
  const layoutDirs = layerDirectories.map(layer => layer.appLayouts);
  const componentDirs: string[] = [];

  for (const [index, layer] of layers.entries()) {
    const layerDirectory = layerDirectories[index];
    const layerRootDir = path.resolve(layerDirectory?.root ?? layer.config?.rootDir ?? layer.cwd ?? rootDir);
    const layerSrcDir = path.resolve(layerDirectory?.app ?? layer.config?.srcDir ?? layer.cwd ?? srcDir);
    const context: NuxtPathContext = {
      rootDir: layerRootDir,
      srcDir: layerSrcDir,
      alias: {
        ...(nuxtOptions.alias ?? {}),
        ...(layer.config?.alias ?? {}),
      },
    };

    componentDirs.push(...normalizeNuxtComponentDirs(layer.config?.components, layerSrcDir, context));
  }

  const uniquePageDirs = toUniqueResolvedPaths(pageDirs);
  const uniqueLayoutDirs = toUniqueResolvedPaths(layoutDirs);
  const uniqueComponentDirs = toUniqueResolvedPaths(componentDirs);

  return {
    rootDir,
    srcDir,
    pageDirs: uniquePageDirs,
    layoutDirs: uniqueLayoutDirs,
    componentDirs: uniqueComponentDirs,
    wrapperSearchRoots: [],
  };
}

export async function loadNuxtProjectDiscovery(cwd: string = process.cwd()): Promise<NuxtResolvedDiscovery> {
  let loadNuxtConfig: ((options: { cwd: string }) => Promise<LoadedNuxtOptionsLike>) | undefined;
  let getLayerDirectories: GetLayerDirectoriesLike | undefined;

  try {
    const nuxtKitEntry = resolveNuxtKitEntry(cwd);
    ({ loadNuxtConfig, getLayerDirectories } = await import(pathToFileURL(nuxtKitEntry).href) as {
      loadNuxtConfig?: (options: { cwd: string }) => Promise<LoadedNuxtOptionsLike>;
      getLayerDirectories?: GetLayerDirectoriesLike;
    });
  }
  catch (error) {
    throw new TypeError(
      `[vue-pom-generator] Nuxt mode requires @nuxt/kit to be available so Nuxt directories can be resolved from nuxt.config. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof loadNuxtConfig !== "function") {
    throw new TypeError("[vue-pom-generator] Nuxt mode requires @nuxt/kit.loadNuxtConfig().");
  }
  if (typeof getLayerDirectories !== "function") {
    throw new TypeError("[vue-pom-generator] Nuxt mode requires @nuxt/kit.getLayerDirectories().");
  }

  const nuxtOptions = await loadNuxtConfig({ cwd });
  return resolveNuxtProjectDiscovery(nuxtOptions, getLayerDirectories, cwd);
}
