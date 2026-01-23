import type {
  AttributeNode,
  DirectiveNode,
  ElementNode,
  SimpleExpressionNode,
  VNodeCall,
} from "@vue/compiler-core";
import { NodeTypes } from "@vue/compiler-core";
import { isSimpleExpressionNode } from "./compiler/ast-guards";
import type { ElementMetadata } from "./metadata-collector";

export type DataTestIdProp = AttributeNode | DirectiveNode | undefined;

export function findDataTestIdProp(element: ElementNode, attributeName: string = "data-testid"): DataTestIdProp {
  return element.props.find(prop =>
    (prop.type === NodeTypes.ATTRIBUTE && prop.name === attributeName)
    || (prop.type === NodeTypes.DIRECTIVE
      && prop.name === "bind"
      && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && prop.arg.content === attributeName),
  ) as AttributeNode | DirectiveNode | undefined;
}

export function getTestIdFromProp(prop: DataTestIdProp): string | null {
  if (!prop) {
    return null;
  }

  if (prop.type === NodeTypes.ATTRIBUTE) {
    return prop.value ? prop.value.content : null;
  }

  if (prop.type === NodeTypes.DIRECTIVE) {
    return prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.exp.content : null;
  }

  return null;
}

export function parseDynamicProps(dynamicProps: string | SimpleExpressionNode | undefined): string[] | undefined {
  if (!dynamicProps) {
    return undefined;
  }

  if (typeof dynamicProps === "string") {
    // Avoid string.split(); this package enforces AST/structured parsing.
    // Vue sometimes encodes dynamic props as a comma-delimited string.
    const parts: string[] = [];
    let current = "";
    for (let i = 0; i < dynamicProps.length; i++) {
      const ch = dynamicProps[i];
      if (ch === ",") {
        const token = current.trim();
        if (token.length)
          parts.push(token);
        current = "";
        continue;
      }
      current += ch;
    }
    const last = current.trim();
    if (last.length)
      parts.push(last);
    return parts;
  }

  if (isSimpleExpressionNode(dynamicProps)) {
    const content = dynamicProps.content;

    if (content.startsWith("[") && content.endsWith("]")) {
      try {
        return JSON.parse(content);
      }
      catch {
        // Preserve previous behavior differences:
        // - metadata-collector returned [] on parse failure
        // - compiler-wrapper returned [content]
        // We return undefined here and let callers choose a fallback.
        return undefined;
      }
    }

    return [content];
  }

  return undefined;
}

export function tryCreateElementMetadata(args: {
  element: ElementNode;
  semanticNameMap: Map<string, string>;
  debug: boolean;
  debugPrefix: string;
  preferJsonParseFailureAsContentArray: boolean;
  testIdAttribute?: string;
}): ElementMetadata | null {
  const { element, semanticNameMap, debug, debugPrefix, preferJsonParseFailureAsContentArray } = args;
  const testIdAttribute = (args.testIdAttribute ?? "data-testid").trim() || "data-testid";

  const testIdProp = findDataTestIdProp(element, testIdAttribute);
  if (!testIdProp) {
    return null;
  }

  const testId = getTestIdFromProp(testIdProp);
  if (!testId) {
    return null;
  }

  if (!element.codegenNode || element.codegenNode.type !== NodeTypes.VNODE_CALL) {
    return null;
  }

  const codegenNode = element.codegenNode as VNodeCall;
  const patchFlag = codegenNode.patchFlag;

  let dynamicPropsList = parseDynamicProps(codegenNode.dynamicProps);

  // Preserve each caller's prior behavior for JSON parse failures.
  if (!dynamicPropsList
    && codegenNode.dynamicProps
    && typeof codegenNode.dynamicProps !== "string"
    && isSimpleExpressionNode(codegenNode.dynamicProps)) {
    const content = codegenNode.dynamicProps.content;
    if (content.startsWith("[") && content.endsWith("]")) {
      dynamicPropsList = preferJsonParseFailureAsContentArray ? [content] : [];
    }
  }

  const semanticName = semanticNameMap.get(testId);
  if (!semanticName) {
    if (debug) {
      // console.warn(`${debugPrefix} ⚠️ No semantic name found for testId="${testId}"`);
    }
    return null;
  }

  const metadata: ElementMetadata = {
    testId,
    semanticName,
    tag: element.tag,
    tagType: element.tagType,
    patchFlag,
    dynamicProps: dynamicPropsList,
    // Decode patch flags (bitwise) - preserved as-is from existing code.
    hasClickHandler: patchFlag ? Boolean(patchFlag & 32) : undefined,
    hasDynamicClass: patchFlag ? Boolean(patchFlag & 2) : undefined,
    hasDynamicStyle: patchFlag ? Boolean(patchFlag & 4) : undefined,
    hasDynamicText: patchFlag ? Boolean(patchFlag & 1) : undefined,
  };

  if (debug) {
    console.log(`  ${debugPrefix} ✅ <${element.tag}> testId="${testId}"`);
    console.log(`    patchFlag: ${patchFlag}`);
    console.log(`    dynamicProps: ${dynamicPropsList?.join(", ") || "none"}`);
  }

  return metadata;
}
