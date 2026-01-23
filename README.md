# @immense/vue-pom-generator

Vite plugin for Vue 3 apps that:

- Injects stable `data-testid` attributes into interactive elements during Vue template compilation
- Generates Page Object Model (POM) classes for views/components (Playwright-focused by default)

Why you might want it:

- **Less brittle end-to-end tests**: selectors stay stable even if markup/layout shifts.
- **Less boilerplate**: POM generation keeps tests readable and centralized.
- **Not just testing**: a consistent attribute can also help analytics/user-tracking tooling and ad-hoc automation.

## Install (GitHub Packages)

This package is published to GitHub Packages.

- Package: `@immense/vue-pom-generator`
- Registry: `https://npm.pkg.github.com`

## Usage

Exported entrypoint: `createVuePomGeneratorPlugins()`.

## Configuration

`createVuePomGeneratorPlugins(options)` accepts a `VuePomGeneratorPluginOptions` object, grouped into:

- `injection`: how `data-testid` (or your chosen attribute) is derived/injected
- `generation`: how Page Object Models (POMs) and Playwright helpers are generated

The generator emits an aggregated output under `generation.outDir` (default `tests/playwright/generated`):

- `tests/playwright/generated/page-object-models.g.ts` (generated; do not edit)
- `tests/playwright/generated/index.ts` (generated stable barrel)

If `generation.playwright.fixtures` is enabled, it also emits:

- `tests/playwright/generated/fixtures.g.ts` (generated; do not edit)

### Vite config example

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { createVuePomGeneratorPlugins } from "@immense/vue-pom-generator";

export default defineConfig(() => {
	const vueOptions = {
		script: { defineModel: true, propsDestructure: true },
	};

	return {
		plugins: [
			...createVuePomGeneratorPlugins({
				vueOptions,
				logging: { verbosity: "info" },

				injection: {
					// Attribute to inject/read as the test id (default: data-testid)
					attribute: "data-testid",

					// Used to classify Vue files as "views" vs components (default: src/views)
					viewsDir: "src/views",

					// Optional: wrapper semantics for design-system components
					nativeWrappers: {
						ImmyButton: { role: "button" },
						ImmyInput: { role: "input" },
					},

					// Optional: opt specific components out of injection
					excludeComponents: ["ImmyButton"],

					// Optional: preserve/overwrite/error when an author already set the attribute
					existingIdBehavior: "preserve",
				},

				generation: {
					// Default: tests/playwright/generated
					outDir: "tests/playwright/generated",

					// Enable router introspection. When provided, router-aware POM helpers are generated.
					router: { entry: "src/router.ts" },

					playwright: {
						fixtures: true,
						customPoms: {
							// Default: tests/playwright/pom/custom
							dir: "tests/playwright/pom/custom",
							importAliases: { ImmyCheckBox: "CheckboxWidget" },
							attachments: [
								{
									className: "ConfirmationModal",
									propertyName: "confirmationModal",
									attachWhenUsesComponents: ["Page"],
								},
							],
						},
					},
				},
			}),
			vue(vueOptions),
		],
	};
});
```

Notes:

- **Injection is enabled by plugin inclusion** (there is no longer an `injection.enabled` flag).
- **Generation is enabled by default** and can be disabled via `generation: false`.
- **Router-aware POM helpers are enabled** when `generation.router.entry` is provided (the generator will introspect your router).

### `generation.router.entry: string`

Controls where router introspection loads your Vue Router definition from (used for `:to` analysis and navigation helper generation).

Resolution:

- relative paths are resolved relative to Vite's resolved `config.root`
- absolute paths are used as-is

This file must export a **default router factory function** (e.g. `export default makeRouter`).

### `generation.playwright.fixtures: boolean | string | { outDir?: string }`

When enabled, the generator emits a concrete, strongly typed Playwright fixture module so tests can do:

- `test("...", async ({ preferencesPage }) => { ... })`

Forms:

- `true`: enable with defaults
- `"path"`: enable and write under this directory (or file, if it ends in `.ts`/`.tsx`/`.mts`/`.cts`)
- `{ outDir }`: enable and write fixture outputs under a custom directory

Defaults:

- when `true`: writes `fixtures.g.ts` alongside generated POMs (under `generation.outDir`)

### Vite config example

- `nativeWrappers` describes common wrapper components (e.g. design-system buttons/inputs)
- `customPom` groups handwritten helper wiring and conditional attachments
- `testIdAttribute` lets you use a different attribute name (e.g. `data-qa`, `data-cy`)

### Notes for Playwright users

This package emits Playwright-oriented helpers (e.g. `page.getByTestId(...)`).

If you change Playwright's `testIdAttribute`, make sure the app actually renders the same attribute.

### Migration helper: `injection.existingIdBehavior`

When cleaning up a codebase that already has a mix of manually-authored test ids and generated ones:

- `"preserve"` (default): leave author-provided ids untouched
- `"overwrite"`: replace existing ids with generated ids
- `"error"`: throw when an existing id is detected (useful for incremental cleanup)

## Sequence diagram

See: [`sequence-diagram.md`](./sequence-diagram.md)
