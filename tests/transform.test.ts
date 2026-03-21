// @vitest-environment node
import type { AttributeNode, DirectiveNode, ElementNode, ForNode, RootNode, TemplateChildNode } from '@vue/compiler-core'
import type { Node as BabelNode } from '@babel/types'

import fs from 'node:fs'
import os from 'node:os'
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

  it('preserves simple member-expression data-testid when existingIdBehavior is preserve', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()

    expect(() => {
      compileAndCaptureAst(
        `
          <div>
            <template v-for="p in items">
              <DynamicFormField
                v-if="p.showField"
                :key="p.parameter.name"
                :data-testid="p.parameter.name"
              />
            </template>
          </div>
        `,
        {
          filename: '/src/components/MyComp.vue',
          nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, { DynamicFormField: { role: 'input' } }, [], '/src/views', { existingIdBehavior: 'preserve' })],
        },
      )
    }).not.toThrow()
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

  it('ignores singleton :key values when generating click test ids', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      '<button :key="activeTab" @click="select">Select</button>',
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Select-button')
  })

  it('preserves static data-testid values on singleton keyed elements', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      '<button :key="activeTab" data-testid="target-visibility-selector" @click="select">Select</button>',
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('target-visibility-selector')
  })

  it('injects a stable keyed test id for scoped slot data objects', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      `
        <DxDataGrid :data-source="items" key-expr="id">
          <DxColumn cell-template="selectCell" />
          <template #selectCell="{ data }">
            <AylaButton @click="openProject(data.data)">Select</AylaButton>
          </template>
        </DxDataGrid>
      `,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('`MyComp-${data.key ?? data.data?.id ?? data.id ?? data.value ?? data}-OpenProject-button`')
  })

  it('injects native input test ids from static ids before falling back to v-model', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      `
        <div>
          <label for="txbClientName">Client Name</label>
          <input id="txbClientName" v-model="state.clientName" type="text" />
        </div>
      `,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    expect(findFirstDataTestId(ast)).toBe('MyComp-txbClientName-input')
  })

  it('injects native select test ids from static ids', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      `
        <div>
          <label for="modal-kind">Search Type</label>
          <select id="modal-kind" v-model="state.kind">
            <option>Folder Search</option>
            <option>Tag Search</option>
          </select>
        </div>
      `,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    expect(findFirstDataTestId(ast)).toBe('MyComp-modal-kind-select')
  })

  it('injects native input test ids from wrapping label text when no id exists', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      `
        <label>
          <span>File Name*</span>
          <input v-model="state.createFile.projectName" type="text" />
        </label>
      `,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    expect(findFirstDataTestId(ast)).toBe('MyComp-FileName-input')
  })

  it('injects native radio test ids using v-model context plus the option label', () => {
    const componentHierarchyMap = new Map()

    const ast = compileAndCaptureAst(
      `
        <label>
          <input v-model="state.createFile.copyAnswersChoice" type="radio" value="no" />
          No
        </label>
      `,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    expect(findFirstDataTestId(ast)).toBe('MyComp-StateCreateFileCopyAnswersChoiceNo-radio')
  })

  it('merges @click POM members by click handler identity when nameCollisionBehavior is error', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()

    // In this fixture, both buttons use the same @click handler expression.
    // With nameCollisionBehavior="error" we expect compilation to succeed because the generator
    // merges by click handler identity instead of trying to disambiguate names.
    expect(() => {
      compileAndCaptureAst(
        readFixtureTemplate('MyComp_CancelButtons_InnerText.vue'),
        {
          filename: '/src/components/MyComp.vue',
          nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views', { nameCollisionBehavior: 'error' })],
        },
      )
    }).not.toThrow()

    const deps = componentHierarchyMap.get('MyComp') as IComponentDependencies | undefined
    expect(deps).toBeTruthy()

    // Ensure we get a single merged click method.
    expect(deps?.generatedMethods?.has('clickCancel')).toBe(true)
    expect(deps?.generatedMethods?.has('clickTerminate')).toBe(false)
    expect(deps?.generatedMethods?.has('clickRequestCancellation')).toBe(false)

    // Ensure only one primary POM spec is emitted for the merged action.
    const cancelPoms = Array.from(deps?.dataTestIdSet ?? [])
      .map(e => e.pom)
      .filter((p): p is NonNullable<typeof p> => !!p && p.methodName === 'Cancel')
    const primaries = cancelPoms.filter(p => p.emitPrimary !== false)
    const mergedSecondaries = cancelPoms.filter(p => p.emitPrimary === false)
    expect(primaries.length).toBe(1)
    expect(mergedSecondaries.length).toBe(1)
  })

  it('merges same-role wrapper members across one v-if chain in strict mode', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const nativeWrappers: NativeWrappersMap = {
      DynamicFormFieldTextInput: { role: 'input' },
      DynamicFormFieldNumberInput: { role: 'input' },
    }

    expect(() => {
      compileAndCaptureAst(
        `
          <DynamicFormFieldTextInput
            v-if="parameterType === 'text'"
            v-model="fieldValue"
          />
          <DynamicFormFieldNumberInput
            v-else-if="parameterType === 'number'"
            v-model="fieldValue"
          />
        `,
        {
          filename: '/src/components/DynamicFormField.vue',
          nodeTransforms: [createTestIdTransform('DynamicFormField', componentHierarchyMap, nativeWrappers, [], '/src/views', { nameCollisionBehavior: 'error' })],
        },
      )
    }).not.toThrow()

    const deps = componentHierarchyMap.get('DynamicFormField') as IComponentDependencies | undefined
    expect(deps).toBeTruthy()
    expect(deps?.generatedMethods?.has('typeFieldValue')).toBe(true)
    expect(deps?.generatedMethods?.has('typeFieldValue2')).toBe(false)

    const fieldValuePoms = Array.from(deps?.dataTestIdSet ?? [])
      .map(e => e.pom)
      .filter((p): p is NonNullable<typeof p> => !!p && p.methodName === 'FieldValue')
    expect(fieldValuePoms.length).toBe(2)

    const primary = fieldValuePoms.find(p => p.emitPrimary !== false)
    const mergedSecondary = fieldValuePoms.find(p => p.emitPrimary === false)
    expect(primary?.formattedDataTestId).toBe('DynamicFormField-FieldValue-input')
    expect(primary?.mergeKey).toContain('wrapper:ifgroup:')
    expect(primary?.mergeKey).toContain(':model:FieldValue')
    expect(primary?.alternateFormattedDataTestIds).toBeUndefined()
    expect(mergedSecondary?.emitPrimary).toBe(false)
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

    const deps = componentHierarchyMap.get('MyComp') as IComponentDependencies | undefined
    expect(deps).toBeTruthy()

    const sigOne = deps?.generatedMethods?.get('clickOneButton') as { params: string, argNames: string[] } | null | undefined
    expect(sigOne?.params).toBe('wait: boolean = true')
    expect(sigOne?.argNames).toEqual(['wait'])

    const sigTwo = deps?.generatedMethods?.get('clickTwoButton') as { params: string, argNames: string[] } | null | undefined
    expect(sigTwo?.params).toBe('wait: boolean = true')
    expect(sigTwo?.argNames).toEqual(['wait'])

    // With the IR-based generator, v-for static literal keys are represented as extra click method specs.
    const extras = deps?.pomExtraMethods ?? []
    const one = extras.find(m => m.kind === 'click' && m.name === 'clickOneButton')
    expect(one).toBeTruthy()
    expect(one?.keyLiteral).toBe('One')
    expect(one?.selector).toEqual({
      kind: 'testId',
      formattedDataTestId: 'MyComp-${key}-Select-button',
    })
    expect(one?.params).toEqual({ wait: 'boolean = true' })

    const two = extras.find(m => m.kind === 'click' && m.name === 'clickTwoButton')
    expect(two).toBeTruthy()
    expect(two?.keyLiteral).toBe('Two')
    expect(two?.selector).toEqual({
      kind: 'testId',
      formattedDataTestId: 'MyComp-${key}-Select-button',
    })
    expect(two?.params).toEqual({ wait: 'boolean = true' })
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

  it('infers radio wrappers through nested local SFCs without nativeWrappers config', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-transform-'))
    const radioPath = path.join(tempRoot, 'src', 'components', 'ImmyRadio.vue')
    const radioGroupPath = path.join(tempRoot, 'src', 'components', 'ImmyRadioGroup.vue')
    fs.mkdirSync(path.dirname(radioPath), { recursive: true })
    fs.writeFileSync(radioPath, '<template><div><input type="radio" /></div></template>')
    fs.writeFileSync(
      radioGroupPath,
      '<template><div><ImmyRadio v-for="option in props.options" :key="option.value" :text="option.text" :modelValue="option.value" /></div></template>',
    )

    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const vueFilesPathMap = new Map<string, string>([
      ['ImmyRadio', radioPath],
      ['ImmyRadioGroup', radioGroupPath],
    ])

    const ast = compileAndCaptureAst(
      '<ImmyRadioGroup :options="[\'Cloud\', \'Local\']" v-model="databaseType" />',
      {
        filename: path.join(tempRoot, 'src', 'views', 'MyPage.vue'),
        nodeTransforms: [createTestIdTransform('MyPage', componentHierarchyMap, {}, [], path.join(tempRoot, 'src', 'views'), { vueFilesPathMap })],
      },
    )

    expect(ast.children[0]?.type).toBe(NodeTypes.ELEMENT)
    const radioGroupEl = ast.children[0] as ElementNode

    const dataTestIdAttr = radioGroupEl.props.find(
      (p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === 'data-testid',
    )
    expect(dataTestIdAttr?.value?.content).toBe('MyPage-DatabaseType-radio')

    const optionPrefixAttr = radioGroupEl.props.find(
      (p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === 'option-data-testid-prefix',
    )
    expect(optionPrefixAttr).toBeUndefined()

    const deps = componentHierarchyMap.get('MyPage')
    expect(deps).toBeTruthy()

    const extras = deps?.pomExtraMethods ?? []
    expect(extras.some(m => m.kind === 'click' && m.name === 'selectDatabaseTypeCloud')).toBe(true)
    expect(extras).toContainEqual({
      kind: 'click',
      name: 'selectDatabaseTypeCloud',
      selector: {
        kind: 'withinTestIdByLabel',
        rootFormattedDataTestId: 'MyPage-DatabaseType-radio',
        formattedLabel: 'Cloud',
        exact: true,
      },
      params: { annotationText: 'string = ""' },
    })
  })

  it('does not infer sibling wrapper radios without configured search roots', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-monorepo-'))
    const frontendRoot = path.join(tempRoot, 'frontend')
    const sharedComponentsRoot = path.join(tempRoot, 'shared', 'ui', 'src', 'components')
    const radioPath = path.join(sharedComponentsRoot, 'SharedRadio.vue')
    const radioGroupPath = path.join(sharedComponentsRoot, 'SharedRadioGroup.vue')
    fs.mkdirSync(path.dirname(radioPath), { recursive: true })
    fs.mkdirSync(path.join(frontendRoot, 'src', 'views'), { recursive: true })
    fs.writeFileSync(radioPath, '<template><div><input type="radio" /></div></template>')
    fs.writeFileSync(
      radioGroupPath,
      '<template><div><SharedRadio v-for="option in props.options" :key="option.value" :text="option.text" :modelValue="option.value" /></div></template>',
    )

    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const ast = compileAndCaptureAst(
      '<SharedRadioGroup :options="[\'Cloud\', \'Local\']" v-model="databaseType" />',
      {
        filename: path.join(frontendRoot, 'src', 'views', 'MyPage.vue'),
        nodeTransforms: [createTestIdTransform('MyPage', componentHierarchyMap, {}, [], path.join(frontendRoot, 'src', 'views'))],
      },
    )

    expect(ast.children[0]?.type).toBe(NodeTypes.ELEMENT)
    const radioGroupEl = ast.children[0] as ElementNode

    const dataTestIdAttr = radioGroupEl.props.find(
      (p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === 'data-testid',
    )
    expect(dataTestIdAttr).toBeUndefined()

    const extras = componentHierarchyMap.get('MyPage')?.pomExtraMethods ?? []
    expect(extras.some(method => method.kind === 'click' && method.name === 'selectDatabaseTypeCloud')).toBe(false)
  })

  it('infers sibling wrapper radios from configured search roots without vueFilesPathMap', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-monorepo-'))
    const frontendRoot = path.join(tempRoot, 'frontend')
    const sharedComponentsRoot = path.join(tempRoot, 'shared', 'ui', 'src', 'components')
    const radioPath = path.join(sharedComponentsRoot, 'SharedRadio.vue')
    const radioGroupPath = path.join(sharedComponentsRoot, 'SharedRadioGroup.vue')
    fs.mkdirSync(path.dirname(radioPath), { recursive: true })
    fs.mkdirSync(path.join(frontendRoot, 'src', 'views'), { recursive: true })
    fs.writeFileSync(radioPath, '<template><div><input type="radio" /></div></template>')
    fs.writeFileSync(
      radioGroupPath,
      '<template><div><SharedRadio v-for="option in props.options" :key="option.value" :text="option.text" :modelValue="option.value" /></div></template>',
    )

    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const ast = compileAndCaptureAst(
      '<SharedRadioGroup :options="[\'Cloud\', \'Local\']" v-model="databaseType" />',
      {
        filename: path.join(frontendRoot, 'src', 'views', 'MyPage.vue'),
        nodeTransforms: [createTestIdTransform('MyPage', componentHierarchyMap, {}, [], path.join(frontendRoot, 'src', 'views'), {
          wrapperSearchRoots: [sharedComponentsRoot],
        })],
      },
    )

    expect(ast.children[0]?.type).toBe(NodeTypes.ELEMENT)
    const radioGroupEl = ast.children[0] as ElementNode

    const dataTestIdAttr = radioGroupEl.props.find(
      (p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === 'data-testid',
    )
    expect(dataTestIdAttr?.value?.content).toBe('MyPage-DatabaseType-radio')

    const deps = componentHierarchyMap.get('MyPage')
    expect(deps?.pomExtraMethods).toContainEqual({
      kind: 'click',
      name: 'selectDatabaseTypeCloud',
      selector: {
        kind: 'withinTestIdByLabel',
        rootFormattedDataTestId: 'MyPage-DatabaseType-radio',
        formattedLabel: 'Cloud',
        exact: true,
      },
      params: { annotationText: 'string = ""' },
    })
  })
})
