import type { AttributeNode, DirectiveNode, ElementNode, RootNode, TemplateChildNode } from '@vue/compiler-core'
import type { Node as BabelNode } from '@babel/types'

import type { CompilerOptions } from '@vue/compiler-dom'
import type { NativeWrappersMap } from '../utils'
import { NodeTypes } from '@vue/compiler-core'
import { baseCompile, parserOptions } from '@vue/compiler-dom'
import { extend } from '@vue/shared'

import { describe, expect, it } from 'vitest'
import { createTestIdTransform } from '../transform'



function compileAndCaptureAst(source: string, options: CompilerOptions & { filename: string }): RootNode {
  let captured: RootNode | null = null

  baseCompile(
    source,
    extend({}, parserOptions, options, {
      // When enabled, compiler-core runs `transformExpression` which parses directive expressions
      // (via @babel/parser) and populates `exp.ast` for later consumers.
      prefixIdentifiers: true,
      nodeTransforms: [
        ...(options.nodeTransforms || []),
        // Capture the root node after all transforms have run.
        (node: RootNode | TemplateChildNode) => {
          if (node.type === NodeTypes.ROOT) {
            return () => {
              captured = node as RootNode
            }
          }
        },
      ],
    }),
  )

  if (!captured) {
    throw new Error('Failed to capture compiler AST')
  }

  return captured
}

function findFirstDataTestIdDirectiveExpAst(root: RootNode): BabelNode | null | false | undefined {
  let found: BabelNode | null | false | undefined

  const isNodeWithType = (value: object | null): value is { type: number } =>
    value !== null && 'type' in value

  const visit = (node: object | null) => {
    if (found !== undefined) {
      return
    }

    if (!isNodeWithType(node)) {
      return
    }

    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode
      const prop = el.props.find(
        (p): p is DirectiveNode =>
          p.type === NodeTypes.DIRECTIVE
          && p.name === 'bind'
          && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION
          && p.arg.content === 'data-testid',
      )

      if (prop?.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
        found = prop.exp.ast as BabelNode
        return
      }

      for (const child of el.children || []) {
        visit(child)
        if (found !== undefined) {
          return
        }
      }
    }

    if (node.type === NodeTypes.ROOT) {
      const rootNode = node as RootNode
      for (const child of rootNode.children || []) {
        visit(child)
        if (found !== undefined) {
          return
        }
      }
    }

    if (node.type === NodeTypes.IF) {
      for (const b of (node as { branches?: unknown[] }).branches || []) {
        visit(typeof b === 'object' && b !== null ? b : null)
        if (found !== undefined) {
          return
        }
      }
    }

    if (node.type === NodeTypes.IF_BRANCH || node.type === NodeTypes.FOR) {
      for (const child of (node as { children?: unknown[] }).children || []) {
        visit(typeof child === 'object' && child !== null ? child : null)
        if (found !== undefined) {
          return
        }
      }
    }
  }

  visit(root)
  return found
}

function findFirstDataTestId(root: RootNode): string | null {
  let found: string | null = null

  const isNodeWithType = (value: object | null): value is { type: number } =>
    value !== null && 'type' in value

  const stringifyDirectiveExp = (dir: DirectiveNode): string => {
    const exp = dir.exp
    if (!exp) {
      return ''
    }
    if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
      return exp.content
    }
    if (exp.type === NodeTypes.COMPOUND_EXPRESSION) {
      return exp.children
        .map((c) => {
          if (typeof c === 'string') {
            return c
          }
          if (typeof c === 'symbol') {
            return ''
          }

          if (c && typeof c === 'object' && 'type' in c) {
            const node = c as { type: number, content?: string }
            if (node.type === NodeTypes.SIMPLE_EXPRESSION) {
              return node.content ?? ''
            }
          }

          return ''
        })
        .join('')
    }
    return ''
  }

  const visit = (node: object | null) => {
    if (found) {
      return
    }

    if (!isNodeWithType(node)) {
      return
    }

    if (node?.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode
      const prop = el.props.find(p =>
        (p.type === NodeTypes.ATTRIBUTE && p.name === 'data-testid')
        || (p.type === NodeTypes.DIRECTIVE
          && p.name === 'bind'
          && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION
          && p.arg.content === 'data-testid'),
      )

      if (prop) {
        if (prop.type === NodeTypes.ATTRIBUTE) {
          const attr = prop as AttributeNode
          found = attr.value?.content ?? ''
          return
        }
        if (prop.type === NodeTypes.DIRECTIVE) {
          found = stringifyDirectiveExp(prop as DirectiveNode)
          return
        }
      }

      for (const child of el.children || []) {
        visit(child)
        if (found) {
          return
        }
      }
    }

    if (node.type === NodeTypes.ROOT) {
      const rootNode = node as RootNode
      for (const child of rootNode.children || []) {
        visit(child)
        if (found) {
          return
        }
      }
    }

    if (node.type === NodeTypes.IF) {
      for (const b of (node as { branches?: unknown[] }).branches || []) {
        visit(typeof b === 'object' && b !== null ? b : null)
        if (found) {
          return
        }
      }
    }

    if (node.type === NodeTypes.IF_BRANCH || node.type === NodeTypes.FOR) {
      for (const child of (node as { children?: unknown[] }).children || []) {
        visit(typeof child === 'object' && child !== null ? child : null)
        if (found) {
          return
        }
      }
    }
  }

  visit(root)
  return found
}

describe('createTestIdTransform', () => {
  it('injects a RouterLink :to test id early', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      `<RouterLink :to="{ name: 'users' }">Users</RouterLink>`,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap)],
      },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Users-routerlink')
  })

  it('injects a dynamic @click test id including :key placeholder', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      `<button v-for="item in items" :key="item.id" @click="select(item)">Select</button>`,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap)],
      },
    )

    // For dynamic bindings, Vue stores directive exp as a string. We expect the exact backticked template string.
    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('`MyComp-${item.id}-Select-button`')
  })

  it('does not populate exp.ast in this test harness even when prefixIdentifiers is enabled', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      `<button v-for="item in items" :key="item.id" @click="select(item)">Select</button>`,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap)],
      },
    )

    const expAst = findFirstDataTestIdDirectiveExpAst(ast)
    // Observed behavior: in this Vitest environment, the Vue compiler build in use
    // does not attach a Babel AST to directive expressions (exp.ast is undefined).
    // The injector therefore must not rely on exp.ast always being present.
    expect(expAst).toBeUndefined()
  })

  it('adds option-data-testid-prefix for option-driven native wrappers', () => {
    const nativeWrappers: NativeWrappersMap = {
      'v-select': {
        role: 'vselect',
        requiresOptionDataTestIdPrefix: true,
      },
    }

    const ast = compileAndCaptureAst(
      `<v-select v-model="selectedGroup" />`,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', new Map(), nativeWrappers)],
      },
    )

    // Sanity: ensure the compiler produced the expected element/tag.
    expect(ast.children[0]?.type).toBe(NodeTypes.ELEMENT)
    expect((ast.children[0] as ElementNode).tag).toBe('v-select')

    const selectEl = ast.children[0] as ElementNode

    const optionPrefixAttr = selectEl.props.find(
      (p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === 'option-data-testid-prefix',
    )
    expect(optionPrefixAttr?.value?.content).toBe('MyComp-SelectedGroup')

    const dataTestIdAttr = selectEl.props.find(
      (p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === 'data-testid',
    )
    expect(dataTestIdAttr?.value?.content).toBe('MyComp-SelectedGroup-vselect')
  })
})
