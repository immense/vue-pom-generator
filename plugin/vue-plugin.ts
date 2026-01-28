import path from "node:path";

import type { Options as VuePluginOptions } from "@vitejs/plugin-vue";
import vue from "@vitejs/plugin-vue";
import type { PluginOption } from "vite";
import * as compilerDom from "@vue/compiler-dom";
import type { CompilerOptions, RootNode, TemplateChildNode, TransformContext } from "@vue/compiler-core";
import { NodeTypes } from "@vue/compiler-core";

import { compileWithMetadataExtractionManual } from "../compiler-wrapper";
import type { ElementMetadata } from "../metadata-collector";
import { createTestIdTransform } from "../transform";
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
}

export function createVuePluginWithTestIds(options: InternalFactoryOptions): PluginOption {
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
  } = options;

  const userTemplate = vueOptions?.template ?? {};
  const userCompilerOptions = userTemplate.compilerOptions ?? {};
  const userNodeTransforms = userCompilerOptions.nodeTransforms ?? [];

  // Vue compiler runs nodeTransforms for every node in a template.
  // We need a per-file transform instance so state accumulates across nodes.
  const perFileTransform = new Map<string, ReturnType<typeof createTestIdTransform>>();

  const templateCompilerOptions = {
    ...userCompilerOptions,
    // Ensures compiler-core runs `transformExpression` (in non-browser builds),
    // which parses directive expressions via @babel/parser and attaches `exp.ast`.
    // This improves reliability for AST-based consumers (like our data-testid generator).
    prefixIdentifiers: true,
    nodeTransforms: [
      ...userNodeTransforms,
      (node: RootNode | TemplateChildNode, context: TransformContext) => {
        if (!context.filename)
          return;
        const componentName = path.basename(context.filename, ".vue");

        // Root is visited first; treat it as the start of a new compilation run for this SFC.
        if (node.type === NodeTypes.ROOT) {
          // HMR/dev rebuilds can re-run template transforms for the same SFC multiple times.
          // Reset the component entry once per run to avoid stale/duplicate methods.
          componentHierarchyMap.delete(componentName);
          vueFilesPathMap.set(componentName, context.filename);

          perFileTransform.set(
            componentName,
            createTestIdTransform(
              componentName,
              componentHierarchyMap,
              nativeWrappers,
              excludedComponents,
              getViewsDirAbs(),
              {
                existingIdBehavior,
                testIdAttribute,
                nameCollisionBehavior,
                warn: (message) => loggerRef.current.warn(message),
              },
            ),
          );
        }

        let transform = perFileTransform.get(componentName);
        if (!transform) {
          // Safety net: create a transform if root wasn't observed for some reason.
          componentHierarchyMap.delete(componentName);
          vueFilesPathMap.set(componentName, context.filename);
          transform = createTestIdTransform(
            componentName,
            componentHierarchyMap,
            nativeWrappers,
            excludedComponents,
            getViewsDirAbs(),
            {
              existingIdBehavior,
              testIdAttribute,
              nameCollisionBehavior,
              warn: (message) => loggerRef.current.warn(message),
            },
          );
          perFileTransform.set(componentName, transform);
        }

        return transform(node, context);
      },
    ],
  };

  const template = {
    ...userTemplate,
    compiler: {
      // Preserve the full compiler-dom module behavior (directiveTransforms, nodeTransforms, etc.).
      // We only override `compile` to run our metadata extraction after transforms.
      ...compilerDom,
      compile(source: string, compilerOptions: CompilerOptions) {
        const componentName = compilerOptions.filename
          ? path.basename(compilerOptions.filename, ".vue")
          : "Unknown";
        return compileWithMetadataExtractionManual(
          source,
          compilerOptions,
          componentName,
          elementMetadata,
          semanticNameMap,
          testIdAttribute,
        );
      },
    },
    compilerOptions: templateCompilerOptions,
  };

  return vue({
    ...vueOptions,
    template,
  } as VuePluginOptions);
}
