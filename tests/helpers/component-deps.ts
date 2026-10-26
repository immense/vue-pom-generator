// Shared test factory for IComponentDependencies.
//
// Tests need a complete, type-correct dependencies object; most only care about
// one or two fields. Spread semantics: an explicit `undefined` override wins
// over a default, so a test can exercise an absent optional field.

import type { IComponentDependencies } from '../../utils'

export function makeComponentDependencies(
  overrides: Partial<IComponentDependencies> & Pick<IComponentDependencies, 'filePath'>,
): IComponentDependencies {
  return {
    childrenComponentSet: new Set(),
    usedComponentSet: new Set(),
    dataTestIdSet: new Set(),
    ...overrides,
  }
}
