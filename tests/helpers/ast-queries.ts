// Shared AST query helpers for tests — the inline `props.find(...)` closures
// these replace are the repo's most-repeated test scaffolding.

import type { AttributeNode, DirectiveNode, ElementNode } from '@vue/compiler-core'
import { NodeTypes } from '@vue/compiler-core'

/** Find a static attribute by name (no `:bound` directives). */
export function findStaticAttr(el: ElementNode, name: string): AttributeNode | undefined {
  return el.props.find((p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === name)
}

/** Find a `:bind` directive whose argument is `argName` (e.g. `:data-testid`). */
export function findBindDirective(node: ElementNode, argName: string): DirectiveNode | undefined {
  return node.props.find((p): p is DirectiveNode =>
    p.type === NodeTypes.DIRECTIVE
    && p.name === 'bind'
    && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION
    && p.arg.content === argName)
}

/** The first ELEMENT child of a root, typed as an element (tests assert it exists first). */
export function firstElement(root: { children?: unknown[] }): ElementNode {
  const child = root.children?.[0]
  if (!child || typeof child !== 'object' || (child as { type?: number }).type !== NodeTypes.ELEMENT) {
    throw new Error('expected the template root to start with an element')
  }
  return child as ElementNode
}
