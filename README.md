# @immense/vue-testid-injector

Vite/Vue plugin that:

- Injects `data-testid` attributes into interactive elements during Vue template compilation
- Generates Playwright-friendly Page Object Model (POM) classes for views/components

## Install (GitHub Packages)

This package is published to GitHub Packages.

- Package: `@immense/vue-testid-injector`
- Registry: `https://npm.pkg.github.com`

## Usage

Exported entrypoint: `createVueTestIdPlugins()` from `index.ts`.

> This repo is primarily consumed as a submodule by the main ImmyBot repo.

## Sequence diagram

See: [`sequence-diagram.md`](./sequence-diagram.md)
