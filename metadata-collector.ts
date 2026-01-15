/**
 * Metadata Collector Transform
 *
 * This transform runs BEFORE base transforms (by being registered first).
 * It has NO entry logic, only an EXIT function.
 * Since exit functions run in reverse order, this exit function runs AFTER
 * Vue's transformElement has created codegenNodes with patchFlags.
 *
 * Purpose: Extract compiler metadata (patchFlags, dynamicProps) to generate
 * smarter Page Object Models with semantic understanding of elements.
 */

import type { ElementNode, NodeTransform } from "@vue/compiler-core";
import { ElementTypes, NodeTypes } from "@vue/compiler-core";
import { findDataTestIdProp, getTestIdFromProp, tryCreateElementMetadata } from "./compiler-metadata-utils";

export interface ElementMetadata {
  testId: string;
  semanticName: string; // Semantic property name (e.g., "create", "tenantName") extracted during transform
  tag: string;
  tagType: ElementTypes;
  patchFlag?: number;
  dynamicProps?: string[];
  hasClickHandler?: boolean;
  hasDynamicClass?: boolean;
  hasDynamicStyle?: boolean;
  hasDynamicText?: boolean;
}

/**
 * Creates a metadata collection transform that extracts codegenNode information
 * @param componentName - Name of the component being compiled
 * @param metadataMap - Shared map to store metadata by component -> test ID
 * @param semanticNameMap - Shared map from test ID to semantic name (set by transform)
 * @param debug - Enable debug logging
 */
export function createMetadataCollectorTransform(
  componentName: string,
  metadataMap: Map<string, Map<string, ElementMetadata>>,
  semanticNameMap: Map<string, string>,
  debug = false,
  testIdAttribute: string = "data-testid",
): NodeTransform {
  const normalizedTestIdAttribute = (testIdAttribute ?? "data-testid").trim() || "data-testid";

  return (node, _context) => {
    // No entry logic - we only care about the exit phase
    // Return an exit function that will run AFTER transformElement
    return () => {
      if (node.type !== NodeTypes.ELEMENT) {
        return;
      }

      const element = node as ElementNode;

      // Access codegenNode - should now exist after transformElement ran
      if (debug) {
        const debugTestId = getTestIdFromProp(findDataTestIdProp(element, normalizedTestIdAttribute));
        console.log(`  [metadata] Checking <${element.tag}> (tagType=${element.tagType}) testId="${debugTestId ?? ""}"`);
        console.log(`    codegenNode exists: ${Boolean(element.codegenNode)}`);
        if (element.codegenNode) {
          const maybeCodegen = element.codegenNode as { type?: number } | null;
          console.log(`    codegenNode.type: ${maybeCodegen?.type}`);
        }
      }

      const metadata = tryCreateElementMetadata({
        element,
        semanticNameMap,
        debug,
        debugPrefix: "[metadata]",
        preferJsonParseFailureAsContentArray: false,
        testIdAttribute: normalizedTestIdAttribute,
      });

      if (!metadata) {
        return;
      }

      if (!metadataMap.has(componentName)) {
        metadataMap.set(componentName, new Map());
      }

      metadataMap.get(componentName)!.set(metadata.testId, metadata);
    };
  };
}
