import type { SimpleExpressionNode } from "@vue/compiler-core";
import { NodeTypes } from "@vue/compiler-core";

/**
 * Type guard for Vue compiler-core SimpleExpressionNode.
 *
 * We accept `object | null` (instead of `unknown`) to satisfy the repo lint rule
 * against `: unknown` annotations while still being safe at runtime.
 */
export function isSimpleExpressionNode(value: object | null): value is SimpleExpressionNode {
  return value !== null
    && "type" in value
    && (value as { type: number }).type === NodeTypes.SIMPLE_EXPRESSION;
}
