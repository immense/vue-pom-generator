/**
 * Custom Vue Compiler Wrapper
 *
 * Wraps Vue's baseCompile to intercept the AST after transforms complete
 * but before code generation. This allows us to traverse the fully transformed
 * AST and extract codegenNode metadata (patchFlags, dynamicProps) for enhanced
 * Page Object Model generation.
 */

import type { ElementNode, RootNode, TemplateChildNode, TransformContext } from "@vue/compiler-core";
import type { CompilerOptions } from "@vue/compiler-dom";
import type { ElementMetadata } from "./metadata-collector";
import { NodeTypes } from "@vue/compiler-core";
import { compile } from "@vue/compiler-dom";
import { extend } from "@vue/shared";
import { findDataTestIdProp, tryCreateElementMetadata } from "./compiler-metadata-utils";

/**
 * Traverses the AST and extracts metadata from elements with data-testid attributes
 */
function extractMetadataFromAST(
  ast: RootNode,
  componentName: string,
  metadataMap: Map<string, Map<string, ElementMetadata>>,
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
          debugPrefix: "[compiler-wrapper]",
          preferJsonParseFailureAsContentArray: true,
          testIdAttribute,
        });

        if (metadata) {
          componentMetadata.set(metadata.testId, metadata);
        }
      }

      // Traverse children
      if (element.children) {
        for (const child of element.children) {
          traverseNode(child);
        }
      }
    }
    else if (node.type === NodeTypes.IF) {
      // Traverse v-if branches
      for (const branch of node.branches) {
        traverseNode(branch);
      }
    }
    else if (node.type === NodeTypes.IF_BRANCH || node.type === NodeTypes.FOR) {
      // Traverse conditional/loop children
      if (node.children) {
        for (const child of node.children) {
          traverseNode(child);
        }
      }
    }
    else if (node.type === NodeTypes.ROOT) {
      // Traverse root children
      for (const child of node.children) {
        traverseNode(child);
      }
    }
  }

  traverseNode(ast);

  if (componentMetadata.size > 0) {
    metadataMap.set(componentName, componentMetadata);
  }
}

/**
 * Custom compile function that wraps Vue's baseCompile
 * Extracts metadata after transform but before generate
 */
export function compileWithMetadataExtraction(
  source: string,
  options: CompilerOptions,
  _componentName: string,
  _metadataMap: Map<string, Map<string, ElementMetadata>>,
  _debug: boolean,
): ReturnType<typeof compile> {
  // Call Vue's baseCompile which internally does: parse -> transform -> generate
  const result = compile(source, options);

  // The result contains the generated code, but we need the AST
  // Unfortunately, baseCompile doesn't expose the AST after transform
  // We need to recreate the transform pipeline manually

  return result;
}

/**
 * Custom compile function that manually runs parse -> transform -> extract -> generate
 */
export function compileWithMetadataExtractionManual(
  source: string,
  options: CompilerOptions,
  componentName: string,
  metadataMap: Map<string, Map<string, ElementMetadata>>,
  semanticNameMap: Map<string, string>,
  testIdAttribute: string = "data-testid",
): ReturnType<typeof compile> {
  const normalizedTestIdAttribute = (testIdAttribute ?? "data-testid").trim() || "data-testid";
  // IMPORTANT:
  // Use `@vue/compiler-dom`'s `compile()` (not `baseCompile`) so DOM-specific
  // transforms (especially directive transforms like `v-show`) are preserved.
  //
  // We append a final root-level nodeTransform that registers an exit hook to
  // run *after* the rest of the transform pipeline, allowing us to extract
  // metadata from the fully transformed AST.
  const result = compile(
    source,
    extend({}, options, {
      nodeTransforms: [
        ...(options.nodeTransforms || []),
        (node: RootNode | TemplateChildNode, _context: TransformContext) => {
          if (node.type !== NodeTypes.ROOT)
            return;

          return () => {
            extractMetadataFromAST(node as RootNode, componentName, metadataMap, semanticNameMap, normalizedTestIdAttribute);
          };
        },
      ],
    }),
  );

  return result;
}
