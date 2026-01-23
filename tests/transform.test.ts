// @vitest-environment node
import type { AttributeNode, DirectiveNode, ElementNode, ForNode, RootNode, TemplateChildNode } from '@vue/compiler-core'
import type { Node as BabelNode } from '@babel/types'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CompilerOptions } from '@vue/compiler-dom'
import type { IComponentDependencies, NativeWrappersMap } from '../utils'
import { ConstantTypes, NodeTypes } from '@vue/compiler-core'
import { baseCompile, parserOptions } from '@vue/compiler-dom'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { extend } from '@vue/shared'

import { describe, expect, it } from 'vitest'
import { createTestIdTransform } from '../transform'



const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

function readFixtureTemplate(fixtureName: string): string {
  const filePath = path.join(fixturesDir, fixtureName)
  const content = fs.readFileSync(filePath, 'utf8')
  const { descriptor } = parseSfc(content, { filename: filePath })
  if (!descriptor.template) {
    throw new Error(`Fixture ${fixtureName} is missing a <template> block`)
  }
  return descriptor.template.content.trim()
}



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
  it('injects html attributes and collects ids', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()

    const ast = compileAndCaptureAst(
      readFixtureTemplate('MyComp_SaveButton.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Save-button')

    const deps = componentHierarchyMap.get('MyComp')
    expect(deps).toBeTruthy()
    expect(Array.from(deps!.dataTestIdSet).some(e => e.value === 'MyComp-Save-button')).toBe(true)
  })

  it('preserves existing data-testid when existingIdBehavior is preserve', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()

    const ast = compileAndCaptureAst(
      readFixtureTemplate('MyComp_SaveButton_ExistingTestId.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views', { existingIdBehavior: 'preserve' })],
      },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('already')
  })

  it('overwrites existing data-testid when existingIdBehavior is overwrite', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()

    const ast = compileAndCaptureAst(
      readFixtureTemplate('MyComp_SaveButton_ExistingTestId.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views', { existingIdBehavior: 'overwrite' })],
      },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Save-button')
  })

  it('throws when existingIdBehavior is error and data-testid already exists', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()

    expect(() => {
      compileAndCaptureAst(
        readFixtureTemplate('MyComp_SaveButton_ExistingTestId.vue'),
        {
          filename: '/src/components/MyComp.vue',
          nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views', { existingIdBehavior: 'error' })],
        },
      )
    }).toThrow()
  })

  it('injects a RouterLink :to test id early', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      readFixtureTemplate('MyComp_RouterLinkUsers.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Users-routerlink')
  })

  it('injects a dynamic @click test id including :key placeholder', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      readFixtureTemplate('MyComp_SelectButton_DynamicKey.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    // For dynamic bindings, Vue stores directive exp as a string. We expect the exact backticked template string.
    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('`MyComp-${item.id}-Select-button`')
  })

  it('emits per-key click methods when v-for iterates a static literal list', () => {
    const componentHierarchyMap = new Map()

    compileAndCaptureAst(
      readFixtureTemplate('MyComp_SelectButton_StaticList.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    const deps = componentHierarchyMap.get('MyComp') as { generatedMethods?: Map<string, { params: string, argNames: string[] } | null>, methodsContent?: string } | undefined
    expect(deps).toBeTruthy()

    const sigOne = deps?.generatedMethods?.get('clickOneButton') as { params: string, argNames: string[] } | null | undefined
    expect(sigOne?.params).toBe('wait: boolean = true')
    expect(sigOne?.argNames).toEqual(['wait'])

    const sigTwo = deps?.generatedMethods?.get('clickTwoButton') as { params: string, argNames: string[] } | null | undefined
    expect(sigTwo?.params).toBe('wait: boolean = true')
    expect(sigTwo?.argNames).toEqual(['wait'])

    // Ensure the emitted implementations bind a concrete key and reuse the template literal.
    const methods = deps?.methodsContent ?? ''
    expect(methods).toContain('async clickOneButton(wait: boolean = true)')
    expect(methods).toContain('const key = "One"')
    expect(methods).toContain('async clickTwoButton(wait: boolean = true)')
    expect(methods).toContain('const key = "Two"')
    expect(methods).toContain('clickByTestId(`MyComp-${key}-Select-button`')
  })

  it('treats v-for source with Math.random() as dynamic via constType', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      readFixtureTemplate('MyComp_GoButton_RandomList.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    const forNode = ast.children.find((c): c is ForNode => c.type === NodeTypes.FOR)

    expect(forNode).toBeTruthy()

    // When `prefixIdentifiers` is enabled, Vue's `transformExpression` often rewrites
    // expressions containing identifiers (like `Math.random()`) into a COMPOUND_EXPRESSION.
    // That means the *source expression itself* won't always be a SimpleExpressionNode.
    //
    // We still assert dynamic-ness via Vue's const analysis by ensuring the compound contains
    // at least one SimpleExpressionNode with constType NOT_CONSTANT.
    const collectSimpleExpressions = (node: any): Array<{ constType?: number }> => {
      if (!node || typeof node !== 'object' || !('type' in node)) {
        return []
      }

      if (node.type === NodeTypes.SIMPLE_EXPRESSION) {
        return [node]
      }

      if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
        const out: Array<{ constType?: number }> = []
        for (const child of node.children || []) {
          if (child && typeof child === 'object') {
            out.push(...collectSimpleExpressions(child))
          }
        }
        return out
      }

      return []
    }

    const sourceType = forNode?.source?.type
    expect([NodeTypes.SIMPLE_EXPRESSION, NodeTypes.COMPOUND_EXPRESSION]).toContain(sourceType)

    const simpleParts = collectSimpleExpressions(forNode?.source)
    expect(simpleParts.length).toBeGreaterThan(0)
    expect(simpleParts.some(p => p.constType === ConstantTypes.NOT_CONSTANT)).toBe(true)

    // Also ensure our generator does NOT attempt static-list key narrowing here.
    const deps = componentHierarchyMap.get('MyComp') as { generatedMethods?: Map<string, { params: string, argNames: string[] } | null> } | undefined
    expect(deps).toBeTruthy()
    const sig = deps?.generatedMethods?.get('clickDoThingByKey') as { params: string, argNames: string[] } | null | undefined
    expect(sig?.params).toBe('key: string')
  })

  it('does not populate exp.ast in this test harness even when prefixIdentifiers is enabled', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      readFixtureTemplate('MyComp_SelectButton_DynamicKey.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
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
      readFixtureTemplate('MyComp_VSelect.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', new Map(), nativeWrappers, [], '/src/views')],
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
