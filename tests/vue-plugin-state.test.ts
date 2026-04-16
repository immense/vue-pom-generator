// @vitest-environment node
import path from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'
import type { Plugin } from 'vite'

import { createVuePluginWithTestIds } from '../plugin/vue-plugin'
import type { IComponentDependencies, NativeWrappersMap } from '../utils'

function createMetadataCollector(nativeWrappers: NativeWrappersMap = {}) {
  const componentHierarchyMap = new Map<string, IComponentDependencies>()
  const { metadataCollectorPlugin } = createVuePluginWithTestIds({
    existingIdBehavior: 'preserve',
    nameCollisionBehavior: 'error',
    nativeWrappers,
    elementMetadata: new Map(),
    semanticNameMap: new Map(),
    componentHierarchyMap,
    vueFilesPathMap: new Map(),
    excludedComponents: [],
    getViewsDirAbs: () => path.resolve(process.cwd(), 'src/views'),
    testIdAttribute: 'data-testid',
    loggerRef: {
      current: {
        info() {},
        debug() {},
        warn() {},
      },
    },
    getSourceDirs: () => ['.'],
    getWrapperSearchRoots: () => [],
    getProjectRoot: () => process.cwd(),
  })

  const plugin = metadataCollectorPlugin as Plugin
  if (typeof plugin.transform !== 'function') {
    throw new TypeError('Could not find metadata collector transform')
  }

  return {
    componentHierarchyMap,
    transform: plugin.transform as (this: object, code: string, id: string) => Promise<unknown>,
  }
}

function getPrimaryMethodNames(componentHierarchyMap: Map<string, IComponentDependencies>, componentName: string) {
  return Array.from(componentHierarchyMap.get(componentName)?.dataTestIdSet ?? [])
    .map(entry => entry.pom)
    .filter((pom): pom is NonNullable<typeof pom> => !!pom && pom.emitPrimary !== false)
    .map(pom => pom.methodName)
}

describe('metadata collector compile state', () => {
  it('replaces prior component members when the same file is recompiled', async () => {
    const { componentHierarchyMap, transform } = createMetadataCollector({
      NavItem: { role: 'button' },
    })
    const id = path.resolve(process.cwd(), 'Sidebar.vue')

    await transform.call({}, '<template><NavItem v-for="item in items" :key="item.id" :to="item.to" /></template>', id)
    expect(getPrimaryMethodNames(componentHierarchyMap, 'Sidebar')).toEqual(['ButtonByKey'])

    await transform.call({}, '<template><NavItem v-for="item in items" :key="item.id" :to="item.to">Value Button</NavItem></template>', id)
    expect(getPrimaryMethodNames(componentHierarchyMap, 'Sidebar')).toEqual(['ValueButtonByKey'])

    const generatedMethods = Array.from(componentHierarchyMap.get('Sidebar')?.generatedMethods?.keys() ?? [])
    expect(generatedMethods).toContain('clickValueButtonByKey')
    expect(generatedMethods).not.toContain('clickButtonByKey')
  })
})
