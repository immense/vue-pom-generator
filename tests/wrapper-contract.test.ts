// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  analyzeWrapperContractFromSfc,
  resolveWrapperContractForTag,
} from '../wrapper-contract'

function writeComponent(root: string, name: string, source: string): string {
  const filePath = path.join(root, 'src', 'components', `${name}.vue`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, source)
  return filePath
}

describe('wrapper contract analysis', () => {
  it('uses the explicit ARIA role on the element receiving fallthrough attributes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-wrapper-tab-'))
    const filePath = writeComponent(root, 'TabItem', `
      <template>
        <li role="presentation">
          <button v-bind="$attrs" role="tab"><slot /></button>
        </li>
      </template>
      <script setup lang="ts">
      defineOptions({ inheritAttrs: false })
      </script>
    `)

    const contract = resolveWrapperContractForTag({
      tag: 'TabItem',
      vueFilesPathMap: new Map([['TabItem', filePath]]),
      wrapperSearchRoots: [],
      testIdAttribute: 'data-testid',
    })

    expect(contract?.role).toBe('tab')
    expect(contract?.forwardedTestIdTargetOffsets.size).toBe(1)
  })

  it('uses input interaction behavior for an editable combobox target', () => {
    const contract = analyzeWrapperContractFromSfc({
      filePath: '/src/components/SearchBox.vue',
      source: `
        <template>
          <div class="search-box">
            <input v-bind="$attrs" type="search" role="combobox" />
          </div>
        </template>
        <script setup>
        defineOptions({ inheritAttrs: false })
        </script>
      `,
      testIdAttribute: 'data-testid',
      resolveNestedContract: () => null,
    })

    expect(contract.role).toBe('input')
    expect(contract.targetRoles).toEqual(['input'])
  })

  it('does not classify an unrelated interactive descendant as the fallthrough target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-pom-wrapper-panel-'))
    const filePath = writeComponent(root, 'Panel', `
      <template>
        <div class="panel"><button type="button">Dismiss</button></div>
      </template>
    `)

    const contract = resolveWrapperContractForTag({
      tag: 'Panel',
      vueFilesPathMap: new Map([['Panel', filePath]]),
      wrapperSearchRoots: [],
      testIdAttribute: 'data-testid',
    })

    expect(contract?.role).toBeNull()
    expect(contract?.forwardedTestIdTargetOffsets.size).toBe(1)
  })

  it('recognizes a useAttrs alias forwarded to a native control', () => {
    const source = `
      <template><button v-bind="attrs"><slot /></button></template>
      <script setup lang="ts">
      import { useAttrs as getAttrs } from 'vue'
      defineOptions({ inheritAttrs: false })
      const attrs = getAttrs()
      </script>
    `
    const contract = analyzeWrapperContractFromSfc({
      filePath: '/src/components/AppButton.vue',
      source,
      testIdAttribute: 'data-testid',
      resolveNestedContract: () => null,
    })

    expect(contract.role).toBe('button')
    expect(contract.forwardedTestIdTargetOffsets.size).toBe(1)
    expect([...contract.forwardedTestIdTargetSfcOffsets]).toEqual(
      [...contract.forwardedTestIdTargetOffsets].map(offset => offset + source.indexOf('<button')),
    )
  })

  it('recognizes a top-level rest binding from useAttrs', () => {
    const contract = analyzeWrapperContractFromSfc({
      filePath: '/src/components/AppButton.vue',
      source: `
        <template><button v-bind="buttonAttrs"><slot /></button></template>
        <script setup>
        import { useAttrs } from 'vue'
        defineOptions({ inheritAttrs: false })
        const { class: rootClass, style: rootStyle, ...buttonAttrs } = useAttrs()
        </script>
      `,
      testIdAttribute: 'data-testid',
      resolveNestedContract: () => null,
    })

    expect(contract.role).toBe('button')
    expect(contract.forwardedTestIdTargetOffsets.size).toBe(1)
  })

  it('recognizes a helper that forwards every attribute except named layout attributes', () => {
    const contract = analyzeWrapperContractFromSfc({
      filePath: '/src/components/AppCheckbox.vue',
      source: `
        <template>
          <div>
            <input v-bind="inputAttrs()" type="checkbox" />
          </div>
        </template>
        <script setup lang="ts">
        import { useAttrs } from 'vue'
        defineOptions({ inheritAttrs: false })
        const attrs = useAttrs()
        function inputAttrs(): Record<string, unknown> {
          const rest: Record<string, unknown> = {}
          for (const key in attrs) {
            if (key !== 'class' && key !== 'style') rest[key] = attrs[key]
          }
          return rest
        }
        </script>
      `,
      testIdAttribute: 'data-testid',
      resolveNestedContract: () => null,
    })

    expect(contract.role).toBe('checkbox')
    expect(contract.forwardedTestIdTargetOffsets.size).toBe(1)
  })

  it('does not treat a helper as forwarding the configured test-id when it filters that key', () => {
    const contract = analyzeWrapperContractFromSfc({
      filePath: '/src/components/AppCheckbox.vue',
      source: `
        <template><input v-bind="inputAttrs()" type="checkbox" /></template>
        <script setup>
        import { useAttrs } from 'vue'
        defineOptions({ inheritAttrs: false })
        const attrs = useAttrs()
        function inputAttrs() {
          const rest = {}
          for (const key in attrs) {
            if (key !== 'data-qa') rest[key] = attrs[key]
          }
          return rest
        }
        </script>
      `,
      testIdAttribute: 'data-qa',
      resolveNestedContract: () => null,
    })

    expect(contract.role).toBeNull()
    expect(contract.forwardedTestIdTargetOffsets.size).toBe(0)
  })

  it('does not infer forwarding when a later object property replaces the configured test-id', () => {
    const contract = analyzeWrapperContractFromSfc({
      filePath: '/src/components/AppButton.vue',
      source: `
        <template><button v-bind="buttonAttrs"><slot /></button></template>
        <script setup>
        import { useAttrs } from 'vue'
        defineOptions({ inheritAttrs: false })
        const attrs = useAttrs()
        const buttonAttrs = { ...attrs, 'data-qa': undefined }
        </script>
      `,
      testIdAttribute: 'data-qa',
      resolveNestedContract: () => null,
    })

    expect(contract.role).toBeNull()
    expect(contract.forwardedTestIdTargetOffsets.size).toBe(0)
  })

  it('recognizes an explicit configured test-id forwarding binding', () => {
    const contract = analyzeWrapperContractFromSfc({
      filePath: '/src/components/AppLink.vue',
      source: `
        <template>
          <a href="/docs" :data-qa="$attrs['data-qa']">Docs</a>
          <span>Help</span>
        </template>
        <script setup>
        defineOptions({ inheritAttrs: false })
        </script>
      `,
      testIdAttribute: 'data-qa',
      resolveNestedContract: () => null,
    })

    expect(contract.role).toBe('link')
    expect(contract.forwardedTestIdTargetOffsets.size).toBe(1)
  })

  it('keeps polymorphic forwarding targets discoverable without inventing one role', () => {
    const contract = analyzeWrapperContractFromSfc({
      filePath: '/src/components/AppAction.vue',
      source: `
        <template>
          <a v-if="href" v-bind="$attrs" :href="href"><slot /></a>
          <button v-else v-bind="$attrs"><slot /></button>
        </template>
        <script setup>
        defineOptions({ inheritAttrs: false })
        </script>
      `,
      testIdAttribute: 'data-testid',
      resolveNestedContract: () => null,
    })

    expect(contract.role).toBeNull()
    expect(contract.forwardedTestIdTargetOffsets.size).toBe(2)
    expect(contract.targetRoles).toEqual(['link', 'button'])
  })
})
