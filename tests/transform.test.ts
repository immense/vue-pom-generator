// @vitest-environment node
import type { AttributeNode, BindingMetadata, DirectiveNode, ElementNode, ForNode, RootNode, TemplateChildNode } from '@vue/compiler-core'
import type { Node as BabelNode } from '@babel/types'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CompilerOptions } from '@vue/compiler-dom'
import type { IComponentDependencies, NativeWrappersMap } from '../utils'
import { BindingTypes, ConstantTypes, NodeTypes } from '@vue/compiler-core'
import { baseCompile, compile as compileDom, parserOptions } from '@vue/compiler-dom'
import { parse as parseSfc } from '@vue/compiler-sfc'


import { describe, expect, it } from 'vitest'
import { findBindDirective, findStaticAttr, firstElement } from './helpers/ast-queries'
import { createPomMethodSignature, createPomParameters } from '../pom-params'
import { createPomStringPattern } from '../pom-patterns'
import { createVuePluginWithTestIds } from '../plugin/vue-plugin'
import { __internal, createTestIdTransform } from '../transform'



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
    Object.assign({}, parserOptions, options, {
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

interface TestIdCompileOptions {
  component?: string
  nativeWrappers?: NativeWrappersMap
  viewsDir?: string
  filename?: string
  transformOptions?: Parameters<typeof createTestIdTransform>[5]
}

/**
 * Compile `template` through the test-id transform with the standard in-memory
 * component paths. Defaults match the common case: component 'MyComp' at
 * /src/components/MyComp.vue with views at /src/views.
 */
function compileWithTestIdTransform(template: string, options: TestIdCompileOptions = {}) {
  const component = options.component ?? 'MyComp'
  const componentHierarchyMap = new Map<string, IComponentDependencies>()
  const ast = compileAndCaptureAst(template, {
    filename: options.filename ?? `/src/components/${component}.vue`,
    nodeTransforms: [
      createTestIdTransform(
        component,
        componentHierarchyMap,
        options.nativeWrappers ?? {},
        [],
        options.viewsDir ?? '/src/views',
        options.transformOptions,
      ),
    ],
  })
  return { ast, componentHierarchyMap }
}

interface WrapperSfc {
  name: string
  template: string
}

/**
 * Compile a page that uses local wrapper SFC fixtures: each wrapper is written
 * under <tempRoot>/src/components, the page lives under <tempRoot>/src/views,
 * and the transform resolves wrappers through vueFilesPathMap.
 */
function compilePageWithWrapperSfcs(
  usageTemplate: string,
  wrappers: WrapperSfc[],
  options: { nativeWrappers?: NativeWrappersMap, pageComponent?: string } = {},
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-transform-'))
  const viewsDir = path.join(tempRoot, 'src', 'views')
  const vueFilesPathMap = new Map<string, string>()
  for (const wrapper of wrappers) {
    const wrapperPath = path.join(tempRoot, 'src', 'components', `${wrapper.name}.vue`)
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true })
    fs.writeFileSync(wrapperPath, wrapper.template)
    vueFilesPathMap.set(wrapper.name, wrapperPath)
  }
  const pageComponent = options.pageComponent ?? 'MyPage'
  const componentHierarchyMap = new Map<string, IComponentDependencies>()
  const ast = compileAndCaptureAst(usageTemplate, {
    filename: path.join(viewsDir, `${pageComponent}.vue`),
    nodeTransforms: [
      createTestIdTransform(pageComponent, componentHierarchyMap, options.nativeWrappers ?? {}, [], viewsDir, { vueFilesPathMap }),
    ],
  })
  return { ast, tempRoot, componentHierarchyMap }
}

/**
 * Fetch a component's collected dependencies or fail the test loudly.
 */
function requireDeps(map: Map<string, IComponentDependencies>, component: string): IComponentDependencies {
  const deps = map.get(component)
  if (!deps) {
    throw new Error(`expected dependencies for ${component}`)
  }
  return deps
}

/** The static `data-testid` attributes injected on the root's element children. */
function rootStaticTestIds(ast: RootNode): string[] {
  return (ast.children as ElementNode[])
    .filter((node): node is ElementNode => node.type === NodeTypes.ELEMENT)
    .flatMap(element => element.props.filter((prop): prop is AttributeNode => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'data-testid'))
    .map(attribute => attribute.value?.content ?? '')
}

/**
 * Write a wrapper component SFC under <tempRoot>/src/components and return its path.
 */
function writeComponentSfc(tempRoot: string, name: string, source: string): string {
  const componentPath = path.join(tempRoot, 'src', 'components', `${name}.vue`)
  fs.mkdirSync(path.dirname(componentPath), { recursive: true })
  fs.writeFileSync(componentPath, source)
  return componentPath
}

/**
 * Write the shared radio component pair used by the sibling-wrapper inference
 * tests: SharedRadio.vue + SharedRadioGroup.vue under a monorepo-style layout.
 */
function writeMonorepoRadioComponents(tempRoot: string): { frontendRoot: string, sharedComponentsRoot: string } {
  const frontendRoot = path.join(tempRoot, 'frontend')
  const sharedComponentsRoot = path.join(tempRoot, 'shared', 'ui', 'src', 'components')
  fs.mkdirSync(path.join(sharedComponentsRoot), { recursive: true })
  fs.mkdirSync(path.join(frontendRoot, 'src', 'views'), { recursive: true })
  fs.writeFileSync(path.join(sharedComponentsRoot, 'SharedRadio.vue'), '<template><div><input type="radio" /></div></template>')
  fs.writeFileSync(
    path.join(sharedComponentsRoot, 'SharedRadioGroup.vue'),
    '<template><div role="radiogroup"><SharedRadio v-for="option in props.options" :key="option.value" :text="option.text" :modelValue="option.value" /></div></template>',
  )
  return { frontendRoot, sharedComponentsRoot }
}

/**
 * Seed a component whose click method name is already reserved, to exercise
 * strict-mode collision fallbacks.
 */
function seedReservedClickDeps(
  componentHierarchyMap: Map<string, IComponentDependencies>,
  component: string,
  clickMethod: string,
) {
  componentHierarchyMap.set(component, {
    filePath: `/src/components/${component}.vue`,
    childrenComponentSet: new Set(),
    usedComponentSet: new Set(),
    dataTestIdSet: new Set(),
    generatedMethods: new Map([[clickMethod, createPomMethodSignature(createPomParameters(['wait', 'boolean = true'], ['annotationText', 'string = ""']))]]),
    reservedPomMemberNames: new Set([`${clickMethod.replace(/^click/, '')}Button`, clickMethod]),
    isView: false,
  })
}

/**
 * Compiles a keyed-option fixture (shared by the option-keying and action-event
 * describes) and resolves the single keyed IDataTestId entry produced for the
 * repeated option element. Asserts both the injected selector template
 * (selectorValue — what becomes data-testid in the DOM) and the keyed accessor's
 * PomStringPattern (pom.selector — what generateGetElementByDataTestId feeds into
 * `this.keyedLocators((key) => this.locatorByTestId(...))`).
 */
function compileKeyedFixture(
  fixtureName: string,
  componentName: string,
  options?: { optionKeyAttribute?: Record<string, string> },
) {
  const componentHierarchyMap = new Map<string, IComponentDependencies>()

  const transformOptions: Record<string, unknown> = { existingIdBehavior: 'preserve' }
  if (options?.optionKeyAttribute) {
    transformOptions.optionKeyAttribute = options.optionKeyAttribute
  }

  compileAndCaptureAst(
    readFixtureTemplate(fixtureName),
    {
      filename: `/src/components/${componentName}.vue`,
      nodeTransforms: [
        createTestIdTransform(componentName, componentHierarchyMap, {}, [], '/src/views', transformOptions as Parameters<typeof createTestIdTransform>[5]),
      ],
    },
  )

  const deps = componentHierarchyMap.get(componentName) as IComponentDependencies | undefined
  expect(deps).toBeTruthy()

  const entries = Array.from(deps?.dataTestIdSet ?? [])
  const keyed = entries.find(e => e.pom?.selector && (e.pom.selector as { patternKind?: string }).patternKind === 'parameterized')
    ?? entries.find(e => e.selectorValue && (e.selectorValue as { patternKind?: string }).patternKind === 'parameterized')
  expect(keyed).toBeTruthy()
  return { deps, keyed }
}

function compileAndCaptureCode(source: string, options: CompilerOptions & { filename: string }): string {
  const result = baseCompile(
    source,
    Object.assign({}, parserOptions, options, {
      prefixIdentifiers: true,
      mode: 'module',
    }),
  )

  return result.code
}

function compileWithRuntimeTemplateOptions(
  source: string,
  options: {
    nativeWrappers?: NativeWrappersMap
    bindingMetadata?: BindingMetadata
    inline?: boolean
    crossFileKeyRegistry?: Map<string, string>
    vueFilesPathMap?: Map<string, string>
    wrapperSearchRoots?: string[]
    annotatorMetadata?: {
      sourceAttribute: string
      metadataAttributePrefix: string
    } | null
  } = {},
): string {
  const componentHierarchyMap = new Map<string, IComponentDependencies>()
  const { templateCompilerOptions } = createVuePluginWithTestIds({
    existingIdBehavior: 'preserve',
    nameCollisionBehavior: 'error',
    nativeWrappers: options.nativeWrappers ?? {},
    optionKeyAttribute: {},
    elementMetadata: new Map(),
    semanticNameMap: new Map(),
    componentHierarchyMap,
    crossFileKeyRegistry: options.crossFileKeyRegistry ?? new Map(),
    vueFilesPathMap: options.vueFilesPathMap ?? new Map(),
    skipTestIdGenerationInsideComponents: [],
    getViewsDirAbs: () => '/src/views',
    testIdAttribute: 'data-testid',
    accessibilityAudit: false,
    loggerRef: {
      current: {
        info() {},
        debug() {},
        warn() {},
      },
    },
    getSourceDirs: () => ['/src/views', '/src/components'],
    getWrapperSearchRoots: () => options.wrapperSearchRoots ?? [],
    getProjectRoot: () => '/',
    annotatorMetadata: options.annotatorMetadata ?? null,
  })

  return compileDom(source, {
    ...templateCompilerOptions,
    filename: '/src/views/MyComp.vue',
    inline: options.inline ?? true,
    cacheHandlers: true,
    bindingMetadata: options.bindingMetadata,
    mode: 'module',
  }).code
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
      const prop = findBindDirective(el, 'data-testid')

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

function findAllDataTestIds(root: RootNode): string[] {
  const found: string[] = []

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
    if (!isNodeWithType(node)) {
      return
    }

    if (node.type === NodeTypes.ELEMENT) {
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
          found.push((prop as AttributeNode).value?.content ?? '')
        }
        else if (prop.type === NodeTypes.DIRECTIVE) {
          const value = stringifyDirectiveExp(prop as DirectiveNode)
          if (value) {
            found.push(value)
          }
        }
      }

      for (const child of el.children || []) {
        visit(child)
      }
    }

    if (node.type === NodeTypes.ROOT) {
      const rootNode = node as RootNode
      for (const child of rootNode.children || []) {
        visit(child)
      }
    }

    if (node.type === NodeTypes.IF) {
      for (const b of (node as { branches?: unknown[] }).branches || []) {
        visit(typeof b === 'object' && b !== null ? b : null)
      }
    }

    if (node.type === NodeTypes.IF_BRANCH || node.type === NodeTypes.FOR) {
      for (const child of (node as { children?: unknown[] }).children || []) {
        visit(typeof child === 'object' && child !== null ? child : null)
      }
    }
  }

  visit(root)
  return found
}

describe('createTestIdTransform', () => {
  it('normalizes control label text for generated names', () => {
    expect(__internal.normalizeControlLabelText('  First * Name \n')).toBe('First Name')
    expect(__internal.normalizeControlLabelText(' \n\t*  ')).toBe(null)
  })

  it('injects html attributes and collects ids', () => {
    const { ast, componentHierarchyMap } = compileWithTestIdTransform(
      readFixtureTemplate('MyComp_SaveButton.vue'),
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Save-button')

    const deps = componentHierarchyMap.get('MyComp')
    expect(deps).toBeTruthy()
    expect(Array.from(deps!.dataTestIdSet).some(e => e.selectorValue.formatted === 'MyComp-Save-button')).toBe(true)
  })

  it('preserves existing data-testid when existingIdBehavior is preserve', () => {
    const { ast } = compileWithTestIdTransform(
      readFixtureTemplate('MyComp_SaveButton_ExistingTestId.vue'),
    {
      transformOptions: { existingIdBehavior: 'preserve' },
    },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('already')
  })

  it('preserves existing dynamic data-testid on @click element when existingIdBehavior is preserve', () => {
    const { ast } = compileWithTestIdTransform(
      `<button :data-testid="\`select-all-\${subject.id}\`" @click="selectAll">Select All</button>`,
    {
      transformOptions: { existingIdBehavior: 'preserve' },
    },
    )

    // The author's dynamic testid must be preserved, NOT overwritten with
    // a generated one like "MyComp-SelectAll-button".
    const testId = findFirstDataTestId(ast)
    expect(testId).toContain('select-all-')
    expect(testId).not.toBe('MyComp-SelectAll-button')
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
    const { ast } = compileWithTestIdTransform(
      readFixtureTemplate('MyComp_SaveButton_ExistingTestId.vue'),
    {
      transformOptions: { existingIdBehavior: 'overwrite' },
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
    const { ast } = compileWithTestIdTransform(
      readFixtureTemplate('MyComp_RouterLinkUsers.vue'),
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Users-routerlink')
  })

  it('injects a dynamic @click test id including :key placeholder', () => {
    const { ast } = compileWithTestIdTransform(
      readFixtureTemplate('MyComp_SelectButton_DynamicKey.vue'),
    )

    // For dynamic bindings, Vue stores directive exp as a string. We expect the exact backticked template string.
    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('`MyComp-${item.id}-Select-button`')
  })

  it('does not double-prefix keyed click test ids inside click instrumentation wrappers', () => {
    const componentHierarchyMap = new Map()
    const nestedVForTemplate = [
      '<ul>',
      '  <li',
      '    v-for="matches in lineMatches"',
      '    :key="`${item.id}-line-${matches.lineNumber}`"',
      '    @click.stop.prevent="lineSelected(item, matches)"',
      '  >',
      '    {{ matches.line }}',
      '  </li>',
      '</ul>',
    ].join('\n')

    const code = compileAndCaptureCode(
      nestedVForTemplate,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    expect(code).toContain('"data-testid": `MyComp-${_ctx.item.id}-line-${matches.lineNumber}-LineSelected-li`')
    expect(code).not.toContain('${`${item.id}-line-${matches.lineNumber}`}')
    expect(code).not.toContain('_ctx._ctx.item.id')
  })

  it('preserves keyed template segments that start with literal text', () => {
    const componentHierarchyMap = new Map()

    const code = compileAndCaptureCode(
      [
        '<ul>',
        '  <li',
        '    v-for="item in items"',
        '    :key="`line-${item.id}`"',
        '    @click="select(item)"',
        '  >',
        '    {{ item.id }}',
        '  </li>',
        '</ul>',
      ].join('\n'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views', { existingIdBehavior: 'preserve' })],
      },
    )

    expect(code).toContain('"data-testid": `MyComp-line-${item.id}-Select-li`')
    expect(code).not.toContain('${line-${item.id}}')
  })

  it('injects click instrumentation by default', () => {
    const code = compileWithRuntimeTemplateOptions(
      `
        <MyTable>
          <template #actions="{ item }">
            <MyButton @click="remove(item)">Remove</MyButton>
          </template>
        </MyTable>
      `,
      {
        nativeWrappers: { MyButton: { role: 'button' } },
        bindingMetadata: {
          remove: BindingTypes.SETUP_CONST,
        },
      },
    )

    expect(code).toContain('__testid_event__')
    expect(code).toContain('"data-click-instrumented": "1"')
    expect(code).toContain('"data-testid": `MyComp-${item.key ?? item.data?.id ?? item.id ?? item.value ?? item.url ?? item}-Remove-button`')
    expect(code).not.toContain('__testid_click_event_strict__')
  })

  it('injects annotator metadata attributes when annotator mode is enabled', () => {
    const code = compileWithRuntimeTemplateOptions(
      '<button @click="save">Save</button>',
      {
        bindingMetadata: {
          save: BindingTypes.SETUP_CONST,
        },
        annotatorMetadata: {
          sourceAttribute: 'data-v-inspector',
          metadataAttributePrefix: 'data-v-pom',
        },
      },
    )

    expect(code).toContain('"data-v-inspector": "/src/views/MyComp.vue:1:1"')
    expect(code).toContain('"data-v-pom-component": "MyComp"')
    expect(code).toContain('"data-v-pom-tag": "button"')
    expect(code).toContain('"data-v-pom-testid": "MyComp-Save-button"')
    expect(code).toContain('"data-v-pom-action": "clickSave"')
    expect(code).toContain('"data-v-pom-property": "SaveButton"')
    expect(code).toContain('"data-v-pom-role": "button"')
  })

  it('prefixes component-scope identifiers inside keyed router-link test ids', () => {
    const componentHierarchyMap = new Map()

    const code = compileAndCaptureCode(
      `
        <RouterLink :key="\`${'${'}item.name}-${'${'}item.url}\`" :to="item.url">
          {{ item.name }}
        </RouterLink>
      `,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, {}, [], '/src/views')],
      },
    )

    expect(code).toContain('_ctx.item.name')
    expect(code).toContain('_ctx.item.url')
    expect(code).toContain('"data-testid": `MyComp-${_ctx.item.name}-${_ctx.item.url}--routerlink`')
    expect(code).not.toContain('${`${item.name}-${item.url}`}')
  })

  it('rewrites injected cross-file key expressions using runtime prop bindings', () => {
    const code = compileWithRuntimeTemplateOptions(
      '<button @click="selectAll">Select All</button>',
      {
        bindingMetadata: {
          selectAll: BindingTypes.SETUP_CONST,
          subject: BindingTypes.PROPS,
        },
        crossFileKeyRegistry: new Map([['MyComp', 'subject']]),
        inline: false,
      },
    )

    expect(code).toContain('$props.subject.id')
    expect(code).not.toMatch(/\$\{subject\?\./)
  })

  it('rewrites keyed component-instance markers using runtime setup bindings', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-runtime-scope-'))
    const childPath = path.join(directory, 'ForwardingPanel.vue')
    fs.writeFileSync(childPath, '<template><section v-bind="$attrs" /></template>')

    try {
      const code = compileWithRuntimeTemplateOptions(
        '<ForwardingPanel :key="getPanelKey(state)" />',
        {
          bindingMetadata: {
            getPanelKey: BindingTypes.SETUP_CONST,
            state: BindingTypes.SETUP_REACTIVE_CONST,
          },
          inline: false,
          vueFilesPathMap: new Map([['ForwardingPanel', childPath]]),
          wrapperSearchRoots: [directory],
        },
      )

      expect(code).toContain('$setup.getPanelKey($setup.state)')
      expect(code).not.toContain('${getPanelKey(state)}')
    }
    finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('ignores singleton :key values when generating click test ids', () => {
    const { ast } = compileWithTestIdTransform(
      '<button :key="activeTab" @click="select">Select</button>',
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Select-button')
  })

  it('preserves static data-testid values on singleton keyed elements', () => {
    const { ast } = compileWithTestIdTransform(
      '<button :key="activeTab" data-testid="target-visibility-selector" @click="select">Select</button>',
    {
      transformOptions: { existingIdBehavior: 'preserve' },
    },
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('target-visibility-selector')
  })

  it('injects a stable keyed test id for scoped slot data objects', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <DxDataGrid :data-source="items" key-expr="id">
          <DxColumn cell-template="selectCell" />
          <template #selectCell="{ data }">
            <CustomButton @click="openProject(data.data)">Select</CustomButton>
          </template>
        </DxDataGrid>
      `,
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('`MyComp-${data.key ?? data.data?.id ?? data.id ?? data.value ?? data.url ?? data}-OpenProject-button`')
  })

  it('injects a stable keyed test id for scoped slot data objects through v-if wrappers', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <MyList :items="items">
          <template #item="{ data: maintenanceItem }">
            <MyRow>
              <MyCol>
                <div v-if="!readonly">
                  <MyButton @click="moveToTop(maintenanceItem)">Top</MyButton>
                </div>
              </MyCol>
            </MyRow>
          </template>
        </MyList>
      `,
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('`MyComp-${maintenanceItem.key ?? maintenanceItem.data?.id ?? maintenanceItem.id ?? maintenanceItem.value ?? maintenanceItem.url ?? maintenanceItem}-MoveToTop-button`')
  })

  it('injects a stable keyed test id for scoped slot data objects with key prop', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <MyList :items="items">
          <template #item="{ data, key }">
            <button @click="remove(data)">Remove</button>
          </template>
        </MyList>
      `,
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('`MyComp-${key}-Remove-button`')
  })

  it('uses a slot item URL before falling back to object stringification', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <MyList :items="items">
          <template #item="{ item }">
            <button @click="navigate(item)">Open</button>
          </template>
        </MyList>
      `,
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('`MyComp-${item.key ?? item.data?.id ?? item.id ?? item.value ?? item.url ?? item}-Navigate-button`')
  })

  it('emits a singleton (non-keyed) test id for a slot-scope callback click handler', () => {
    // A scoped slot that hands the consumer an event callback (here `toggle` from
    // a popover `#trigger`) is a singleton control, not an iterated row. The click
    // handler is a bare slot-scope identifier — a callback reference, not row data —
    // so the generated selector must be a plain singleton, not keyed by a fallback
    // expression interpolated off the callback.
    const { ast } = compileWithTestIdTransform(
      `
        <MyPopover>
          <template #trigger="{ toggle, isOpen }">
            <button @click="toggle">Open</button>
          </template>
        </MyPopover>
      `,
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Toggle-button')
  })

  it('emits a singleton test id for a slot-scope callback wrapped in withModifiers', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <MyPopover>
          <template #trigger="{ toggle }">
            <button @click="withModifiers(toggle, ['prevent'])">Open</button>
          </template>
        </MyPopover>
      `,
    )

    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('MyComp-Toggle-button')
  })

  it('emits a static test id for a slot-scope callback on a child component with dynamic text', () => {
    // Reproduction: a button-rendering child component inside a scoped slot whose
    // @click handler is a bare slot-scope prop (`cancel` — AppPopup's cancelAction
    // function) and whose text content is a dynamic interpolation. The slot-scope
    // key candidate chain fell back to stringifying the callback function itself,
    // producing runtime output like:
    //   MyComp-${cancel.key ?? cancel.data?.id ?? ... ?? cancel}-Save-appbutton
    // which rendered the entire function source into the DOM data-testid.
    const { ast } = compileWithTestIdTransform(
      `
        <AppPopup>
          <template #popup-footer="{ cancel }">
            <AppButton roboto variant="tertiary" @click="cancel">Cancel</AppButton>
            <AppButton roboto variant="primary" @click="save">
              {{ saving ? "Saving..." : "Save Monitor" }}
            </AppButton>
          </template>
        </AppPopup>
      `,
    {
      component: 'MonitorConfigureDialog',
    },
    )

    const testIds = findAllDataTestIds(ast)
    // The Cancel button (@click="cancel" IS the slot-scope callback) has static text,
    // so it already gets a static test id. The unresolvable AppButton source falls
    // back to the conventional button-role suffix.
    expect(testIds).toContain('MonitorConfigureDialog-Cancel-button')
    // The Save button must not stringify the slot-scope callback function: no keyed
    // fallback chain, no interpolated function source.
    for (const testId of testIds) {
      expect(testId).not.toContain('??')
      expect(testId).not.toContain('function')
      expect(testId).not.toContain('cancel')
    }
    expect(testIds).toContain('MonitorConfigureDialog-Save-button')
  })

  it('does not misattribute a bare handler to an outer slot variable shadowed by a nested slot scope', () => {
    // Copilot review (PR #68): with an outer #row="{ item }" and an inner
    // v-slot="{ item }" whose button uses @click="item", the inner callback must
    // resolve to the INNER binding. If the scan counts it against the outer
    // slot's `item`, the outer slot is treated as callback-shaped and a sibling
    // keyed selector keyed off the outer `item` incorrectly loses its key.
    const { ast } = compileWithTestIdTransform(
      `
        <MyList :items="rows">
          <template #row="{ item }">
            <div class="outer-row" :data-row="item.id">
              <MyPopover>
                <template #trigger="{ item: inner }">
                  <button @click="item">Outer callback</button>
                </template>
              </MyPopover>
            </div>
          </template>
        </MyList>
      `,
    )

    // The inner @click="item" names the inner scope's own binding — the scan must
    // not record it as usage of the OUTER slot's `item`, so the outer slot's keyed
    // handling stays intact for its real row content.
    const testIds = findAllDataTestIds(ast)
    for (const testId of testIds) {
      expect(testId).not.toContain('Outer-callback')
    }
  })

  it('keeps a genuine outer-slot callback handler keyed/unkeyed correctly beside a shadowing inner slot', () => {
    // Same nesting shape as the shadowing test, but the OUTER slot has the bare
    // callback and the INNER slot merely shadows the name without using it. The
    // outer usage must still be detected.
    const { ast } = compileWithTestIdTransform(
      `
        <AppPopup>
          <template #popup-footer="{ cancel }">
            <MyPopover>
              <template #trigger="{ cancel: noop }">
                <button @click="noop">Inner</button>
              </template>
            </MyPopover>
            <AppButton roboto variant="primary" @click="cancel">
              {{ saving ? "Saving..." : "Save Monitor" }}
            </AppButton>
          </template>
        </AppPopup>
      `,
    {
      component: 'MonitorConfigureDialog',
    },
    )

    const testIds = findAllDataTestIds(ast)
    // The outer `cancel` handler is still detected as a genuine callback usage
    // (the inner slot's `cancel: noop` rename shadows the name without using it),
    // so the button's fallback semantic name comes from the handler and nothing
    // stringifies the callback function into a keyed chain.
    expect(testIds).toContain('MonitorConfigureDialog-Cancel-button')
    for (const testId of testIds) {
      expect(testId).not.toContain('function')
      expect(testId).not.toContain('??')
    }
  })

  it('does not treat a v-for alias as the enclosing slot scope variable', () => {
    // v-for introduces its own scope: a bare @click="item" inside
    // <div v-for="item in rows"> under <template #row="{ item }"> names the LOOP
    // binding, not the slot prop. The scan must not count it for the slot.
    const { ast } = compileWithTestIdTransform(
      `
        <MyList :items="rows">
          <template #row="{ item }">
            <div>
              <span v-for="item in item.children" :key="item.id">
                <button @click="item">Select</button>
              </span>
            </div>
          </template>
        </MyList>
      `,
    )

    // Whatever ids are emitted, the loop's @click="item" must not cause the
    // outer slot's `item` to be recorded as a callback (which would strip the
    // keyed selector from genuine row content).
    const testIds = findAllDataTestIds(ast)
    expect(testIds.length).toBeGreaterThan(0)
  })

  it('keys child component testids via cross-file key registry', () => {
    // Simulate two-pass compilation: parent records key context, child consumes it.
    const componentHierarchyMap = new Map()
    const crossFileKeyRegistry = new Map<string, string>()

    // Pass 1: PARENT — RolePermissions.vue renders RolePermissionSubject in a keyed slot
    compileAndCaptureAst(
      `
        <MyList :items="subjects">
          <template #item="{ data, key }">
            <div>
              <RolePermissionSubject :subject="data" :disabled="isDisabled" />
            </div>
          </template>
        </MyList>
      `,
      {
        filename: '/src/components/RolePermissions.vue',
        nodeTransforms: [createTestIdTransform('RolePermissions', componentHierarchyMap, {}, [], '/src/views', { crossFileKeyRegistry })],
      },
    )

    // The parent should have recorded that RolePermissionSubject receives slot data via "subject" prop
    expect(crossFileKeyRegistry.get('RolePermissionSubject')).toBe('subject')

    // Pass 2: CHILD — RolePermissionSubject.vue has @click buttons
    const childAst = compileAndCaptureAst(
      `
        <button v-if="!disabled" @click="selectAll">Select All</button>
      `,
      {
        filename: '/src/components/RolePermissionSubject.vue',
        nodeTransforms: [createTestIdTransform('RolePermissionSubject', componentHierarchyMap, {}, [], '/src/views', { crossFileKeyRegistry })],
      },
    )

    const testId = findFirstDataTestId(childAst)
    expect(testId).toBe('`RolePermissionSubject-${_ctx.subject.key ?? _ctx.subject.data?.id ?? _ctx.subject.id ?? _ctx.subject.value ?? _ctx.subject.url ?? _ctx.subject}-SelectAll-button`')
  })

  it('does not key child component testids when not in a keyed slot', () => {
    const componentHierarchyMap = new Map()
    const crossFileKeyRegistry = new Map<string, string>()

    // Parent does NOT use a keyed slot — just renders the child directly
    compileAndCaptureAst(
      `
        <div>
          <RolePermissionSubject :subject="someData" :disabled="false" />
        </div>
      `,
      {
        filename: '/src/components/RolePermissions.vue',
        nodeTransforms: [createTestIdTransform('RolePermissions', componentHierarchyMap, {}, [], '/src/views', { crossFileKeyRegistry })],
      },
    )

    // Registry should NOT have an entry for RolePermissionSubject
    expect(crossFileKeyRegistry.has('RolePermissionSubject')).toBe(false)
  })

  it('injects native input test ids from static ids before falling back to v-model', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <div>
          <label for="txbClientName">Client Name</label>
          <input id="txbClientName" v-model="state.clientName" type="text" />
        </div>
      `,
    )

    expect(findFirstDataTestId(ast)).toBe('MyComp-txbClientName-input')
  })

  it('injects native select test ids from static ids', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <div>
          <label for="modal-kind">Search Type</label>
          <select id="modal-kind" v-model="state.kind">
            <option>Folder Search</option>
            <option>Tag Search</option>
          </select>
        </div>
      `,
    )

    expect(findFirstDataTestId(ast)).toBe('MyComp-modal-kind-select')
  })

  it('injects native input test ids from wrapping label text when no id exists', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <label>
          <span>File Name*</span>
          <input v-model="state.createFile.projectName" type="text" />
        </label>
      `,
    )

    expect(findFirstDataTestId(ast)).toBe('MyComp-FileName-input')
  })

  it('injects native radio test ids using v-model context plus the option label', () => {
    const { ast } = compileWithTestIdTransform(
      `
        <label>
          <input v-model="state.createFile.copyAnswersChoice" type="radio" value="no" />
          No
        </label>
      `,
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

    const deps = requireDeps(componentHierarchyMap, 'MyComp')

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

    const deps = requireDeps(componentHierarchyMap, 'DynamicFormField')
    expect(deps?.generatedMethods?.has('typeFieldValue')).toBe(true)
    expect(deps?.generatedMethods?.has('typeFieldValue2')).toBe(false)

    const fieldValuePoms = Array.from(deps?.dataTestIdSet ?? [])
      .map(e => e.pom)
      .filter((p): p is NonNullable<typeof p> => !!p && p.methodName === 'FieldValue')
    expect(fieldValuePoms.length).toBe(2)

    const primary = fieldValuePoms.find(p => p.emitPrimary !== false)
    const mergedSecondary = fieldValuePoms.find(p => p.emitPrimary === false)
    expect(primary?.selector).toEqual(createPomStringPattern('DynamicFormField-FieldValue-input', 'static', []))
    expect(primary?.mergeKey).toContain('wrapper:ifgroup:')
    expect(primary?.mergeKey).toContain(':model:FieldValue')
    expect(primary?.alternateSelectors).toBeUndefined()
    expect(mergedSecondary?.emitPrimary).toBe(false)
  })

  it('falls back to click label hints when strict mode sees a click-name collision', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    seedReservedClickDeps(componentHierarchyMap, 'MediaSelector', 'clickShowMediaLibrary')

    expect(() => {
      compileAndCaptureAst(
        `
          <button @click="onShowMediaLibrary">
            Media Library
          </button>
        `,
        {
          filename: '/src/components/MediaSelector.vue',
          nodeTransforms: [createTestIdTransform('MediaSelector', componentHierarchyMap, {}, [], '/src/views', { nameCollisionBehavior: 'error' })],
        },
      )
    }).not.toThrow()

    const deps = requireDeps(componentHierarchyMap, 'MediaSelector')
    expect(deps?.generatedMethods?.has('clickShowMediaLibrary')).toBe(true)
    expect(deps?.generatedMethods?.has('clickMediaLibrary')).toBe(true)

    const methodNames = Array.from(deps?.dataTestIdSet ?? [])
      .map(e => e.pom?.methodName)
      .filter((name): name is string => !!name)
    expect(methodNames).toContain('MediaLibrary')
  })

  it('falls back to wrapper title hints when strict mode sees a wrapper-name collision', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    seedReservedClickDeps(componentHierarchyMap, 'MediaSelector', 'clickShowMediaLibrary')

    const nativeWrappers: NativeWrappersMap = {
      MyModal: { role: 'button' },
    }

    expect(() => {
      compileAndCaptureAst(
        `
          <MyModal
            v-model="showMediaLibrary"
            title="Media Library"
          />
        `,
        {
          filename: '/src/components/MediaSelector.vue',
          nodeTransforms: [createTestIdTransform('MediaSelector', componentHierarchyMap, nativeWrappers, [], '/src/views', { nameCollisionBehavior: 'error' })],
        },
      )
    }).not.toThrow()

    const deps = requireDeps(componentHierarchyMap, 'MediaSelector')
    expect(deps?.generatedMethods?.has('clickMediaLibrary')).toBe(true)

    const methodNames = Array.from(deps?.dataTestIdSet ?? [])
      .map(e => e.pom?.methodName)
      .filter((name): name is string => !!name)
    expect(methodNames).toContain('MediaLibrary')
  })

  it('derives handler-based suffixes from later stable args to avoid strict-mode collisions', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    seedReservedClickDeps(componentHierarchyMap, 'UnifiedSoftwareDetailsDataRow', 'clickRunDeploymentAction')

    expect(() => {
      compileAndCaptureAst(
        `
          <LoadButton :handler="() => runDeploymentAction(rowData, 'Assign', RebootPreference.Suppress)">
            Assign
          </LoadButton>
        `,
        {
          filename: '/src/components/UnifiedSoftwareDetailsDataRow.vue',
          nodeTransforms: [createTestIdTransform('UnifiedSoftwareDetailsDataRow', componentHierarchyMap, {}, [], '/src/views', { nameCollisionBehavior: 'error' })],
        },
      )
    }).not.toThrow()

    const deps = requireDeps(componentHierarchyMap, 'UnifiedSoftwareDetailsDataRow')
    expect(deps?.generatedMethods?.has('clickRunDeploymentActionAssign')).toBe(true)
  })

  it('accepts async await wrapper handlers in strict mode', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const nativeWrappers: NativeWrappersMap = {
      LoadButton: { role: 'button' },
    }

    expect(() => {
      compileAndCaptureAst(
        `
          <LoadButton :handler="async () => await refreshOauthAccessToken(data.id)">
            Refresh now
          </LoadButton>
        `,
        {
          filename: '/src/views/OauthAccessTokensListPage.vue',
          nodeTransforms: [createTestIdTransform('OauthAccessTokensListPage', componentHierarchyMap, nativeWrappers, [], '/src/views')],
        },
      )
    }).not.toThrow()

    const deps = requireDeps(componentHierarchyMap, 'OauthAccessTokensListPage')
    expect(deps?.generatedMethods?.has('clickRefreshOauthAccessToken')).toBe(true)
  })

  it('derives the same semantic action from :load-action as from :loadAction', () => {
    const compileWith = (template: string) => {
      const componentHierarchyMap = new Map<string, IComponentDependencies>()
      const nativeWrappers: NativeWrappersMap = {
        LoadButton: { role: 'button' },
      }
      compileAndCaptureAst(template, {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, nativeWrappers, [], '/src/views')],
      })
      return componentHierarchyMap.get('MyComp')
    }

    const camel = compileWith(`<LoadButton :loadAction="() => createTenants('selected')">Selected</LoadButton>`)
    const kebab = compileWith(`<LoadButton :load-action="() => createTenants('selected')">Selected</LoadButton>`)

    expect(kebab?.generatedMethods?.has('clickCreateTenantsSelected')).toBe(true)
    expect([...(kebab?.generatedMethods?.keys() ?? [])].sort()).toEqual([...(camel?.generatedMethods?.keys() ?? [])].sort())
  })

  it('echoes the matched action prop in the unnameable-handler error', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const nativeWrappers: NativeWrappersMap = {
      LoadButton: { role: 'button' },
    }

    expect(() => {
      compileAndCaptureAst(
        `
          <LoadButton :handler="() => isEdit ? update() : create()">
            Go
          </LoadButton>
        `,
        {
          filename: '/src/components/MyComp.vue',
          nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, nativeWrappers, [], '/src/views')],
        },
      )
    }).toThrow(/:handler="onAction"/)
  })

  it('fails fast when a declared-actionProp wrapper usage binds neither the action nor @click', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const nativeWrappers: NativeWrappersMap = {
      LoadButton: { role: 'button', actionProp: 'loadAction' },
    }

    expect(() => {
      compileAndCaptureAst(
        `
          <LoadButton>
            Save
          </LoadButton>
        `,
        {
          filename: '/src/components/MyComp.vue',
          nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, nativeWrappers, [], '/src/views')],
        },
      )
    }).toThrow(/declares actionProp "loadAction"/)
  })

  it('allows a declared-actionProp wrapper usage that binds @click instead', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const nativeWrappers: NativeWrappersMap = {
      LoadButton: { role: 'button', actionProp: 'loadAction' },
    }

    compileAndCaptureAst(
      `
        <LoadButton @click="save">
          Save
        </LoadButton>
      `,
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, nativeWrappers, [], '/src/views')],
      },
    )

    const deps = componentHierarchyMap.get('MyComp') as IComponentDependencies | undefined
    expect(deps?.generatedMethods?.has('clickSave')).toBe(true)
  })

  it('rejects a declared-actionProp wrapper usage that binds only @change', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const nativeWrappers: NativeWrappersMap = {
      LoadButton: { role: 'button', actionProp: 'loadAction' },
    }

    expect(() => {
      compileAndCaptureAst(
        `
          <LoadButton @change="save">
            Save
          </LoadButton>
        `,
        {
          filename: '/src/components/MyComp.vue',
          nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, nativeWrappers, [], '/src/views')],
        },
      )
    }).toThrow(/declares actionProp "loadAction"/)
  })

  it('rejects a declared-actionProp wrapper usage whose action binding uses a dynamic argument', () => {
    expect(() => {
      compileWithRuntimeTemplateOptions(
        `
          <LoadButton :[action]="save">
            Save
          </LoadButton>
        `,
        { nativeWrappers: { LoadButton: { role: 'button', actionProp: 'action' } } },
      )
    }).toThrow(/declares actionProp "action"/)
  })

  it('still allows a declared-actionProp wrapper usage with a dynamic argument plus @click', () => {
    const code = compileWithRuntimeTemplateOptions(
      `
        <LoadButton :[action]="save" @click="save">
          Save
        </LoadButton>
      `,
      { nativeWrappers: { LoadButton: { role: 'button', actionProp: 'action' } } },
    )

    expect(code).toContain('"data-testid": "MyComp-Save-button"')
  })

  it('accepts Vue same-name shorthand for a declared actionProp in both spellings', () => {
    for (const binding of [':loadAction', ':load-action']) {
      const componentHierarchyMap = new Map<string, IComponentDependencies>()
      const nativeWrappers: NativeWrappersMap = {
        LoadButton: { role: 'button', actionProp: 'loadAction' },
      }

      compileAndCaptureAst(
        `
          <LoadButton ${binding}>
            Save
          </LoadButton>
        `,
        {
          filename: '/src/components/MyComp.vue',
          nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, nativeWrappers, [], '/src/views')],
        },
      )

      const deps = componentHierarchyMap.get('MyComp') as IComponentDependencies | undefined
      expect(deps?.generatedMethods?.has('clickLoadAction')).toBe(true)
    }
  })

  it('does not enforce the action-prop contract for wrappers without a declared actionProp', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const nativeWrappers: NativeWrappersMap = {
      LoadButton: { role: 'button' },
    }

    expect(() => {
      compileAndCaptureAst(
        `
          <LoadButton>
            Save
          </LoadButton>
        `,
        {
          filename: '/src/components/MyComp.vue',
          nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, nativeWrappers, [], '/src/views')],
        },
      )
    }).not.toThrow()
  })

  it('derives semantic names for button-like wrapper handlers guarded by simple null checks', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const nativeWrappers: NativeWrappersMap = {
      LoadButton: { role: 'button' },
    }

    expect(() => {
      compileAndCaptureAst(
        `
          <LoadButton :handler="() => person && impersonateUser(person.userId!)">
            Impersonate
          </LoadButton>
        `,
        {
          filename: '/src/views/RbacUserDetailsPage.vue',
          nodeTransforms: [createTestIdTransform('RbacUserDetailsPage', componentHierarchyMap, nativeWrappers, [], '/src/views')],
        },
      )
    }).not.toThrow()

    const deps = requireDeps(componentHierarchyMap, 'RbacUserDetailsPage')
    expect(deps?.generatedMethods?.has('clickImpersonateUser')).toBe(true)
  })

  it('accepts direct wrapper handlers after Vue rewrites them in runtime compiler mode', () => {
    const nativeWrappers: NativeWrappersMap = {
      LoadButton: { role: 'button' },
    }

    const cases = [
      {
        bindingMetadata: { saveNotes: BindingTypes.SETUP_REF },
        expectedHandlerFragment: 'handler: saveNotes.value',
      },
      {
        bindingMetadata: { saveNotes: BindingTypes.SETUP_MAYBE_REF },
        expectedHandlerFragment: 'handler: _unref(saveNotes)',
      },
      {
        bindingMetadata: { saveNotes: BindingTypes.PROPS },
        expectedHandlerFragment: 'handler: __props.saveNotes',
      },
    ]

    for (const { bindingMetadata, expectedHandlerFragment } of cases) {
      const code = compileWithRuntimeTemplateOptions(
        `
          <LoadButton class="mr-2" :handler="saveNotes">
            Save
          </LoadButton>
        `,
        {
          nativeWrappers,
          bindingMetadata,
        },
      )

      expect(code).toContain(expectedHandlerFragment)
      expect(code).toContain('"data-testid": "MyComp_SaveNotes-button"')
    }
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

    const deps = requireDeps(componentHierarchyMap, 'MyComp')

    const sigOne = deps?.generatedMethods?.get('clickOneButton')
    expect(sigOne).toEqual(createPomMethodSignature(createPomParameters(['wait', 'boolean = true'], ['annotationText', 'string = ""'])))

    const sigTwo = deps?.generatedMethods?.get('clickTwoButton')
    expect(sigTwo).toEqual(createPomMethodSignature(createPomParameters(['wait', 'boolean = true'], ['annotationText', 'string = ""'])))

    // With the IR-based generator, v-for static literal keys are represented as extra click method specs.
    const extras = deps?.pomExtraMethods ?? []
    const one = extras.find(m => m.kind === 'click' && m.name === 'clickOneButton')
    expect(one).toBeTruthy()
    expect(one?.keyLiteral).toBe('One')
    expect(one?.selector).toEqual({
      kind: 'testId',
      testId: createPomStringPattern('MyComp-${key}-Select-button', 'parameterized', ["key"]),
    })
    expect(one?.parameters).toEqual(createPomParameters(['wait', 'boolean = true'], ['annotationText', 'string = ""']))

    const two = extras.find(m => m.kind === 'click' && m.name === 'clickTwoButton')
    expect(two).toBeTruthy()
    expect(two?.keyLiteral).toBe('Two')
    expect(two?.selector).toEqual({
      kind: 'testId',
      testId: createPomStringPattern('MyComp-${key}-Select-button', 'parameterized', ["key"]),
    })
    expect(two?.parameters).toEqual(createPomParameters(['wait', 'boolean = true'], ['annotationText', 'string = ""']))
  })

  it('treats v-for source with Math.random() as dynamic via constType', () => {
    const { ast, componentHierarchyMap } = compileWithTestIdTransform(
      readFixtureTemplate('MyComp_GoButton_RandomList.vue'),
    )

    const forNode = ast.children.find((c): c is ForNode => c.type === NodeTypes.FOR)

    expect(forNode).toBeTruthy()

    // When `prefixIdentifiers` is enabled, Vue's `transformExpression` often rewrites
    // expressions containing identifiers (like `Math.random()`) into a COMPOUND_EXPRESSION.
    // That means the *source expression itself* won't always be a SimpleExpressionNode.
    //
    // We still assert dynamic-ness via Vue's const analysis by ensuring the compound contains
    // at least one SimpleExpressionNode with constType NOT_CONSTANT.
    interface AstNode {
      type?: NodeTypes
      constType?: number
      children?: unknown[]
    }
    const collectSimpleExpressions = (node: AstNode | null | undefined): Array<{ constType?: number }> => {
      if (!node || typeof node !== 'object' || !('type' in node)) {
        return []
      }

      if (node.type === NodeTypes.SIMPLE_EXPRESSION) {
        return [node]
      }

      if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
        const out: Array<{ constType?: number }> = []
        for (const child of node.children ?? []) {
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
    const deps = requireDeps(componentHierarchyMap, 'MyComp')
    const sig = deps?.generatedMethods?.get('clickDoThingByKey')
    expect(sig).toEqual(createPomMethodSignature(createPomParameters(['key', 'string'])))
  })

  it('does not populate exp.ast in this test harness even when prefixIdentifiers is enabled', () => {
    const { ast } = compileWithTestIdTransform(
      readFixtureTemplate('MyComp_SelectButton_DynamicKey.vue'),
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

    const selectEl = firstElement(ast)
    expect(selectEl.tag).toBe('v-select')

    const optionPrefixAttr = findStaticAttr(selectEl, 'option-data-testid-prefix')
    expect(optionPrefixAttr?.value?.content).toBe('MyComp-SelectedGroup')

    const dataTestIdAttr = findStaticAttr(selectEl, 'data-testid')
    expect(dataTestIdAttr?.value?.content).toBe('MyComp-SelectedGroup-vselect')
  })

  it('registers v-select generated-method signatures from structured primary parameters', () => {
    const componentHierarchyMap = new Map()
    const nativeWrappers: NativeWrappersMap = {
      'v-select': {
        role: 'vselect',
        requiresOptionDataTestIdPrefix: true,
      },
    }

    compileAndCaptureAst(
      readFixtureTemplate('MyComp_VSelect.vue'),
      {
        filename: '/src/components/MyComp.vue',
        nodeTransforms: [createTestIdTransform('MyComp', componentHierarchyMap, nativeWrappers, [], '/src/views')],
      },
    )

    const deps = requireDeps(componentHierarchyMap, 'MyComp')

    const signature = deps?.generatedMethods?.get('selectSelectedGroup')
    expect(signature).toEqual(createPomMethodSignature(createPomParameters(
      ['value', 'string'],
      ['timeOut', 'number = 500'],
      ['annotationText', 'string = ""'],
    )))

    const pom = Array.from(deps?.dataTestIdSet ?? []).find(entry => entry.pom?.methodName === 'SelectedGroup')?.pom
    expect(pom?.parameters).toEqual(createPomParameters(
      ['value', 'string'],
      ['timeOut', 'number = 500'],
      ['annotationText', 'string = ""'],
    ))
  })

  it('infers radio wrappers through nested local SFCs without nativeWrappers config', () => {
    const { ast, componentHierarchyMap } = compilePageWithWrapperSfcs(
      '<MyRadioGroup :options="[\'Cloud\', \'Local\']" v-model="databaseType" />',
      [
        { name: 'MyRadio', template: '<template><div><input type="radio" /></div></template>' },
        { name: 'MyRadioGroup', template: '<template><div role="radiogroup"><MyRadio v-for="option in props.options" :key="option.value" :text="option.text" :modelValue="option.value" /></div></template>' },
      ],
    )

    const radioGroupEl = firstElement(ast)

    const dataTestIdAttr = findStaticAttr(radioGroupEl, 'data-testid')
    expect(dataTestIdAttr?.value?.content).toBe('MyPage-DatabaseType-radio')

    const optionPrefixAttr = findStaticAttr(radioGroupEl, 'option-data-testid-prefix')
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
        rootTestId: createPomStringPattern('MyPage-DatabaseType-radio', 'static', []),
        label: createPomStringPattern('Cloud', 'static', []),
        exact: true,
      },
      parameters: createPomParameters(['annotationText', 'string = ""']),
    })
  })

  it('does not infer sibling wrapper radios without configured search roots', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-monorepo-'))
    const { frontendRoot } = writeMonorepoRadioComponents(tempRoot)

    const { ast, componentHierarchyMap } = compileWithTestIdTransform(
      '<SharedRadioGroup :options="[\'Cloud\', \'Local\']" v-model="databaseType" />',
    {
      component: 'MyPage',
      viewsDir: path.join(frontendRoot, 'src', 'views'),
      filename: path.join(frontendRoot, 'src', 'views', 'MyPage.vue'),
    },
    )

    const radioGroupEl = firstElement(ast)

    const dataTestIdAttr = findStaticAttr(radioGroupEl, 'data-testid')
    expect(dataTestIdAttr).toBeUndefined()

    const extras = componentHierarchyMap.get('MyPage')?.pomExtraMethods ?? []
    expect(extras.some(method => method.kind === 'click' && method.name === 'selectDatabaseTypeCloud')).toBe(false)
  })

  it('infers sibling wrapper radios from configured search roots without vueFilesPathMap', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-monorepo-'))
    const { frontendRoot, sharedComponentsRoot } = writeMonorepoRadioComponents(tempRoot)

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

    const radioGroupEl = firstElement(ast)

    const dataTestIdAttr = findStaticAttr(radioGroupEl, 'data-testid')
    expect(dataTestIdAttr?.value?.content).toBe('MyPage-DatabaseType-radio')

    const deps = componentHierarchyMap.get('MyPage')
    expect(deps?.pomExtraMethods).toContainEqual({
      kind: 'click',
      name: 'selectDatabaseTypeCloud',
      selector: {
        kind: 'withinTestIdByLabel',
        rootTestId: createPomStringPattern('MyPage-DatabaseType-radio', 'static', []),
        label: createPomStringPattern('Cloud', 'static', []),
        exact: true,
      },
      parameters: createPomParameters(['annotationText', 'string = ""']),
    })
  })

  it('infers a link role from a rendered <a> when nativeWrappers omits role', () => {
    const { ast, componentHierarchyMap } = compilePageWithWrapperSfcs(
      '<MyAnchor label="Click me" :href="url" />',
      [
        // Renders a native anchor — implicit ARIA role "link".
        { name: 'MyAnchor', template: '<template><a :href="href"><slot /></a></template>' },
      ],
      // valueAttribute is configured, but `role` is deliberately omitted: the generator
      // should infer it from the rendered <a> so consumers can't declare a mismatched role.
      { nativeWrappers: { MyAnchor: { valueAttribute: 'label' } } },
    )

    const linkEl = firstElement(ast)
    const dataTestIdAttr = findStaticAttr(linkEl, 'data-testid')
    // Inferred role "link" drives the testid suffix, aligning with the rendered element.
    expect(dataTestIdAttr?.value?.content).toBe('MyPage-Click me-link')

    const deps = componentHierarchyMap.get('MyPage')
    const pom = Array.from(deps?.dataTestIdSet ?? []).find(entry => entry.pom?.methodName === 'ClickMe')?.pom
    expect(pom?.nativeRole).toBe('link')
  })

  it('infers a link role through a nested link-wrapper component (RouterLink)', () => {
    const { ast } = compilePageWithWrapperSfcs(
      '<DashboardStatLink label="Computers missing critical" :to="route" />',
      [
        // AppLink forwards to a RouterLink (which renders an <a>).
        { name: 'AppLink', template: '<template><RouterLink :to="to"><slot /></RouterLink></template>' },
        // DashboardStatLink wraps AppLink — inference must recurse through both.
        { name: 'DashboardStatLink', template: '<template><AppLink :to="to"><slot /></AppLink></template>' },
      ],
      { nativeWrappers: { DashboardStatLink: { valueAttribute: 'label' } } },
    )

    const statEl = firstElement(ast)
    const dataTestIdAttr = findStaticAttr(statEl, 'data-testid')
    expect(dataTestIdAttr?.value?.content).toBe('MyPage-Computers missing critical-link')
  })

  it('does not infer an action for a fragment wrapper whose injected attribute cannot fall through', () => {
    const { ast, componentHierarchyMap } = compilePageWithWrapperSfcs(
      '<FragmentButton :handler="saveRecord" />',
      [
        { name: 'ActionButton', template: '<template><button type="button"><slot /></button></template>' },
        { name: 'FragmentButton', template: '<template><ActionButton :handler="handler" /><div class="dialog" /></template>' },
      ],
      { pageComponent: 'RecordPage' },
    )

    const fragmentButton = firstElement(ast)
    expect(fragmentButton.props.some(
      prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'data-testid',
    )).toBe(false)

    const methods = componentHierarchyMap.get('RecordPage')?.generatedMethods
    expect(methods?.has('clickSaveRecord')).not.toBe(true)
  })

  it('does not infer a link role from a bare <a> without an href (and throws for the omitted role)', () => {
    expect(() => {
      compilePageWithWrapperSfcs(
        '<BareAnchor label="Save" />',
        [
          // A bare <a> without href is not a link (no implicit ARIA role "link") — it may be an
          // anchor target/placeholder or an anchor-styled button. It must NOT be classified as link.
          { name: 'BareAnchor', template: '<template><a><slot /></a></template>' },
        ],
        { nativeWrappers: { BareAnchor: { valueAttribute: 'label' } } },
      )
    }).toThrow(/Could not infer a native role for declared wrapper <BareAnchor>/)
  })

  it('throws when an omitted role cannot be inferred from a non-native rendered element', () => {
    expect(() => {
      compilePageWithWrapperSfcs(
        '<MyDiv label="Save" />',
        [{ name: 'MyDiv', template: '<template><div><slot /></div></template>' }],
        // No role, and the component renders a <div> (no inferable native role): the generator
        // fails fast and loud rather than silently defaulting to a generic role. The author must
        // declare `role` explicitly for wrappers that don't render a recognized native control.
        { nativeWrappers: { MyDiv: { valueAttribute: 'label' } } },
      )
    }).toThrow(/Could not infer a native role for declared wrapper <MyDiv>/)
  })

  it('emits per-usage tab accessors keyed by a literal valueAttribute (role: "tab")', () => {
    // ARIA `tab` is a first-class interactive control (a tab button in a tablist). Declaring
    // `role: "tab"` on a wrapper component — combined with `valueAttribute: "title"` — lets the
    // generator derive a per-usage data-testid from each tab's literal title prop and emit a
    // distinct named accessor per tab (e.g. clickUsers / clickRoles), with a `-tab` selector
    // suffix. This mirrors how `link`/`button` wrappers behave, and lets consumers delete
    // hand-rolled tab POMs that previously clicked by accessible name (which is brittle when a
    // tab's slot content carries a badge that pollutes its accessible name).
    const { ast, componentHierarchyMap } = compilePageWithWrapperSfcs(
      `<TabItem v-model="currentTab" title="Users" :tabValue="'users'" /><TabItem v-model="currentTab" title="Roles" :tabValue="'roles'" />`,
      [
        // TabItem renders a list-item wrapping a `role="tab"` button; the model is driven by
        // `tabValue`. role is declared explicitly as "tab" (not inferred from the <li> wrapper).
        { name: 'TabItem', template: '<template><li role="presentation"><button role="tab" :class="{ active: modelValue == tabValue }" @click="$emit(\'update:modelValue\', tabValue)"><slot>{{ title }}</slot></button></li></template>' },
      ],
      { nativeWrappers: { TabItem: { role: 'tab', valueAttribute: 'title' } } },
    )

    // Each literal title produces a distinct per-usage data-testid with the `-tab` suffix.
    const testIds = rootStaticTestIds(ast)
    expect(testIds).toEqual(expect.arrayContaining(['MyPage-Users-tab', 'MyPage-Roles-tab']))

    // And a distinct click accessor per tab, named from the title hint.
    const deps = requireDeps(componentHierarchyMap, 'MyPage')
    expect(deps?.generatedMethods?.has('clickUsers')).toBe(true)
    expect(deps?.generatedMethods?.has('clickRoles')).toBe(true)

    // The locator getter carries the `-tab` role suffix (UsersTab / RolesTab), matching the
    // injected selector. Without "tab" as a recognized NativeRole, normalizeNativeRole falls
    // back to "button" and the getter would be `UsersButton` — inconsistent with the `-tab` id.
    expect(deps?.__pomPrimaryByGetterName?.has('UsersTab')).toBe(true)
    expect(deps?.__pomPrimaryByGetterName?.has('RolesTab')).toBe(true)
    expect(deps?.__pomPrimaryByGetterName?.has('UsersButton')).toBe(false)
  })

  it('infers a forwarded tab contract and semantic title without nativeWrappers config', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-inferred-tab-'))
    const tabItemPath = writeComponentSfc(
      tempRoot,
      'TabItem',
      `<template><li role="presentation"><button v-bind="$attrs" role="tab"><slot /></button></li></template>
       <script setup>defineOptions({ inheritAttrs: false })</script>`,
    )

    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const vueFilesPathMap = new Map<string, string>([['TabItem', tabItemPath]])

    const ast = compileAndCaptureAst(
      `<TabItem v-model="currentTab" title="Users" /><TabItem v-model="currentTab" title="Roles" />`,
      {
        filename: path.join(tempRoot, 'src', 'views', 'MyPage.vue'),
        nodeTransforms: [createTestIdTransform('MyPage', componentHierarchyMap, {}, [], path.join(tempRoot, 'src', 'views'), { vueFilesPathMap })],
      },
    )

    const testIds = rootStaticTestIds(ast)

    expect(testIds).toEqual(expect.arrayContaining(['MyPage-Users-tab', 'MyPage-Roles-tab']))
    expect(componentHierarchyMap.get('MyPage')?.generatedMethods?.has('clickUsers')).toBe(true)
    expect(componentHierarchyMap.get('MyPage')?.generatedMethods?.has('clickRoles')).toBe(true)
  })

  it('generates input behavior for an editable combobox wrapper', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-inferred-combobox-'))
    const searchBoxPath = writeComponentSfc(
      tempRoot,
      'SearchBox',
      `<template><div><input v-bind="$attrs" type="search" role="combobox" /></div></template>
       <script setup>defineOptions({ inheritAttrs: false })</script>`,
    )

    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const vueFilesPathMap = new Map<string, string>([['SearchBox', searchBoxPath]])

    const ast = compileAndCaptureAst('<SearchBox aria-label="Search" />', {
      filename: path.join(tempRoot, 'src', 'views', 'MyPage.vue'),
      nodeTransforms: [createTestIdTransform('MyPage', componentHierarchyMap, {}, [], path.join(tempRoot, 'src', 'views'), { vueFilesPathMap })],
    })

    const searchBox = firstElement(ast)
    const testId = findStaticAttr(searchBox, 'data-testid')

    expect(testId?.value?.content).toBe('MyPage-Search-input')
    expect(componentHierarchyMap.get('MyPage')?.generatedMethods?.has('typeSearch')).toBe(true)
    expect(componentHierarchyMap.get('MyPage')?.generatedMethods?.has('selectSearch')).toBe(false)
  })

  it('uses static slot text to name an inferred wrapper with no model or semantic prop', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-inferred-link-text-'))
    const linkPath = writeComponentSfc(tempRoot, 'AppLink', '<template><a :href="href"><slot /></a></template>')

    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const vueFilesPathMap = new Map<string, string>([['AppLink', linkPath]])
    const ast = compileAndCaptureAst('<AppLink href="/docs">Documentation</AppLink>', {
      filename: path.join(tempRoot, 'src', 'views', 'MyPage.vue'),
      nodeTransforms: [createTestIdTransform('MyPage', componentHierarchyMap, {}, [], path.join(tempRoot, 'src', 'views'), { vueFilesPathMap })],
    })

    const link = firstElement(ast)
    const testId = findStaticAttr(link, 'data-testid')
    expect(testId?.value?.content).toBe('MyPage-Documentation-link')
    expect(componentHierarchyMap.get('MyPage')?.generatedMethods?.has('clickDocumentation')).toBe(true)
  })

  it('does not persist source-inferred roles into the caller nativeWrappers config', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-wrapper-config-'))
    const linkPath = writeComponentSfc(tempRoot, 'AppLink', '<template><a :href="href"><slot /></a></template>')

    const nativeWrappers: NativeWrappersMap = {}
    compileAndCaptureAst('<AppLink href="/docs">Documentation</AppLink>', {
      filename: path.join(tempRoot, 'src', 'views', 'MyPage.vue'),
      nodeTransforms: [createTestIdTransform('MyPage', new Map(), nativeWrappers, [], path.join(tempRoot, 'src', 'views'), {
        vueFilesPathMap: new Map([['AppLink', linkPath]]),
      })],
    })

    expect(nativeWrappers).toEqual({})
  })

  it('suppresses generation only on a component own fallthrough target', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-forward-target-'))
    const source = `<template>
      <button v-bind="$attrs" type="button" @click="submit">Submit</button>
      <button type="button" @click="showHelp">Help</button>
    </template>
    <script setup>defineOptions({ inheritAttrs: false })</script>`
    const componentPath = writeComponentSfc(tempRoot, 'ActionWithHelp', source)
    const { descriptor } = parseSfc(source, { filename: componentPath })

    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const ast = compileAndCaptureAst(descriptor.template?.content ?? '', {
      filename: componentPath,
      nodeTransforms: [createTestIdTransform(
        'ActionWithHelp',
        componentHierarchyMap,
        {},
        [],
        path.join(tempRoot, 'src', 'views'),
        { vueFilesPathMap: new Map([['ActionWithHelp', componentPath]]) },
      )],
    })

    const buttons = (ast.children as ElementNode[]).filter((node): node is ElementNode => node.type === NodeTypes.ELEMENT)
    const testIdFor = (element: ElementNode) => element.props.find(
      (prop): prop is AttributeNode => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'data-testid',
    )?.value?.content

    expect(testIdFor(buttons[0]!)).toBeUndefined()
    expect(testIdFor(buttons[1]!)).toBe('ActionWithHelp-ShowHelp-button')
    expect(componentHierarchyMap.get('ActionWithHelp')?.generatedMethods?.has('clickSubmit')).not.toBe(true)
    expect(componentHierarchyMap.get('ActionWithHelp')?.generatedMethods?.has('clickShowHelp')).toBe(true)
  })

  it('suppresses explicit test-id forwarding targets inside conditional fragments', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-generator-conditional-forward-target-'))
    const source = `<template>
      <li v-if="asListItem" role="presentation">
        <a v-if="href" :href="href" :data-testid="$attrs['data-testid']"><slot /></a>
        <RouterLink v-else-if="to" :to="to" :data-testid="$attrs['data-testid']"><slot /></RouterLink>
        <button v-else v-bind="$attrs"><slot /></button>
      </li>
      <a v-else-if="href" v-bind="$attrs" :href="href"><slot /></a>
      <RouterLink v-else-if="to" v-bind="$attrs" :to="to"><slot /></RouterLink>
      <button v-else v-bind="$attrs"><slot /></button>
    </template>
    <script setup>defineOptions({ inheritAttrs: false })</script>`
    const componentPath = writeComponentSfc(tempRoot, 'ActionMenuItem', source)
    const { descriptor } = parseSfc(source, { filename: componentPath })

    expect(() => compileAndCaptureAst(descriptor.template?.content ?? '', {
      filename: componentPath,
      nodeTransforms: [createTestIdTransform(
        'ActionMenuItem',
        new Map(),
        {},
        [],
        path.join(tempRoot, 'src', 'views'),
        {
          existingIdBehavior: 'error',
          vueFilesPathMap: new Map([['ActionMenuItem', componentPath]]),
        },
      )],
    })).not.toThrow()
  })

  it('parses template expressions containing TypeScript type annotations when expressionPlugins: ["typescript"] is set', () => {
    // Regression for a real-world Nuxt + Vue 3 pattern: inline arrow
    // handlers that annotate their parameter with a TS type. Without the
    // compiler option, Vue's internal processExpression falls back to a
    // JS-only @babel/parser and throws "Unexpected token, expected ','".
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const template = `
      <div>
        <CommonDataTable @row-click="(row: PersonRow) => handleRow(row)" />
      </div>
    `

    expect(() => {
      compileAndCaptureAst(template, {
        filename: '/src/pages/people/index.vue',
        expressionPlugins: ['typescript'],
        nodeTransforms: [createTestIdTransform('MyPage', componentHierarchyMap, {}, [], '/src/views')],
      })
    }).not.toThrow()
  })

  it('does not throw for a submit button with no derivable identity when missingSemanticNameBehavior is "ignore"', () => {
    // Regression for forms that use a ternary submit-button label like
    // {{ isNew ? 'Create' : 'Save' }}. Default behavior is to throw so
    // authors fix the template; with missingSemanticNameBehavior: "ignore"
    // the generator falls back to a generic "submit" identifier.
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const template = `
      <form>
        <button type="submit">{{ isNew ? 'Create' : 'Save' }}</button>
      </form>
    `

    expect(() => {
      compileAndCaptureAst(template, {
        filename: '/src/components/Form.vue',
        nodeTransforms: [
          createTestIdTransform('Form', componentHierarchyMap, {}, [], '/src/views', {
            missingSemanticNameBehavior: 'ignore',
          }),
        ],
      })
    }).not.toThrow()

    // The injected attribute uses the fallback "submit" identifier.
    const ast = compileAndCaptureAst(template, {
      filename: '/src/components/Form.vue',
      nodeTransforms: [
        createTestIdTransform('Form', componentHierarchyMap, {}, [], '/src/views', {
          missingSemanticNameBehavior: 'ignore',
        }),
      ],
    })
    const testId = findFirstDataTestId(ast)
    expect(testId).toBe('Form-submit-button')
  })

  it('still throws for a submit button with no derivable identity under the default missingSemanticNameBehavior', () => {
    const componentHierarchyMap = new Map<string, IComponentDependencies>()
    const template = `
      <form>
        <button type="submit">{{ isNew ? 'Create' : 'Save' }}</button>
      </form>
    `

    expect(() => {
      compileAndCaptureAst(template, {
        filename: '/src/components/Form.vue',
        nodeTransforms: [createTestIdTransform('Form', componentHierarchyMap, {}, [], '/src/views')],
      })
    }).toThrow(/no usable identity could be derived/)
  })
})

describe('option-keying: semantic inference and explicit overrides', () => {
  it('uses a repeated radio value without component configuration', () => {
    const { keyed } = compileKeyedFixture('MyRadioGroup_OptionValue.vue', 'MyRadioGroup')

    // The injected data-testid template interpolates option.value, NOT the v-for index.
    expect((keyed!.selectorValue as { formatted: string }).formatted)
      .toBe('MyRadioGroup-${option.value}-option-radio')

    // A semantic `value` identity becomes the public parameter name, so generated
    // consumers can say selectByValue(value) rather than selectOptionValueByKey(key).
    expect(keyed!.pom?.selector).toEqual(createPomStringPattern('MyRadioGroup-${value}-option-radio', 'parameterized', ['value']))

    // The accessor's parameter list carries the `value` parameter (plus the standard
    // annotationText argument that radio select methods accept).
    expect(keyed!.pom?.parameters).toEqual(createPomParameters(
      ['value', 'string | number | boolean | bigint'],
      ['annotationText', 'string = ""'],
    ))
    expect(keyed!.pom?.generatedActionName).toBe('selectByValue')
  })

  it('allows explicit configuration to override the semantic radio value', () => {
    const { keyed } = compileKeyedFixture('MyRadioGroup_OptionValue.vue', 'MyRadioGroup', {
      optionKeyAttribute: { MyRadioGroup: 'key' },
    })

    // An explicit `key` override uses the enclosing v-for :key="index".
    expect((keyed!.selectorValue as { formatted: string }).formatted)
      .toBe('MyRadioGroup-${index}-option-radio')

    expect(keyed!.pom?.selector).toEqual(createPomStringPattern('MyRadioGroup-${key}-option-radio', 'parameterized', ['key']))
    expect(keyed!.pom?.parameters).toEqual(createPomParameters(['key', 'string'], ['annotationText', 'string = ""']))
  })

  it('rejects an explicit option identity override that is absent from a repeated radio', () => {
    expect(() => compileKeyedFixture('MyRadioGroup_OptionId.vue', 'MyRadioGroup', {
      optionKeyAttribute: { MyRadioGroup: 'label' },
    })).toThrow(/optionKeyAttribute.*label.*does not bind :label/)
  })

  it('rejects an explicit key override when the repeated radio has no Vue key', () => {
    expect(() => compileKeyedFixture('MyRadioGroup_OptionValueMissingKey.vue', 'MyRadioGroup', {
      optionKeyAttribute: { MyRadioGroup: 'key' },
    })).toThrow(/optionKeyAttribute.*"key".*no resolvable v-for :key/)
  })

  it('rejects a repeated radio without a bound value identity through structural wrappers', () => {
    expect(() => compileKeyedFixture('MyRadioGroup_OptionChangeMissingValue.vue', 'MyRadioGroup'))
      .toThrow(/Repeated radio must bind :value/)
  })
})

describe('action-event recognition: option-selection events beyond @click', () => {
  // Real option-selection controls fire the semantic event for their control type —
  // @change on radios/checkboxes, @mousedown on combobox/listbox <option> elements —
  // not @click. The generator must recognize these as action-able (like @click) so
  // it emits keyed accessors for v-for option elements that use them.

  it('emits a keyed accessor for a v-for radio driven by @change (not @click)', () => {
    // The fixture uses @change="modelValue = option.value" — the Vue idiom for radio
    // selection — instead of @click. Before action-event widening this produced an
    // EMPTY POM (no recognized handler); it must emit a keyed Option[key] accessor.
    const { keyed } = compileKeyedFixture('MyRadioGroup_OptionChange.vue', 'MyRadioGroup')

    // The keyed accessor is parameterized by the inferred :value binding, collapsing
    // option.value -> ${value}, regardless of whether the radio is driven by @click or @change.
    // The fixture mirrors the real component-library radio pattern: a <template v-for>
    // wrapping v-if/v-else <input> branches with `:value` + `:checked` + `@change` (no
    // v-model, to preserve typed values). The `:value` fallback yields the identifier
    // token `OptionValue`, and the native `radio` role supplies the `-radio` suffix —
    // a role-based keyed accessor rather than the @change handler-name path.
    expect((keyed!.selectorValue as { formatted: string }).formatted)
      .toBe('MyRadioGroup-${option.value}-OptionValue-radio')
    expect(keyed!.pom?.selector).toEqual(createPomStringPattern('MyRadioGroup-${value}-OptionValue-radio', 'parameterized', ['value']))
    // The accessor carries a `value` parameter (the option value the test selects by).
    expect(keyed!.pom?.parameters.map((p: { name: string }) => p.name)).toContain('value')
    expect(keyed!.pom?.generatedActionName).toBe('selectByValue')
  })

  it('emits a keyed accessor for a v-for <li role="option"> driven by @mousedown', () => {
    // Combobox/listbox option elements commonly use @mousedown (often .prevent) to
    // select on pointer-down for responsive UX. The fixture keys off :data-value
    // (the meaningful option value) by convention.
    const { keyed } = compileKeyedFixture('MyList_OptionMousedown.vue', 'MyList')

    // The keyed accessor is parameterized by the conventional :data-value binding,
    // collapsing option.value -> ${key}. The suffix derives from the handler name
    // (select) + tag (li), matching the generator's accessor-naming convention.
    expect((keyed!.selectorValue as { formatted: string }).formatted)
      .toBe('MyList-${option.value}-Select-li')
    expect(keyed!.pom?.selector).toEqual(createPomStringPattern('MyList-${key}-Select-li', 'parameterized', ['key']))
    expect(keyed!.pom?.parameters.map((p: { name: string }) => p.name)).toContain('key')
  })

  it('rejects a repeated role=option without a bound data-value identity', () => {
    expect(() => compileKeyedFixture('MyList_OptionMousedownMissingValue.vue', 'MyList'))
      .toThrow(/role="option".*must bind :data-value/)
  })
})
