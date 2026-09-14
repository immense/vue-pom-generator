import path from "node:path";
import process from "node:process";

import type { Options as VuePluginOptions } from "@vitejs/plugin-vue";
import vue from "@vitejs/plugin-vue";
import type { PluginOption } from "vite";
import type { ElementNode, NodeTransform, RootNode, TemplateChildNode, TransformContext } from "@vue/compiler-core";
import type { CompilerOptions } from "@vue/compiler-dom";
import type { SFCTemplateCompileOptions } from "@vue/compiler-sfc";
import { NodeTypes } from "@vue/compiler-core";

import { collectAccessibilityReviewWarnings } from "../accessibility-audit";
import { findDataTestIdProp, tryCreateElementMetadata } from "../compiler-metadata-utils";
import { buildPomManifest } from "../manifest-generator";
import type { ElementMetadata } from "../metadata-collector";
import { createTestIdTransform } from "../transform";
import type { CrossFileKeyRegistry } from "../transform";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";

import type { VuePomGeneratorLogger } from "./logger";
import { isFileInConfiguredSourceScope, resolveComponentNameFromPath } from "./path-utils";
import type { ExistingIdBehavior, ExistingIdBehaviorConfig, MissingSemanticNameBehavior, PomNameCollisionBehavior } from "./types";

interface InternalFactoryOptions {
  vueOptions?: VuePluginOptions;
  existingIdBehavior: ExistingIdBehaviorConfig;
  nameCollisionBehavior: PomNameCollisionBehavior;
  missingSemanticNameBehavior?: MissingSemanticNameBehavior;
  nativeWrappers: NativeWrappersMap;
  optionKeyAttribute: Record<string, string>;
  elementMetadata: Map<string, Map<string, ElementMetadata>>;
  semanticNameMap: Map<string, string>;
  componentHierarchyMap: Map<string, IComponentDependencies>;
  crossFileKeyRegistry: CrossFileKeyRegistry;
  vueFilesPathMap: Map<string, string>;
  skipTestIdGenerationInsideComponents: string[];
  getViewsDirAbs: () => string;
  testIdAttribute: string;
  accessibilityAudit: boolean;
  loggerRef: { current: VuePomGeneratorLogger };
  getSourceDirs: () => string[];
  getWrapperSearchRoots: () => string[];
  getProjectRoot: () => string;
  annotatorMetadata?: {
    sourceAttribute: string;
    metadataAttributePrefix: string;
  } | null;
}

type VueCompilerSfcNamespace = Awaited<typeof import("@vue/compiler-sfc")>;

export function resolveExistingIdBehavior(
  config: ExistingIdBehaviorConfig,
  componentName: string,
): ExistingIdBehavior {
  return typeof config === "string"
    ? config
    : (config.components[componentName] ?? config.default);
}

function resolveCompilerSfcParse(compilerSfc: VueCompilerSfcNamespace): VueCompilerSfcNamespace["parse"] {
  const parse = compilerSfc.parse
    ?? (compilerSfc as VueCompilerSfcNamespace & { default?: Partial<VueCompilerSfcNamespace> }).default?.parse;
  if (typeof parse !== "function") {
    throw new TypeError("[vue-pom-generator] Failed to resolve @vue/compiler-sfc.parse.");
  }

  return parse;
}

/**
 * Traverses the AST and extracts metadata from elements with data-testid attributes.
 * Since we run as a nodeTransform, we must use an exit hook on the ROOT node
 * to ensure we see the final state of all elements (including injected test-ids).
 */
function extractMetadataAfterTransform(
  ast: RootNode,
  componentName: string,
  elementMetadata: Map<string, Map<string, ElementMetadata>>,
  semanticNameMap: Map<string, string>,
  testIdAttribute: string,
): Map<string, ElementMetadata> {
  const componentMetadata = new Map<string, ElementMetadata>();

  function traverseNode(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.ELEMENT) {
      const element = node as ElementNode;
      const testIdAttr = findDataTestIdProp(element, testIdAttribute);
      if (testIdAttr) {
        const metadata = tryCreateElementMetadata({
          element,
          semanticNameMap,
          debug: false,
          debugPrefix: "[vue-plugin]",
          preferJsonParseFailureAsContentArray: true,
          testIdAttribute,
        });

        if (metadata) {
          componentMetadata.set(metadata.testId, metadata);
        }
      }

      if (element.children) {
        for (const child of element.children) {
          traverseNode(child);
        }
      }
    } else if (node.type === NodeTypes.IF) {
      for (const branch of node.branches) {
        traverseNode(branch);
      }
    } else if (node.type === NodeTypes.IF_BRANCH || node.type === NodeTypes.FOR) {
      if (node.children) {
        for (const child of node.children) {
          traverseNode(child);
        }
      }
    } else if (node.type === NodeTypes.ROOT) {
      for (const child of node.children) {
        traverseNode(child);
      }
    }
  }

  traverseNode(ast);
  elementMetadata.set(componentName, componentMetadata);
  return componentMetadata;
}

export function createVuePluginWithTestIds(options: InternalFactoryOptions): {
  metadataCollectorPlugin: PluginOption;
  internalVuePlugin: PluginOption;
  nuxtVueBridgePlugin: PluginOption;
  templateCompilerOptions: Record<string, unknown>;
  collectSource: (code: string, filename: string) => Promise<void>;
} {
  const {
    vueOptions,
    existingIdBehavior,
    nameCollisionBehavior,
    missingSemanticNameBehavior = "error",
    nativeWrappers,
    optionKeyAttribute,
    elementMetadata,
    semanticNameMap,
    componentHierarchyMap,
    crossFileKeyRegistry,
    vueFilesPathMap,
    skipTestIdGenerationInsideComponents,
    getViewsDirAbs,
    testIdAttribute,
    accessibilityAudit,
    loggerRef,
    getSourceDirs,
    getWrapperSearchRoots,
    getProjectRoot,
    annotatorMetadata,
  } = options;
  const lastAccessibilityWarningSignatureByComponent = new Map<string, string>();

  const getComponentNameFromPath = (filename: string): string => {
    return resolveComponentNameFromPath({
      filename,
      projectRoot: getProjectRoot(),
      viewsDirAbs: getViewsDirAbs(),
      sourceDirs: getSourceDirs(),
      extraRoots: [process.cwd()],
    });
  };

  const isFileInScope = (filename: string | undefined): boolean => {
    if (!filename)
      return false;

    // Strip any Vite/Nuxt query parameters (e.g. ?vue&type=template)
    const cleanPath = filename.includes("?") ? filename.substring(0, filename.indexOf("?")) : filename;
    const projectRoot = getProjectRoot();
    const matched = isFileInConfiguredSourceScope({
      filename,
      projectRoot,
      viewsDirAbs: getViewsDirAbs(),
      sourceDirs: getSourceDirs(),
      extraRoots: [process.cwd()],
    });

    if (cleanPath.endsWith(".vue") && !matched) {
      const absFilename = path.normalize(path.isAbsolute(cleanPath) ? cleanPath : path.resolve(projectRoot, cleanPath));
      loggerRef.current.debug(`[isFileInScope] REJECTED: ${absFilename} (Clean: ${cleanPath})`);
    }

    return matched;
  };

  // plugin-vue can resolve a different Vue peer installation. Normalize its public
  // options at this boundary to the compiler used by this package's source scan.
  const userTemplate = (vueOptions?.template ?? {}) as Partial<SFCTemplateCompileOptions>;
  const userCompilerOptions = userTemplate.compilerOptions ?? {};
  const userNodeTransforms = userCompilerOptions.nodeTransforms ?? [];

  // Vue compiler runs nodeTransforms for every node in a template.
  // We need a per-file transform instance so state accumulates across nodes.
  const perFileTransform = new Map<string, ReturnType<typeof createTestIdTransform>>();

  const getNodeTransforms = (filename: string, componentNameOverride?: string) => {
    // Strip any Vite/Nuxt query parameters (e.g. ?vue&type=template)
    const cleanPath = filename.includes("?") ? filename.substring(0, filename.indexOf("?")) : filename;
    const viewsDirAbs = getViewsDirAbs();

    const componentName = componentNameOverride || getComponentNameFromPath(cleanPath);

    return [
      ...userNodeTransforms,
      (node: RootNode | TemplateChildNode, context: TransformContext) => {
        // Root is visited first; treat it as the start of a new compilation run for this SFC.
        if (node.type === NodeTypes.ROOT) {
          // HMR/dev rebuilds can re-run template transforms for the same SFC multiple times.
          // Reset the component entry once per run to avoid stale/duplicate methods.
          componentHierarchyMap.delete(componentName);
          vueFilesPathMap.set(componentName, filename);

          perFileTransform.set(
            componentName,
            createTestIdTransform(
              componentName,
              componentHierarchyMap,
              nativeWrappers,
              skipTestIdGenerationInsideComponents,
              viewsDirAbs,
                {
                  existingIdBehavior: resolveExistingIdBehavior(existingIdBehavior, componentName),
                  testIdAttribute,
                  nameCollisionBehavior,
                  missingSemanticNameBehavior,
                  warn: (message) => loggerRef.current.warn(message),
                  vueFilesPathMap,
                  wrapperSearchRoots: getWrapperSearchRoots(),
                  annotatorMetadata,
                  crossFileKeyRegistry,
                  optionKeyAttribute,
                },
              ),
            );

          // Return an exit hook to extract metadata after all other transforms (including our own) have run.
          return () => {
            const componentMetadata = extractMetadataAfterTransform(
              node as RootNode,
              componentName,
              elementMetadata,
              semanticNameMap,
              testIdAttribute,
            );

            if (!accessibilityAudit) {
              return;
            }

            const dependencies = componentHierarchyMap.get(componentName);
            if (!dependencies || componentMetadata.size === 0) {
              return;
            }

            const manifest = buildPomManifest(
              new Map([[componentName, dependencies]]),
              new Map([[componentName, componentMetadata]]),
            );
            const warnings = collectAccessibilityReviewWarnings(manifest);
            const signature = warnings.join("\n");
            if (!signature) {
              lastAccessibilityWarningSignatureByComponent.delete(componentName);
              return;
            }
            if (lastAccessibilityWarningSignatureByComponent.get(componentName) === signature) {
              return;
            }

            lastAccessibilityWarningSignatureByComponent.set(componentName, signature);
            for (const warning of warnings) {
              loggerRef.current.warn(warning);
            }
          };
        }

        let transform = perFileTransform.get(componentName);
        if (!transform) {
          // Safety net: create a transform if root wasn't observed for some reason.
          componentHierarchyMap.delete(componentName);
          vueFilesPathMap.set(componentName, filename);
          transform = createTestIdTransform(
            componentName,
            componentHierarchyMap,
            nativeWrappers,
            skipTestIdGenerationInsideComponents,
            viewsDirAbs,
              {
                existingIdBehavior: resolveExistingIdBehavior(existingIdBehavior, componentName),
                testIdAttribute,
                nameCollisionBehavior,
                missingSemanticNameBehavior,
                warn: (message) => loggerRef.current.warn(message),
                vueFilesPathMap,
                wrapperSearchRoots: getWrapperSearchRoots(),
                annotatorMetadata,
                crossFileKeyRegistry,
                optionKeyAttribute,
              },
            );
          perFileTransform.set(componentName, transform);
        }

        return transform(node, context);
      },
    ];
  };

  const runtimeNodeTransform: NodeTransform = (node: RootNode | TemplateChildNode, context: TransformContext) => {
    // This transform is intended for the main @vitejs/plugin-vue instance.
    // It delegates to the same per-file transform logic used by the metadata collector,
    // using the filename provided by the compiler context.
    const filename = context.filename;
    if (!filename || !filename.endsWith(".vue") || !isFileInScope(filename)) {
      return;
    }

    const transforms = getNodeTransforms(filename);
    const ourTransform = transforms[transforms.length - 1] as NodeTransform;
    return ourTransform(node, context);
  };

  const templateCompilerOptions = {
    ...userCompilerOptions,
    prefixIdentifiers: true,
    nodeTransforms: [
      ...userNodeTransforms,
      runtimeNodeTransform,
    ],
  };

  const collectSource = async (code: string, cleanPath: string): Promise<void> => {
    const componentName = getComponentNameFromPath(cleanPath);
    loggerRef.current.debug(`Collecting metadata for ${cleanPath} (component: ${componentName})`);

    const compilerSfc = await import("@vue/compiler-sfc");
    const parse = resolveCompilerSfcParse(compilerSfc);
    const { descriptor, errors } = parse(code, { filename: cleanPath });
    if (errors.length) {
      throw new Error(`[vue-pom-generator] Cannot parse ${cleanPath}: ${errors.map(String).join("\n")}`);
    }
    const script = descriptor.script || descriptor.scriptSetup
      ? compilerSfc.compileScript(descriptor, { ...vueOptions?.script, id: cleanPath })
      : undefined;
    if (descriptor.template) {
      // Run the template compiler with our transforms.
      // We don't care about the result, only the side effects on our shared maps.
      // Merge TS into `expressionPlugins` so template expressions with TS
      // type annotations (e.g. `(row: RowType) => ...`) parse. User-supplied
      // plugins from `userCompilerOptions` are preserved and de-duped.
      const mergedExpressionPlugins = Array.from(
        new Set<NonNullable<CompilerOptions["expressionPlugins"]>[number]>([
          "typescript",
          ...(userCompilerOptions.expressionPlugins ?? []),
        ]),
      );
      const compiled = compilerSfc.compileTemplate({
        ...userTemplate,
        id: cleanPath,
        filename: cleanPath,
        source: descriptor.template.content,
        ast: descriptor.template.ast,
        preprocessLang: descriptor.template.lang,
        compilerOptions: {
          ...userCompilerOptions,
          prefixIdentifiers: true,
          inline: !!descriptor.scriptSetup,
          bindingMetadata: script?.bindings,
          expressionPlugins: mergedExpressionPlugins,
          nodeTransforms: getNodeTransforms(cleanPath, componentName),
        },
      });
      if (compiled.errors.length) {
        throw new Error(`[vue-pom-generator] Cannot compile ${cleanPath}: ${compiled.errors.map(String).join("\n")}`);
      }
      loggerRef.current.debug(`Metadata collected for ${cleanPath}`);
    }
    else {
      vueFilesPathMap.set(componentName, cleanPath);
      elementMetadata.delete(componentName);
      componentHierarchyMap.set(componentName, {
        filePath: cleanPath,
        childrenComponentSet: new Set(),
        usedComponentSet: new Set(),
        dataTestIdSet: new Set(),
        isView: false,
        methodsContent: "",
      });
    }
  };

  const metadataCollectorPlugin: PluginOption = {
    name: "vue-pom-generator-metadata-collector",
    enforce: "pre",
    async transform(code, id) {
      if (!id.endsWith(".vue") || !isFileInScope(id)) return null;
      await collectSource(code, id);
      return null;
    },
  };

  const template = {
    ...userTemplate,
    compilerOptions: templateCompilerOptions,
  };

  const internalVuePlugin = vue({
    ...vueOptions,
    template,
  } as VuePluginOptions);

  const nuxtVueBridgePlugin: PluginOption = {
    name: "vue-pom-generator-nuxt-vue-bridge",
    apply: "serve",
    configResolved(config) {
      const viteVuePlugin = config.plugins.find((plugin): plugin is PluginOption & {
        name: string;
        api?: {
          options?: {
            template?: {
              compilerOptions?: {
                nodeTransforms?: NodeTransform[];
              };
            };
          };
        };
      } => {
        return typeof plugin === "object"
          && plugin !== null
          && "name" in plugin
          && plugin.name === "vite:vue"
          && "api" in plugin;
      });

      const api = viteVuePlugin?.api;
      if (!api) {
        throw new Error("[vue-pom-generator] Nuxt bridge could not find vite:vue plugin to patch.");
      }

      const currentOptions = api.options ?? {};
      const currentTemplate = currentOptions.template ?? {};
      const currentCompilerOptions = currentTemplate.compilerOptions ?? {};
      const currentNodeTransforms = currentCompilerOptions.nodeTransforms ?? [];
      if (currentNodeTransforms.includes(runtimeNodeTransform)) {
        return;
      }

      api.options = {
        ...currentOptions,
        template: {
          ...currentTemplate,
          compilerOptions: {
            ...currentCompilerOptions,
            prefixIdentifiers: true,
            nodeTransforms: [
              ...currentNodeTransforms,
              runtimeNodeTransform,
            ],
          },
        },
      };
    },
  };

  return { metadataCollectorPlugin, internalVuePlugin, nuxtVueBridgePlugin, templateCompilerOptions, collectSource };
}
