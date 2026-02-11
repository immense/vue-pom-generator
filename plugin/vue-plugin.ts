import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { Options as VuePluginOptions } from "@vitejs/plugin-vue";
import vue from "@vitejs/plugin-vue";
import type { PluginOption } from "vite";
import type { ElementNode, NodeTransform, RootNode, TemplateChildNode, TransformContext } from "@vue/compiler-core";
import { NodeTypes } from "@vue/compiler-core";

import { findDataTestIdProp, tryCreateElementMetadata } from "../compiler-metadata-utils";
import type { ElementMetadata } from "../metadata-collector";
import { createTestIdTransform } from "../transform";
import { toPascalCase } from "../utils";
import type { IComponentDependencies, NativeWrappersMap } from "../utils";

import type { VuePomGeneratorLogger } from "./logger";
import type { PomNameCollisionBehavior } from "./types";

interface InternalFactoryOptions {
  vueOptions?: VuePluginOptions;
  existingIdBehavior: "preserve" | "overwrite" | "error";
  nameCollisionBehavior: PomNameCollisionBehavior;
  nativeWrappers: NativeWrappersMap;
  elementMetadata: Map<string, Map<string, ElementMetadata>>;
  semanticNameMap: Map<string, string>;
  componentHierarchyMap: Map<string, IComponentDependencies>;
  vueFilesPathMap: Map<string, string>;
  excludedComponents: string[];
  getViewsDirAbs: () => string;
  testIdAttribute: string;
  loggerRef: { current: VuePomGeneratorLogger };
  scanDirs?: string[];
  getProjectRoot: () => string;
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
): void {
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
  if (componentMetadata.size > 0) {
    elementMetadata.set(componentName, componentMetadata);
  }
}

export function createVuePluginWithTestIds(options: InternalFactoryOptions): {
  metadataCollectorPlugin: PluginOption;
  internalVuePlugin: PluginOption;
} {
  const {
    vueOptions,
    existingIdBehavior,
    nameCollisionBehavior,
    nativeWrappers,
    elementMetadata,
    semanticNameMap,
    componentHierarchyMap,
    vueFilesPathMap,
    excludedComponents,
    getViewsDirAbs,
    testIdAttribute,
    loggerRef,
    scanDirs = ["src"],
    getProjectRoot,
  } = options;

  const getComponentNameFromPath = (filename: string): string => {
    const cleanPath = filename.includes("?") ? filename.substring(0, filename.indexOf("?")) : filename;
    const projectRoot = getProjectRoot();
    const absFilename = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(projectRoot, cleanPath);
    const viewsDirAbs = getViewsDirAbs();

    // Determine a unique component name based on its relative path within the project.
    // We check common roots (viewsDir, scanDirs) and use the most specific match.
    //
    // Nuxt-specific: if projectRoot is /web and scanDir is 'app', potentialRoots includes /web/app.
    // /web/app/pages/foo/index.vue -> rel: pages/foo/index -> PagesFooIndex.
    const roots = [viewsDirAbs, ...scanDirs.map(d => path.resolve(projectRoot, d))];

    // Add conventional Nuxt/Vue subdirectories as potential roots to get cleaner names
    // (e.g. AdministrationFirmsIndex instead of PagesAdministrationFirmsIndex).
    for (const dir of scanDirs) {
      const absDir = path.resolve(projectRoot, dir);
      try {
        const pagesDir = path.join(absDir, "pages");
        if (fs.existsSync(pagesDir)) {
          roots.push(pagesDir);
        }
        const componentsDir = path.join(absDir, "components");
        if (fs.existsSync(componentsDir)) {
          roots.push(componentsDir);
        }
      } catch {
        // Ignore fs errors
      }
    }

    const potentialRoots = Array.from(new Set(roots.map(r => path.normalize(r))))
      .sort((a, b) => b.length - a.length);

    let componentName = "";
    for (const root of potentialRoots) {
      if (absFilename.startsWith(root + path.sep) || absFilename === root) {
        const rel = path.relative(root, absFilename);
        const parsed = path.parse(rel);
        const segments = path.join(parsed.dir, parsed.name);
        componentName = toPascalCase(segments);
        break;
      }
    }

    if (!componentName) {
      const parsed = path.parse(absFilename);
      componentName = toPascalCase(parsed.name);
    }

    return componentName;
  };

  const isFileInScope = (filename: string | undefined): boolean => {
    if (!filename)
      return false;

    // Strip any Vite/Nuxt query parameters (e.g. ?vue&type=template)
    const cleanPath = filename.includes("?") ? filename.substring(0, filename.indexOf("?")) : filename;
    const projectRoot = getProjectRoot();
    const absFilename = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(projectRoot, cleanPath);

    // Never touch node_modules
    if (absFilename.includes(`${path.sep}node_modules${path.sep}`) || absFilename.includes("/node_modules/"))
      return false;

    // Must be in one of the scanDirs or viewsDir
    const viewsDirAbs = getViewsDirAbs();
    if (absFilename.startsWith(viewsDirAbs + path.sep) || absFilename === viewsDirAbs)
      return true;

    // Root paths to check against.
    const rootsToTry = [projectRoot, process.cwd()];

    const matched = scanDirs.some((dir) => {
      return rootsToTry.some((root) => {
        const absDir = path.resolve(root, dir);
        if (absFilename.startsWith(absDir + path.sep) || absFilename === absDir)
          return true;

        if (dir.startsWith("app/") && root.endsWith("/app")) {
          const relativeDir = dir.substring(4);
          const absDirAlt = path.resolve(root, relativeDir);
          return absFilename.startsWith(absDirAlt + path.sep) || absFilename === absDirAlt;
        }

        return false;
      });
    });

    if (cleanPath.endsWith(".vue") && !matched) {
      loggerRef.current.debug(`[isFileInScope] REJECTED: ${absFilename} (Clean: ${cleanPath})`);
    }

    return matched;
  };

  const userTemplate = vueOptions?.template ?? {};
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
              excludedComponents,
              viewsDirAbs,
              {
                existingIdBehavior,
                testIdAttribute,
                nameCollisionBehavior,
                warn: (message) => loggerRef.current.warn(message),
                vueFilesPathMap,
              },
            ),
          );

          // Return an exit hook to extract metadata after all other transforms (including our own) have run.
          return () => {
            extractMetadataAfterTransform(
              node as RootNode,
              componentName,
              elementMetadata,
              semanticNameMap,
              testIdAttribute,
            );
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
            excludedComponents,
            viewsDirAbs,
            {
              existingIdBehavior,
              testIdAttribute,
              nameCollisionBehavior,
              warn: (message) => loggerRef.current.warn(message),
              vueFilesPathMap,
            },
          );
          perFileTransform.set(componentName, transform);
        }

        return transform(node, context);
      },
    ];
  };

  const templateCompilerOptions = {
    ...userCompilerOptions,
    prefixIdentifiers: true,
    nodeTransforms: [
      ...userNodeTransforms,
      (node: RootNode | TemplateChildNode, context: TransformContext) => {
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
      },
    ],
  };

  const metadataCollectorPlugin: PluginOption = {
    name: "vue-pom-generator-metadata-collector",
    enforce: "pre",
    async transform(code, id) {
      const cleanPath = id.includes("?") ? id.substring(0, id.indexOf("?")) : id;
      if (!cleanPath.endsWith(".vue") || !isFileInScope(id)) {
        return null;
      }

      // If we've already processed this file in this build pass, skip the duplicates
      // caused by Vite query parameters (?macro=true, ?vue&type=template, etc).
      if (id !== cleanPath) {
          return null;
      }

      const componentName = getComponentNameFromPath(cleanPath);
      loggerRef.current.debug(`Collecting metadata for ${cleanPath} (component: ${componentName})`);

      const { parse } = await import("@vue/compiler-sfc");
      const compilerDom = await import("@vue/compiler-dom");
      const compile = compilerDom.compile as (template: string, options: object) => object;
      const { descriptor } = parse(code, { filename: cleanPath });
      if (descriptor.template) {
        // Run the template compiler with our transforms.
        // We don't care about the result, only the side effects on our shared maps.
        compile(descriptor.template.content, {
          ...userCompilerOptions,
          filename: cleanPath,
          nodeTransforms: getNodeTransforms(cleanPath, componentName),
        });
        loggerRef.current.debug(`Metadata collected for ${cleanPath}`);
      }

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

  return { metadataCollectorPlugin, internalVuePlugin };
}
