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

### Vite config example

- `nativeWrappers` describes common wrapper components (e.g. design-system buttons/inputs)
- `customPom` groups handwritten helper wiring and conditional attachments
- `testIdAttribute` lets you use a different attribute name (e.g. `data-qa`, `data-cy`)

### Notes for Playwright users

This package emits Playwright-oriented helpers (e.g. `page.getByTestId(...)`).

If you change Playwright's `testIdAttribute`, make sure the app actually renders the same attribute.

## Sequence diagram

See: [`sequence-diagram.md`](./sequence-diagram.md)
