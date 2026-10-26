// Shared IDataTestId fixture factory for class-generation tests.
//
// Most generation tests need one or two IDataTestId entries whose pom repeats
// the same selector pattern; this factory keeps only what each test varies.

import type { IDataTestId, NativeRole, PomPrimarySpec } from '../../utils'
import { createPomParameters, type PomParameterSpec } from '../../pom-params'
import { createPomStringPattern, type PomPatternKind } from '../../pom-patterns'

export interface MakeTestIdEntryOptions {
  /** The test-id pattern text, e.g. `MyComp-Save-button` or `items-check-${key}`. */
  selector: string
  patternKind?: PomPatternKind
  patternParams?: readonly string[]
  methodName?: string
  nativeRole?: NativeRole
  parameters?: Array<PomParameterSpec | readonly [string, string]>
  generatedActionName?: string
  generatedPropertyName?: string
  targetPageObjectModelClass?: string
}

export function makeTestIdEntry(options: MakeTestIdEntryOptions): IDataTestId {
  const pattern = createPomStringPattern(options.selector, options.patternKind ?? 'static', options.patternParams ?? [])
  const entry: IDataTestId = { selectorValue: pattern }

  if (options.targetPageObjectModelClass) {
    entry.targetPageObjectModelClass = options.targetPageObjectModelClass
  }

  if (options.methodName) {
    const pom: PomPrimarySpec = {
      nativeRole: options.nativeRole ?? 'button',
      methodName: options.methodName,
      selector: pattern,
      parameters: options.parameters ? createPomParameters(...options.parameters) : [],
    }
    if (options.generatedActionName) pom.generatedActionName = options.generatedActionName
    if (options.generatedPropertyName) pom.generatedPropertyName = options.generatedPropertyName
    entry.pom = pom
  }

  return entry
}
