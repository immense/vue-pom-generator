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

Exported entrypoint: `createVueTestIdPlugins()`.

## Configuration

`createVueTestIdPlugins(options)` accepts a `VuePomGeneratorPluginOptions` object, grouped into:

- `injection`: how `data-testid` (or your chosen attribute) is derived/injected
- `generation`: how Page Object Models (POMs) and Playwright helpers are generated

The generator emits an aggregated output under `outDir` (default `./pom`):

- `pom/index.g.ts` (generated; do not edit)
- `pom/index.ts` (stable barrel; safe to edit if you want additional exports)

### `generation.router.entry: string`

Controls where router introspection loads your Vue Router definition from (used for `:to` analysis and navigation helper generation).

Resolution:

- relative paths are resolved relative to `process.cwd()`
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

- `outDir`: `"tests/playwright/fixture"` (resolved relative to `process.cwd()`)

Generated output:

- `testWithGeneratedPageObjects.g.ts` (intended to be re-exported by a stable non-generated wrapper like `testWithGeneratedPageObjects.ts`)

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
