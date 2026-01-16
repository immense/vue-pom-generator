# @immense/vue-testid-injector

Vite plugin for Vue 3 apps that:

- Injects stable `data-testid` attributes into interactive elements during Vue template compilation
- Generates Page Object Model (POM) classes for views/components (Playwright-focused by default)

Why you might want it:

- **Less brittle end-to-end tests**: selectors stay stable even if markup/layout shifts.
- **Less boilerplate**: POM generation keeps tests readable and centralized.
- **Not just testing**: a consistent attribute can also help analytics/user-tracking tooling and ad-hoc automation.

## Install (GitHub Packages)

This package is published to GitHub Packages.

- Package: `@immense/vue-testid-injector`
- Registry: `https://npm.pkg.github.com`

## Usage

Exported entrypoint: `createVueTestIdPlugins()`.

## Configuration

`createVueTestIdPlugins(options)` supports the following relevant options (partial list):

### `routerEntry?: string`

Controls where router introspection loads your Vue Router definition from.

- Default: `"src/router.ts"`
- Resolution: resolved relative to `projectRoot` unless you pass an absolute path

This file must export a **default router factory function** (e.g. `export default makeRouter`).

### `generatePlaywrightFixtures?: boolean | { outDir?: string }`

When enabled, the generator emits a concrete, strongly typed Playwright fixture module so tests can do:

- `test("...", async ({ preferencesPage }) => { ... })`

Forms:

- `true`: enable with defaults
- `{ outDir }`: enable and write fixture outputs under a custom directory

Defaults:

- `outDir`: `"tests/playwright/fixture"` (resolved relative to `projectRoot`)

Generated output:

- `testWithGeneratedPageObjects.g.ts` (intended to be re-exported by a stable non-generated wrapper like `testWithGeneratedPageObjects.ts`)

### Vite config example

- `nativeWrappers` describes common wrapper components (e.g. design-system buttons/inputs)
- `customPom` groups handwritten helper wiring and conditional attachments
- `testIdAttribute` lets you use a different attribute name (e.g. `data-qa`, `data-cy`)

### Notes for Playwright users

This package emits Playwright-oriented helpers (e.g. `page.getByTestId(...)`).

If you change Playwright's `testIdAttribute`, make sure the app actually renders the same attribute.

## Sequence diagram

See: [`sequence-diagram.md`](./sequence-diagram.md)
